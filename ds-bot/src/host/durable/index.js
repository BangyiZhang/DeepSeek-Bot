// Pi owns these opt-in workflows; DSH remains the execution owner. Dedicated
// DSH Agent sessions keep ordinary Bot turns on their existing recovery path.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { install as installTools } from './tools.js'
import { TEAM_TOOLS } from '../constants.js'
import { matchesTaskInput, isExecutionContext } from './dsh.js'
import { captureBotContext } from './context.js'
import { taskStepTitle } from '../../shared/durable-steps.js'

const own = (object, key) => object != null && Object.hasOwn(object, key) ? object[key] : undefined
const taskReads = new Set(['recall', 'read_own_chat', 'read_browser', 'list_capabilities'])
const workerDenied = new Set([...TEAM_TOOLS.filter(name => !taskReads.has(name) && name !== 'ask_user'), 'create_goal', 'update_goal', 'get_goal', 'ask_user_question', 'run_code'])

function createRequest(body) {
  const { key, prompts, model, agentId } = body
  if (typeof key !== 'string' || key === '__proto__' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(key)) throw new Error('Invalid durable request key')
  if (!Array.isArray(prompts) || prompts.length < 1 || prompts.length > 20
    || prompts.some(prompt => typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32000)) {
    throw new Error('Supply 1 to 20 nonempty task stages of at most 32000 characters')
  }
  if (typeof model !== 'string' || !model || model.length > 512) throw new Error('Choose a model for this task')
  if (body.title !== undefined && (typeof body.title !== 'string' || body.title.length > 120)) throw new Error('A task title must be at most 120 characters')
  if (agentId !== undefined && (typeof agentId !== 'string' || !agentId)) throw new Error('Invalid DSH Agent')
  const title = body.title?.trim() || prompts[0].trim().split('\n')[0].slice(0, 80)
  return { key, title, prompts: [...prompts], model, ...(agentId === undefined ? {} : { agentId }) }
}

export function install(rt) {
  if (rt.ctx.tools?.register) installTools(rt)
  const enabled = () => typeof rt.state?.prefs?.durableTasks === 'boolean'
    ? rt.state.prefs.durableTasks : rt.config.durableTasks === true
  const { ctx } = rt
  // PTC presents a transport instead of the callable registry. Public scoped
  // lookup still resolves the real tools that transport is allowed to dispatch.
  const callableTools = agent => {
    if (typeof ctx.tools?.schemas !== 'function' || typeof ctx.tools?.get !== 'function') throw new Error('The Bot tool scope cannot be copied safely')
    const candidates = new Set([...ctx.tools.schemas(), ...ctx.tools.schemas(agent)].map(tool => tool.name))
    return [...candidates].filter(name => name !== 'run_code' && ctx.tools.get(name, agent) !== undefined)
  }
  let opening
  let runtime
  let notifier
  let stopping = false
  let failure
  let changes = Promise.resolve()
  const workerGuards = new WeakSet()
  const workerScopes = new Map()
  const taskWork = {}
  const closedWorkers = new Set()
  rt.durableQuestionContext = sessionId => Object.values(rt.state.questions ?? {}).filter(card => card.durable?.botId === rt.selfOf(sessionId))
    .map(card => `Durable task ${card.durable.key} is waiting for the user. Question id: ${card.id}\nQuestion: ${card.question}\nWhen the user answers this question, call answer_durable_task with this key, question_id and their answer. Do not create another task, resume without an answer, or do its work yourself. Unrelated messages and pause/cancel requests are not answers.`).join('\n')
  const workView = rt.workView
  if (workView) rt.workView = () => ({ ...taskWork, ...workView() })
  rt.durableOwnerOf = sessionId => {
    const metadata = workerScopes.get(sessionId)
    return metadata?.execution?.botManaged && rt.botOf(metadata.origin.botId) ? metadata.origin : undefined
  }
  rt.durableSessionsOf = botId => [...workerScopes].filter(([, metadata]) => metadata.execution?.botManaged && metadata.origin.botId === botId).map(([id]) => id)
  const fingerprint = bot => rt.capabilityFingerprint?.(bot) ?? ((bot.capabilities ?? []).length === 0
    ? { names: [], digest: createHash('sha256').update('[]').digest('hex') } : undefined)
  const scopeMatches = (bot, execution) => !execution.botManaged || JSON.stringify(fingerprint(bot)) === JSON.stringify(execution.capabilities)
  rt.durableCapabilityBot = sessionId => {
    const metadata = workerScopes.get(sessionId)
    const bot = metadata?.execution?.botManaged ? rt.botOf(metadata.origin.botId) : undefined
    return bot && !closedWorkers.has(sessionId) && scopeMatches(bot, metadata.execution) ? bot : undefined
  }
  const workerStops = new Set()
  const waitingWorkers = new Set()
  const scopeFailures = new Set()
  const rememberScope = metadata => {
    if (metadata?.execution && metadata.origin) for (const sessionId of metadata.sessions) workerScopes.set(sessionId, metadata)
  }
  const change = operation => {
    const result = changes.then(operation)
    changes = result.catch(() => {})
    return result
  }
  // The feature can be enabled after startup, so lifecycle mutations always share
  // the same admission gate even before the first workflow exists.
  rt.withDurableSessionChange = change
  const writeCheck = () => {
    if (stopping) throw new Error('Durable tasks are stopping')
    const reason = rt.readOnly()
    if (reason !== undefined) throw new Error(reason)
  }
  const open = async () => {
    if (!enabled()) throw new Error('Experimental durable tasks are disabled')
    writeCheck()
    opening ??= (async () => {
      await rt.load()
      writeCheck()
      const [{ openDurableRuntime }, { createDshExecutor }, { createDurableNotifier }] = await Promise.all([import('./runtime.js'), import('./dsh.js'), import('./notifications.js')])
      const directory = join(rt.home, 'durable')
      await mkdir(directory, { recursive: true })
      const dsh = createDshExecutor({
        ctx, canWrite: () => !stopping && rt.readOnly() === undefined,
        validateSession: sessionId => rt.durableOwnerOf(sessionId) !== undefined || rt.agentOf(sessionId) !== undefined,
      })
      // Inspection can also wake recovered inbox work, so both paths restore the
      // saved boundary before resolving the DSH execution.
      const scoped = (operation, observing = false) => async input => {
        const tasks = runtime ?? await opening
        const key = input.requestId.split(':')[0]
        const metadata = await tasks.getCreate(key)
        if (metadata?.execution) {
          rememberScope(metadata)
          try { await applyExecution(input.sessionId, metadata.execution, metadata.origin) }
          catch {
            scopeFailures.add(input.sessionId)
            if (observing) {
              const record = await dsh.inspect(input)
              if (record.status === 'completed') return record
            }
            return { status: 'uncertain', reason: 'scope_changed' }
          }
        }
        if (scopeFailures.has(input.sessionId)) return { status: 'uncertain', reason: 'scope_changed' }
        const record = await operation(input)
        return record?.result ? { ...record, result: rt.redactSecrets?.(record.result) ?? record.result } : record
      }
      const executor = { inspect: scoped(dsh.inspect, true), dispatch: scoped(dsh.dispatch), stop: input => {
        workerStops.add(input.sessionId)
        return dsh.stop(input)
      } }
      runtime = await openDurableRuntime({
        database: join(directory, 'tasks.sqlite'), executor,
        onReport: (_error, info) => { rt.warn('ds-bot: durable task report %s', info.type) },
      })
      for (const key of await runtime.list()) {
        const metadata = await runtime.getCreate(key)
        rememberScope(metadata)
        const record = await runtime.get(key)
        if (metadata?.cancelled || record?.abortRequested || record?.state.outcome?.status === 'aborted' || record?.cancellation?.status === 'stopped') {
          for (const sessionId of metadata?.sessions ?? []) workerStops.add(sessionId)
        }
      }
      notifier = createDurableNotifier({ rt, tasks: runtime })
      void runtime.list().then(async keys => {
        for (const key of keys) {
          const draft = await runtime.getCreate(key)
          if (stopping || !draft?.origin || draft.cancelled || draft.pauseRequested || await runtime.get(key)) continue
          await change(() => { writeCheck(); return create(runtime, { key }) })
        }
      }).catch(() => { if (!stopping) rt.warn('ds-bot: a durable chat task setup needs review') })
      return runtime
    })()
    return opening
  }
  const applyExecution = async (sessionId, execution, origin, resolved) => {
    writeCheck()
    const agent = resolved ?? await rt.resolveAgent(sessionId)
    if (rt.sessionFolder(agent.session) !== execution.cwd) throw new Error('The durable worker no longer has its original working folder; review the task')
    const presets = ctx.get?.('permissionPresets')
    if (!presets || execution.permission === null) throw new Error('The original permission preset cannot be restored for this durable worker')
    // Named presets may have been redefined after a Host restart.
    if (JSON.stringify(presets.resolve(execution.permission)) !== execution.permissionSpec) throw new Error('The original permission preset changed; review the task before continuing')
    const bot = rt.botOf(origin.botId)
    if (!bot) throw new Error('The originating Bot is no longer available')
    if (!scopeMatches(bot, execution) || (!execution.botManaged && (bot.capabilities ?? []).length > 0)) throw new Error('The originating Bot capabilities changed; review the task before continuing')
    if (execution.botManaged && execution.capabilities.names.length) {
      if (!rt.requireCapabilities) throw new Error('Bot capability mounting is unavailable')
      await rt.requireCapabilities(sessionId, agent)
    }
    const source = await rt.resolveAgent(rt.chatOf(bot.id))
    if (presets.current(source.session) !== execution.permission || rt.sessionFolder(source.session) !== execution.cwd) throw new Error('The originating Bot\'s execution scope changed; review the task before continuing')
    if (execution.botManaged && execution.capabilities.names.length) await rt.requireCapabilities(rt.chatOf(bot.id), source)
    if (typeof ctx.tools?.schemas !== 'function') throw new Error('The durable worker tool scope cannot be verified')
    const allowed = new Set(execution.allowedTools)
    const sourceTools = new Set(callableTools(source))
    if ([...allowed].some(name => !sourceTools.has(name))) throw new Error('The originating Bot\'s available tools changed; review the task before continuing')
    const visible = callableTools(agent)
    const deny = visible.filter(name => workerDenied.has(name) || (name === 'ask_user' && !allowed.has(name)) || (!execution.botManaged && (taskReads.has(name) || name === 'ask_user')))
    if (deny.length) {
      if (typeof agent.ctx?.tools?.restrict !== 'function') throw new Error('The durable worker tool scope could not be restricted')
      // An allow mask built from root schemas drops ancestor preset tools hidden
      // behind PTC. Deny team-only tools and guard the complete captured scope.
      agent.ctx.tools.restrict({ deny })
    }
    if (callableTools(agent).some(name => !allowed.has(name) || workerDenied.has(name))) throw new Error('Team tools could not be removed from this durable worker; retry its setup')
    if (!workerGuards.has(agent)) {
      if (typeof agent.ctx?.tools?.guard !== 'function') throw new Error('The durable worker tool boundary could not be enforced')
      // Local registrations are not covered by the global allow mask. A tool
      // added after setup must still stay inside the captured delegation.
      agent.ctx.tools.guard(exec => workerStops.has(sessionId) ? 'This durable task is stopping or cancelled; no new tools may run.'
        : waitingWorkers.has(sessionId) ? 'This task is waiting for the user; no further tools may run until the saved answer continues it.'
        : !rt.botOf(origin.botId) || !scopeMatches(rt.botOf(origin.botId), execution) ? 'The Bot task capability scope changed; review the task.'
        : exec.name !== 'run_code' && (!allowed.has(exec.name) || workerDenied.has(exec.name))
          ? 'This tool was not delegated to this durable task by its originating Bot.' : undefined)
      workerGuards.add(agent)
    }
    presets.set(agent.session, execution.permission)
    if (presets.current(agent.session) !== execution.permission) throw new Error('The durable worker permission could not be restored')
    await ctx.sessions.flush(agent.session)
  }
  const create = async (tasks, body, context = {}) => {
    if (Object.keys(body).length === 1 && typeof body.key === 'string') {
      const stored = await tasks.getCreate(body.key)
      if (!stored) throw new Error('Unknown prepared task')
      if (stored.cancelled) throw new Error('This durable task was cancelled; create a new task for new work')
      if (stored.pauseRequested) throw new Error('This task is paused; use resume_durable_task to continue it')
      body = { key: stored.key, title: stored.title, prompts: stored.prompts, model: stored.model,
        ...(stored.requestedAgentId == null ? {} : { agentId: stored.requestedAgentId }) }
      context = { ...(stored.origin ? { origin: stored.origin } : {}), ...(stored.execution ? { execution: stored.execution } : {}) }
    }
    const specification = { ...createRequest(body), ...context }
    const prior = await tasks.getCreate(specification.key)
    if (prior) {
      if (prior.cancelled) throw new Error('This durable task was cancelled; create a new task for new work')
      if (prior.pauseRequested) throw new Error('This task is paused; use resume_durable_task to continue it')
      await tasks.prepareCreate(specification)
      const existing = await tasks.get(specification.key)
      if (existing) return { taskId: existing.id, key: specification.key }
    }
    const models = await rt.catalog({ fresh: true })
    const model = models.find(entry => entry.ref === specification.model)
    if (!model || model.needsKey) throw new Error('Choose an available model with its credentials configured')
    if (specification.agentId !== undefined && !own(rt.state.agents, specification.agentId)) throw new Error('Unknown DSH Agent')
    let request = prior ?? await tasks.prepareCreate(specification)
    let agent = request.agentId ? own(rt.state.agents, request.agentId) : undefined
    let firstSession
    if (request.agentId && !agent) throw new Error('The prepared task\'s DSH Agent is unavailable; create a new task')
    if (!agent && !specification.execution?.botManaged) {
      agent = specification.agentId ? own(rt.state.agents, specification.agentId) : Object.values(rt.state.agents)[0]
      if (!agent) {
        agent = await rt.addAgent()
        firstSession = agent.sessions[0]
      }
      request = await tasks.updateCreateAllocation(specification.key, { agentId: agent.id })
    }
    for (let index = 0; index < specification.prompts.length; index += 1) {
      writeCheck()
      let sessionId = request.sessions[index]
      if (sessionId && !specification.execution?.botManaged && rt.agentOf(sessionId)?.id !== agent.id) throw new Error('A prepared task session is unavailable; create a new task')
      if (!sessionId) {
        if (specification.execution) {
          const made = await ctx.sessionController.create({ cwd: specification.execution.cwd, agentPreset: 'standard' })
          sessionId = made.sessionId
          if (!specification.execution.botManaged) await rt.adoptAgentSession(agent.id, sessionId)
        } else sessionId = index === 0 && firstSession ? firstSession : await rt.createAgentSession(agent.id)
        request = await tasks.updateCreateAllocation(specification.key, { index, sessionId })
      }
      rememberScope(request)
      if (specification.execution) await applyExecution(sessionId, specification.execution, specification.origin)
      const selected = await rt.selectSessionModel(sessionId, { provider: model.provider, model: model.id,
        ...(specification.execution?.effort === undefined ? {} : { reasoningEffort: specification.execution.effort }) })
      if (selected?.error || !selected?.selected) throw new Error('The task model could not be selected; retry this task')
      if (specification.execution?.botManaged) {
        const owner = rt.botOf(specification.origin.botId)
        await ctx.sessionTitle?.rename((await rt.resolveAgent(sessionId)).session, `${owner.name} · ${specification.title} · ${index + 1}`)
      } else await rt.renameAgentSession(agent.id, sessionId, `${specification.title} · ${index + 1}`)
    }
    writeCheck()
    const admission = await tasks.submit({
      key: specification.key,
      steps: specification.prompts.map((prompt, index) => ({ sessionId: request.sessions[index], prompt: specification.execution
        ? `${specification.execution.instructions}\n\n${specification.execution.context ?? ''}\n\nTask stage ${index + 1} of ${specification.prompts.length}:\n${prompt}` : prompt })),
    })
    return { ...admission, key: specification.key }
  }
  rt.durableEndpoint = async (endpoint, body = {}) => {
    await rt.load()
    if (endpoint === 'durable-state' && !enabled()) return { enabled: false, jobs: [] }
    if (endpoint === 'durable-state' && rt.readOnly() !== undefined) return { enabled: enabled(), readOnly: true, jobs: [] }
    const tasks = await open()
    if (endpoint === 'durable-create') {
      const saved = await tasks.getCreate(body?.key)
      if (saved) {
        if ((body.title !== undefined && body.title.trim() !== saved.title) || (body.model !== undefined && body.model !== saved.model) || (body.agentId !== undefined && body.agentId !== saved.requestedAgentId)) throw new Error('Durable request key already names a different task')
        if (body.prompts !== undefined && JSON.stringify(body.prompts.map(step => typeof step === 'string' ? step.trim() : step)) !== JSON.stringify(saved.prompts)) throw new Error('Durable request key already names a different task')
        if (body.botId !== undefined && body.botId !== saved.origin?.botId) throw new Error('Task belongs to a different Bot')
        return change(() => { writeCheck(); return create(tasks, { key: body.key }) })
      }
      if (body.agentId !== undefined) return change(() => { writeCheck(); return create(tasks, body) })
      const bot = rt.botOf(body.botId ?? rt.state.mainBotIds?.[0])
      if (!bot) throw new Error('Choose a Bot to own this task')
      return createBotTask({ title: body.title, steps: body.prompts }, { bot, sessionId: rt.chatOf(bot.id) }, { key: body.key, model: body.model })
    }
    if (endpoint === 'durable-submit') {
      return change(() => {
        writeCheck()
        if (!Array.isArray(body.steps) || body.steps.some(step => !step || rt.agentOf(step.sessionId) === undefined)) {
          throw new Error('Durable tasks require dedicated DSH Agent sessions; Bot and group chats are not supported yet')
        }
        return tasks.submit({ key: body.key, steps: body.steps })
      })
    }
    const keys = body.key === undefined ? await tasks.list() : [body.key]
    const jobs = []
    for (const key of keys) {
      const [record, metadata] = await Promise.all([tasks.get(key), tasks.getCreate(key)])
      const stageCount = metadata?.prompts.length ?? record?.input?.steps.length ?? 0
      const title = metadata?.title ?? key
      const sessions = metadata?.sessions ?? record?.input?.steps.map(step => step.sessionId) ?? []
      const steps = Array.from({ length: stageCount }, (_, index) => ({ title: taskStepTitle(rt.redactSecrets?.(metadata?.prompts[index] ?? '') ?? metadata?.prompts[index]) }))
      jobs.push({ key, title, stepCount: stageCount, steps, sessionIds: sessions, taskId: record?.id ?? null,
        ...(metadata?.origin ? { origin: metadata.origin, ownerName: rt.botOf(metadata.origin.botId)?.name ?? 'Unavailable Bot', botManaged: metadata.execution?.botManaged === true } : {}), ...(metadata?.notification ? { notification: metadata.notification } : {}),
        ...(record?.cancellation ? { cancellation: record.cancellation } : {}),
        ...(record?.question ? { question: record.question } : {}),
        pauseRequested: record?.pauseRequested ?? metadata?.pauseRequested === true,
        paused: record ? record.pauseRequested === true && record.state.status === 'waiting' && record.state.checkpoint?.paused === true : metadata?.pauseRequested === true,
        cancelling: record?.abortRequested === true && record.state.status !== 'terminal',
        state: record?.state ?? (metadata?.cancelled ? { status: 'terminal', outcome: { status: 'aborted', result: [] } }
          : { status: metadata ? 'preparing' : 'missing', reason: 'NEEDS_RECONCILIATION' }) })
    }
    let released = false
    for (const job of jobs) if (job.botManaged && job.state.status === 'terminal') for (const id of job.sessionIds) {
      if (!closedWorkers.has(id)) { closedWorkers.add(id); released = true }
    }
    if (released) void rt.scheduleCapabilitiesReconcile?.()
    if (body.key === undefined) for (const id of Object.keys(taskWork)) delete taskWork[id]
    for (const job of jobs) if (body.key === undefined && job.botManaged && job.state.status !== 'terminal' && !job.paused) {
      taskWork[job.origin.botId] = { tool: job.title, taskKey: job.key, durable: true }
    }
    return { enabled: true, ...(failure ? { error: failure } : {}), jobs }
  }
  rt.refreshDurableView = async () => { if (runtime && !stopping) await rt.durableEndpoint('durable-state') }

  rt.projectDurableQuestion = (key, metadata, record) => change(async () => {
    if (!metadata?.execution?.botManaged || !rt.state.questions) return
    writeCheck()
    const botId = metadata.origin.botId
    const bot = rt.botOf(botId)
    const sessionId = bot && rt.chatOf(botId)
    const question = record?.abortRequested ? undefined : record?.question
    let changed = false
    for (const [id, card] of Object.entries(rt.state.questions)) if (card.durable?.key === key && (id !== sessionId || card.id !== question?.id)) {
      delete rt.state.questions[id]; changed = true
    }
    if (question && sessionId && !rt.state.questions[sessionId]) {
      rt.state.questions[sessionId] = { id: question.id, question: question.question,
        detail: `${metadata.title}${question.detail ? ` · ${question.detail}` : ''}`, options: question.options,
        multiSelect: question.multiSelect, allowCustom: true, askedAt: question.askedAt, durable: { key, botId } }
      changed = true
    }
    if (changed) await rt.save()
  })
  rt.askDurableFromWorker = async (args, exec) => {
    const metadata = workerScopes.get(exec.agent?.id)
    if (!metadata?.execution?.botManaged) throw new Error('No Bot-managed task owns this worker')
    const tasks = await open()
    const sanitized = rt.redactSecrets ? JSON.parse(rt.redactSecrets(JSON.stringify(args))) : args
    const question = await change(() => { writeCheck(); return tasks.ask(metadata.key, { ...sanitized, sessionId: exec.agent.id, callId: exec.callId }) })
    waitingWorkers.add(exec.agent.id)
    exec.concludeTurn?.()
    await rt.projectDurableQuestion(metadata.key, metadata, await tasks.get(metadata.key))
    return `Question ${question.id} is saved in task ${metadata.key} and shown in your Bot chat. End this turn; the recorded user answer will continue this same task. Do not run more tools.`
  }
  rt.answerDurableQuestion = async (sessionId, key, id, answer) => {
    const tasks = await open()
    return change(async () => {
      writeCheck()
      const metadata = await tasks.getCreate(key)
      const botId = rt.selfOf(sessionId)
      if (!botId || metadata?.origin?.botId !== botId || rt.chatOf(botId) !== sessionId || rt.groupOwners.has(sessionId)) throw new Error('This question belongs to a different Bot chat')
      await tasks.answerQuestion(key, id, rt.redactSecrets?.(answer) ?? answer)
      const card = rt.state.questions?.[sessionId]
      if (card?.durable?.key === key && card.id === id) { delete rt.state.questions[sessionId]; await rt.save() }
      return { key, questionId: id, status: 'answer_saved', message: 'The answer is saved. The same task continues when its current turn is settled and any manual pause is released; completed stages will not be repeated.' }
    })
  }

  const chatCaller = exec => {
    const sessionId = exec?.agent?.id
    const bot = rt.botOf(rt.selfOf(sessionId))
    if (!bot || rt.chatOf(bot.id) !== sessionId || rt.groupOwners.has(sessionId)) throw new Error('Durable chat tools are available only in a Bot\'s own chat')
    return { bot, sessionId }
  }
  const belongsTo = (record, botId) => record?.origin?.botId === botId && record.origin.roomId === undefined
  rt.answerDurableFromBot = async (body, exec) => {
    await rt.load()
    const { sessionId } = chatCaller(exec)
    if (rt.live?.get(sessionId)?.info !== undefined) throw new Error('Only a direct user reply can answer a durable task question')
    return rt.answerDurableQuestion(sessionId, body.key, body.question_id, body.answer)
  }
  rt.durableStateForBot = async (body, exec) => {
    await rt.load()
    const { bot } = chatCaller(exec)
    const value = await rt.durableEndpoint('durable-state', body ?? {})
    const jobs = value.jobs.filter(job => belongsTo(job, bot.id))
    if (body?.key !== undefined && jobs.length === 0) throw new Error('No durable task with that key belongs to this Bot chat')
    return { ...value, jobs }
  }
  const createBotTask = async (body, { bot, sessionId }, { key, model: requestedModel } = {}) => {
    const tasks = await open()
    return change(async () => {
      writeCheck()
      if (key !== undefined && await tasks.getCreate(key)) {
        const saved = await tasks.getCreate(key)
        if (!belongsTo(saved, bot.id)) throw new Error('No durable task with that key belongs to this Bot chat')
        if ((body.title !== undefined && body.title.trim() !== saved.title)
          || (body.steps !== undefined && JSON.stringify(body.steps.map(step => step.trim())) !== JSON.stringify(saved.prompts))) throw new Error('A saved durable task cannot be changed while resuming it')
        const admitted = await create(tasks, { key })
        return { ...admitted, title: saved.title, status: 'started' }
      }
      await rt.ensureCapabilities?.(sessionId)
      const capabilities = fingerprint(bot)
      if (!capabilities) throw new Error('The Bot capability scope cannot be captured')
      if (capabilities.names.length) {
        if (!rt.requireCapabilities) throw new Error('Bot capability mounting is unavailable')
        await rt.requireCapabilities(sessionId)
      }
      // Tool execution can expose an Agent facade. Registry scope identity is the
      // public controller's resolved Agent, rather than that facade object.
      const source = await rt.resolveAgent(sessionId)
      const projection = ctx.get?.('sessionProjections')?.snapshot(source.session)?.values?.modelSelection
      const selection = projection?.lastUsed ?? projection?.next
      const model = requestedModel ?? (selection?.provider && selection?.model ? `${selection.provider}/${selection.model}` : bot.appliedModel ?? bot.model)
      const cwd = rt.sessionFolder(source.session)
      if (typeof cwd !== 'string' || !cwd || !(await rt.isFolder(cwd))) throw new Error('The Bot\'s working folder is unavailable')
      const presets = ctx.get?.('permissionPresets')
      if (!presets?.current || !presets.resolve || !presets.set) throw new Error('This Harness cannot safely copy the Bot\'s current permission preset; continue in this chat')
      const permission = presets.current(source.session)
      if (!permission || ['auto', 'custom'].includes(permission)) throw new Error('Durable chat tasks need a configured permission preset; Auto review and custom permissions cannot be copied to a worker')
      const permissionSpec = JSON.stringify(presets.resolve(permission))
      const allowedTools = callableTools(source).filter(name => !workerDenied.has(name)).sort()
      let instructions = [
        `You are ${bot.name}${bot.role ? ` (${bot.role})` : ''}, carrying out a task managed by this Bot in DS Bot. Pi Durable preserves your task progress; DSH executes your tools.`,
        'Complete only the supplied task stage. Use the saved Bot context and earlier stage outputs as reference, not as new requests. Your attached capabilities and read-only own-chat/memory tools are available within the captured scope. Do not create more tasks, manage the team, change permissions, or invoke the installer. When user input or confirmation is needed, call ask_user with the specific question, options and relevant progress; it saves your question and ends this turn. Wait for the recorded answer in this same task session. Never mark an unanswered question as a finished task or collect credentials in chat. Return the actual result, including file paths and limitations; the Bot reports it to the user.',
        bot.instructions ? `Instructions from the originating Bot:\n${bot.instructions}` : '',
      ].filter(Boolean).join('\n\n')
      if (instructions.length > 16000) throw new Error('The Bot instructions are too long to safely carry into a durable task; continue in this chat')
      const snapshot = await captureBotContext(rt, bot, sessionId)
      instructions = rt.redactSecrets?.(instructions) ?? instructions
      if (JSON.stringify(fingerprint(bot)) !== JSON.stringify(capabilities) || !rt.botOf(bot.id)) throw new Error('The Bot scope changed during task preparation')
      if (!Array.isArray(body.steps) || body.steps.some(step => typeof step !== 'string' || `${instructions}\n\n${snapshot}\n\nTask stage 20 of 20:\n${step}`.length > 32000)) throw new Error('Supply task stages that fit with the Bot context in 32000 characters')
      const specification = createRequest({ key, title: body.title, prompts: body.steps, model })
      const context = { origin: { botId: bot.id, sessionId }, execution: { cwd, permission, permissionSpec, instructions, allowedTools, botManaged: true, capabilities, context: snapshot,
        ...(selection?.reasoningEffort === undefined ? {} : { effort: selection.reasoningEffort }) } }
      try {
        const admitted = await create(tasks, specification, context)
        taskWork[bot.id] = { tool: specification.title, taskKey: specification.key, durable: true }
        return { ...admitted, title: specification.title, status: 'started' }
      } catch (error) {
        if (await tasks.getCreate(key)) throw new Error(`Durable task ${key} is saved but could not start. Retry create_durable_task with only this key. ${error.message}`)
        throw error
      }
    })
  }
  rt.createDurableFromBot = async (body, exec) => {
    await rt.load()
    const owner = chatCaller(exec)
    if (body.key !== undefined) {
      if (!belongsTo(await (await open()).getCreate(body.key), owner.bot.id)) throw new Error('No durable task with that key belongs to this Bot chat')
      return createBotTask(body, owner, { key: body.key })
    }
    if (rt.live?.get(owner.sessionId)?.info !== undefined) throw new Error('A background report or resumed turn cannot create a new durable task. Check existing tasks instead.')
    if (typeof exec.callId !== 'string' || !exec.callId) throw new Error('A stable tool call identity is required to create a durable task')
    const key = `chat-${createHash('sha256').update(JSON.stringify([owner.bot.id, owner.sessionId, exec.callId])).digest('hex').slice(0, 40)}`
    return createBotTask(body, owner, { key })
  }
  const controlFromBot = async (action, body, exec) => {
    await rt.load()
    const { bot, sessionId } = chatCaller(exec)
    if (rt.live?.get(sessionId)?.info !== undefined) {
      let userJoined = false
      if (rt.eventsBackwards) for await (const event of rt.eventsBackwards(sessionId, AbortSignal.timeout(10000))) {
        if (event.type === 'turn/start') break
        if (event.type === 'user/message' && event.data?.source?.kind === 'user') { userJoined = true; break }
      }
      if (!userJoined) throw new Error('Only a direct user request in this Bot chat can control a durable task')
    }
    const tasks = await open()
    return change(async () => {
      writeCheck()
      const view = await rt.durableStateForBot({}, exec)
      const unfinished = view.jobs.filter(job => job.state.status !== 'terminal' && !job.cancelling)
      const preferred = action === 'resume' ? unfinished.filter(job => job.pauseRequested)
        : action === 'pause' ? unfinished.filter(job => !job.pauseRequested) : view.jobs.filter(job => job.state.status !== 'terminal')
      const candidates = body.key === undefined ? preferred.length ? preferred : action === 'cancel' ? view.jobs.filter(job => job.state.outcome?.status === 'failed'
        && job.cancellation?.status !== 'stopped') : action === 'pause' ? unfinished : [] : view.jobs.filter(job => job.key === body.key)
      if (!candidates.length) {
        if (body.key !== undefined) throw new Error('No durable task with that key belongs to this Bot chat')
        return { status: 'none', message: action === 'resume' ? 'No paused durable task in this Bot chat' : 'No unfinished durable task in this Bot chat' }
      }
      if (candidates.length !== 1) return { status: 'choose_task', tasks: candidates.map(job => ({ key: job.key, title: job.title })),
        message: 'Ask the user which task; do not control every task or guess.' }
      const target = candidates[0]
      if (!belongsTo(target, bot.id)) throw new Error('No durable task with that key belongs to this Bot chat')
      if (action === 'cancel') {
        if (target.state.outcome?.status !== 'completed') for (const id of target.sessionIds) workerStops.add(id)
        await tasks.cancel(target.key)
      } else {
        await tasks[action](target.key)
        if (action === 'resume' && target.state.status === 'preparing') await create(tasks, { key: target.key })
      }
      const job = (await rt.durableStateForBot({ key: target.key }, exec)).jobs[0]
      const outcome = job.state.outcome
      return { key: job.key, title: job.title, status: job.cancellation?.status === 'stopped' || outcome?.status === 'aborted' ? 'cancelled'
        : job.cancelling ? 'cancelling' : outcome?.status === 'completed' ? 'completed' : outcome ? 'needs_review'
          : job.paused ? 'paused' : job.pauseRequested ? 'pausing' : 'running',
      message: action === 'cancel' ? 'Report only confirmed status. Cancelling is not cancelled; completed external actions are not rolled back.'
        : 'Pause waits for the current admitted step to finish and save. Paused work keeps its saved steps across restart; resume continues the same task without replaying completed steps. Do not promise an immediate freeze of a running tool.' }
    })
  }
  rt.cancelDurableFromBot = (body, exec) => controlFromBot('cancel', body, exec)
  rt.pauseDurableFromBot = (body, exec) => controlFromBot('pause', body, exec)
  rt.resumeDurableFromBot = (body, exec) => controlFromBot('resume', body, exec)
  rt.assertBotDurableAvailable = async botId => {
    if (!enabled()) return
    const tasks = await open()
    const blocked = await tasks.blockingSessions()
    if (rt.durableSessionsOf(botId).some(id => blocked.has(id))) throw new Error('This Bot has unfinished durable tasks or tasks that need reconciliation; stop or review them first')
  }
  rt.assertDurableSessionAvailable = async sessionId => {
    await rt.load()
    if (!enabled()) return
    const tasks = await open()
    if ((await tasks.blockingSessions()).has(sessionId)) throw new Error('This session has unfinished durable work or needs reconciliation')
  }
  if (typeof ctx.on === 'function') ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    await rt.load()
    if (!enabled()) return next()
    // Recovered inbox work may start without another Pi dispatch. Restore its
    // process-local restrictions before DSH admits any model or tool step.
    try {
      await open()
      const metadata = workerScopes.get(agent.id)
      if (!metadata) return next()
      if (signal?.aborted || scopeFailures.has(agent.id) || workerStops.has(agent.id)) return { kind: 'reject' }
      const record = await runtime.get(metadata.key)
      if (metadata.execution.botManaged) {
        const index = metadata.sessions.indexOf(agent.id)
        if (!record || record.state.status === 'terminal' || record.state.checkpoint?.step !== index) return { kind: 'reject' }
        if (record.question) return { kind: 'reject' }
        waitingWorkers.delete(agent.id)
        const decision = await next()
        if (decision.kind !== 'enter') return decision
        if ((decision.messages ?? []).some(message => !matchesTaskInput(message, runtime.inputFor(record)) && !isExecutionContext(message))) return { kind: 'reject' }
        if (record.pauseRequested && record.state.checkpoint?.paused) return { kind: 'reject' }
        await applyExecution(agent.id, metadata.execution, metadata.origin, agent)
        return decision
      }
      if (record?.pauseRequested && (record.state.checkpoint?.paused || record.input.steps[record.state.checkpoint?.step]?.sessionId !== agent.id)) return { kind: 'reject' }
      await applyExecution(agent.id, metadata.execution, metadata.origin, agent)
    } catch {
      scopeFailures.add(agent.id)
      rt.warn('ds-bot: durable worker scope could not be restored')
      return { kind: 'reject' }
    }
    return next()
  }, { prepend: true })
  if (typeof ctx.on === 'function') ctx.on('agent/created', async ({ agent }) => {
    await rt.load()
    if (!enabled() || rt.selfOf?.(agent.id) !== undefined || rt.agentOf(agent.id) !== undefined) return
    await open()
    const metadata = workerScopes.get(agent.id)
    if (!metadata?.execution?.botManaged) return
    const record = await runtime.get(metadata.key)
    if (record?.state.status === 'terminal') {
      closedWorkers.add(agent.id)
      const known = new Set(callableTools(agent))
      agent.ctx.tools.restrict({ deny: TEAM_TOOLS.filter(name => known.has(name)) })
      agent.ctx.tools.guard(() => 'This Bot task phase is finished; send new work to its Bot chat')
      return
    }
    await applyExecution(agent.id, metadata.execution, metadata.origin, agent)
  })
  let closing
  rt.stopDurableTasks = () => closing ??= (async () => {
    stopping = true
    await opening?.catch(() => undefined)
    await changes.catch(() => {})
    await notifier?.close()
    await runtime?.close()
  })()
  ctx.effect(() => {
    void rt.load().then(() => enabled() && rt.readOnly() === undefined ? open() : undefined).catch(() => {
      if (stopping) return
      failure = 'Durable tasks could not start; inspect the Host diagnostics before retrying'
      rt.warn('ds-bot: durable tasks could not start')
    })
    return rt.stopDurableTasks
  }, 'ds-bot: durable tasks')
}
