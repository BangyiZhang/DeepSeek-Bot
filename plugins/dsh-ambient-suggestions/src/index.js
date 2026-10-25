import z from '@deepseek-ai/schemastery';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { TYPERT_HOST } from './rpc.js';
import { predict } from './engine.js';

export const name = 'ambient-suggestions';
export const inject = ['typert', 'llm', 'sessionController', 'sessionProjections', 'agentDefaultModel'];
export const Config = z.object({
  model: z.string().default('').description('Prediction model as provider/model. Empty inherits the current session model.').volatile(),
  timeoutMs: z.number().min(1000).max(30000).default(8000).description('Prediction request deadline in milliseconds.').volatile()
});
const read = value => typeof value?.get === 'function' ? value.get() : value;

export class AmbientSuggestions extends TypertRemoteService {
  constructor(ctx, config) {
    super(ctx, 'ambientSuggestions');
    this.config = config;
    this.requests = new Map();
    ctx.typert.register(TYPERT_HOST);
    ctx.effect(() => () => {
      for (const request of this.requests.values()) request.abort();
      this.requests.clear();
    }, 'ambient inference cancellation');
  }
  async preferences(signal) {
    signal.throwIfAborted();
    const groups = [];
    for (const provider of this.ctx.llm.listProviders()) {
      signal.throwIfAborted();
      try {
        const models = await this.ctx.llm.listModels(provider.id);
        groups.push({ id: provider.id, label: provider.name ?? provider.id, models: models.map(model => ({ id: model.id, name: model.name ?? model.id })) });
      } catch { /* A provider without a usable catalog is omitted, never guessed. */ }
    }
    return { model: read(this.config.model) ?? '', groups };
  }
  async predict(request, signal) {
    signal.throwIfAborted();
    this.requests.get(request.sessionId)?.abort();
    const controller = new AbortController();
    this.requests.set(request.sessionId, controller);
    const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(read(this.config.timeoutMs) ?? 8000)]);
    try {
      try {
        return await predict(this.ctx, { model: read(this.config.model) ?? '', timeoutMs: read(this.config.timeoutMs) ?? 8000 }, request, combined);
      } catch (error) {
        if (combined.aborted) throw error;
        // Do not expose provider errors or conversation content over the auxiliary RPC.
        throw new Error(error?.code === 'AMBIENT_MODEL_UNAVAILABLE'
          ? 'The selected prediction model is unavailable. Choose an installed model in plugin settings.'
          : 'Prediction unavailable. The normal placeholder has been preserved.');
      }
    } finally {
      if (this.requests.get(request.sessionId) === controller) this.requests.delete(request.sessionId);
    }
  }
}
export function apply(ctx, config) { new AmbientSuggestions(ctx, config); }
