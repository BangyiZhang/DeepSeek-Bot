import { predictionMessages, cleanPrediction } from './prediction.js';

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Empty means inherit. Model IDs may contain slashes; the first slash separates the provider. */
export function parseModelSelection(value = '') {
  const ref = String(value ?? '').trim();
  if (!ref) return undefined;
  const slash = ref.indexOf('/');
  if (slash < 1 || slash === ref.length - 1) {
    throw failure('AMBIENT_MODEL_INVALID', 'Choose a complete provider/model reference, or leave it empty to inherit.');
  }
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

function inheritedSelection(ctx, session) {
  const projected = ctx.sessionProjections.stateOf(session, 'modelSelection');
  if (projected?.pending) return { ...projected.pending };
  const header = session.requestHeader();
  if (header) {
    const { provider, model, reasoningEffort } = header.config;
    return {
      provider,
      model,
      ...(reasoningEffort === undefined || header.adapterDefaults?.reasoningEffort === true ? {} : { reasoningEffort })
    };
  }
  const selection = ctx.agentDefaultModel.currentSelection();
  return { ...selection };
}

function currentTurns(ctx, session, turnKey) {
  const state = ctx.sessionProjections.stateOf(session, 'turnOutline');
  if (!state || !Array.isArray(state.turns)) throw failure('AMBIENT_HISTORY_UNAVAILABLE', 'The host turn outline is unavailable.');
  const latest = state.turns.at(-1);
  if (!latest || !latest.response?.trim() || `${latest.turn}:${latest.seq}` !== turnKey) {
    throw failure('AMBIENT_STALE', 'The conversation changed before prediction completed.');
  }
  return state.turns.slice(-2).map(({ prompt, response }) => ({ prompt, response }));
}

/**
 * Bind verified host LLM primitives, optionally supplied by tests or the host bundle.
 * The returned function accepts plain config values and a sessionId/turnKey request.
 * Browser-provided conversation text is never used.
 */
export function createPredictionEngine(dependencies = {}) {
  let primitives;
  return async function predict(ctx, config = {}, request, signal) {
    signal?.throwIfAborted();
    if (typeof request?.sessionId !== 'string' || typeof request?.turnKey !== 'string') {
      throw failure('AMBIENT_REQUEST_INVALID', 'A Session identity and completed turn key are required.');
    }
    const timeoutMs = Number.isFinite(config.timeoutMs) ? Math.max(1, Math.min(30000, config.timeoutMs)) : 8000;
    const timeout = AbortSignal.timeout(timeoutMs);
    const callSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    // Racing also bounds this caller when a provider ignores its AbortSignal.
    let abort;
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(callSignal.reason);
      if (callSignal.aborted) abort();
      else callSignal.addEventListener('abort', abort, { once: true });
    });
    const operation = async () => {
      const found = await ctx.sessionController.resolveAgent(request.sessionId);
      callSignal.throwIfAborted();
      if ('error' in found) throw found.error;
      const { agent } = found;
      const { session } = agent;
      if (agent.status === 'running') throw failure('AMBIENT_STALE', 'The conversation is running.');
      const turns = currentTurns(ctx, session, request.turnKey);
      const selection = parseModelSelection(config.model) ?? inheritedSelection(ctx, session);
      if (!ctx.llm.listProviders().some(provider => provider.id === selection.provider)) {
        throw failure('AMBIENT_MODEL_UNAVAILABLE', `The selected model route ${selection.provider}/${selection.model} has no installed LLM adapter. Choose an available prediction model in plugin settings.`);
      }
      primitives ??= dependencies.BlockAssembler && dependencies.createUserMessage
        ? Promise.resolve(dependencies)
        : import('@deepseek-ai/dsh-llm');
      const { BlockAssembler, createUserMessage } = await primitives;
      callSignal.throwIfAborted();
      const prepared = predictionMessages(turns, request.language);
      const call = await ctx.llm.prepareCall({ ...selection, maxTokens: 96 }, callSignal);
      callSignal.throwIfAborted();
      const assembler = new BlockAssembler();
      for await (const chunk of call.stream({
        ...call.config,
        system: prepared.system,
        messages: [createUserMessage({
          content: [{ type: 'text', text: `Recent conversation (JSON data):\n${JSON.stringify(prepared.recent)}` }],
          source: { kind: 'dsh-ambient-suggestions' }
        })],
        sessionId: session.id,
        purpose: 'ambient-suggestions',
        signal: callSignal
      })) {
        callSignal.throwIfAborted();
        assembler.push(chunk);
      }
      callSignal.throwIfAborted();
      const finish = assembler.finish;
      if (finish.kind === 'error' || finish.kind === 'aborted') throw failure(finish.failure.code, finish.failure.message);
      if (finish.kind !== 'stop' && finish.kind !== 'max-tokens') throw failure('AMBIENT_OUTPUT_INVALID', `Prediction ended with ${finish.kind}.`);
      const blocks = assembler.blocks();
      if (blocks.some(block => block.type === 'tool-call')) throw failure('AMBIENT_OUTPUT_INVALID', 'Prediction attempted a tool call.');
      if (agent.status === 'running') throw failure('AMBIENT_STALE', 'The conversation is running.');
      currentTurns(ctx, session, request.turnKey);
      const text = cleanPrediction(blocks.filter(block => block.type === 'text').map(block => block.text).join(' '));
      if (!text) throw failure('AMBIENT_OUTPUT_EMPTY', 'The selected model returned no prediction text.');
      return text;
    };
    try {
      return await Promise.race([operation(), cancelled]);
    } finally {
      callSignal.removeEventListener('abort', abort);
    }
  };
}

export const predict = createPredictionEngine();
