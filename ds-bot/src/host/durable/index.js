// Pi owns these opt-in workflows; DSH remains the execution owner. Dedicated
// DSH Agent sessions keep ordinary Bot turns on their existing recovery path.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const own = (object, key) => object != null && Object.hasOwn(object, key) ? object[key] : undefined

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
  const enabled = () => typeof rt.state?.prefs?.durableTasks === 'boolean'
    ? rt.state.prefs.durableTasks : rt.config.durableTasks === true
  const { ctx } = rt
  let opening
  let runtime
  let stopping = false
  let failure
  let changes = Promise.resolve()
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
      const [{ openDurableRuntime }, { createDshExecutor }] = await Promise.all([import('./runtime.js'), import('./dsh.js')])
      const directory = join(rt.home, 'durable')
      await mkdir(directory, { recursive: true })
      const executor = createDshExecutor({
        ctx, canWrite: () => !stopping && rt.readOnly() === undefined,
        validateSession: sessionId => rt.agentOf(sessionId) !== undefined,
      })
      runtime = await openDurableRuntime({
        database: join(directory, 'tasks.sqlite'), executor,
        onReport: (_error, info) => { rt.warn('ds-bot: durable task report %s', info.type) },
      })
      return runtime
    })()
    return opening
  }
  const create = async (tasks, body) => {
    if (Object.keys(body).length === 1 && typeof body.key === 'string') {
      const stored = await tasks.getCreate(body.key)
      if (!stored) throw new Error('Unknown prepared task')
      body = { key: stored.key, title: stored.title, prompts: stored.prompts, model: stored.model,
        ...(stored.requestedAgentId == null ? {} : { agentId: stored.requestedAgentId }) }
    }
    const specification = createRequest(body)
    const prior = await tasks.getCreate(specification.key)
    if (prior) {
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
    if (!agent) {
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
      if (sessionId && rt.agentOf(sessionId)?.id !== agent.id) throw new Error('A prepared task session is unavailable; create a new task')
      if (!sessionId) {
        sessionId = index === 0 && firstSession ? firstSession : await rt.createAgentSession(agent.id)
        request = await tasks.updateCreateAllocation(specification.key, { index, sessionId })
      }
      const selected = await rt.selectSessionModel(sessionId, { provider: model.provider, model: model.id })
      if (selected?.error || !selected?.selected) throw new Error('The task model could not be selected; retry this task')
      await rt.renameAgentSession(agent.id, sessionId, `${specification.title} · ${index + 1}`)
    }
    writeCheck()
    const admission = await tasks.submit({
      key: specification.key,
      steps: specification.prompts.map((prompt, index) => ({ sessionId: request.sessions[index], prompt })),
    })
    return { ...admission, key: specification.key }
  }
  rt.durableEndpoint = async (endpoint, body = {}) => {
    await rt.load()
    if (endpoint === 'durable-state' && !enabled()) return { enabled: false, jobs: [] }
    if (endpoint === 'durable-state' && rt.readOnly() !== undefined) return { enabled: enabled(), readOnly: true, jobs: [] }
    const tasks = await open()
    if (endpoint === 'durable-create') return change(() => { writeCheck(); return create(tasks, body) })
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
      jobs.push({ key, title, stepCount: stageCount, sessionIds: sessions, taskId: record?.id ?? null,
        state: record?.state ?? { status: metadata ? 'preparing' : 'missing', reason: 'NEEDS_RECONCILIATION' } })
    }
    return { enabled: true, ...(failure ? { error: failure } : {}), jobs }
  }
  rt.assertDurableSessionAvailable = async sessionId => {
    await rt.load()
    if (!enabled()) return
    const tasks = await open()
    if ((await tasks.blockingSessions()).has(sessionId)) throw new Error('This session has unfinished durable work or needs reconciliation')
  }
  ctx.effect(() => {
    void rt.load().then(() => enabled() && rt.readOnly() === undefined ? open() : undefined).catch(() => {
      if (stopping) return
      failure = 'Durable tasks could not start; inspect the Host diagnostics before retrying'
      rt.warn('ds-bot: durable tasks could not start')
    })
    return async () => {
      stopping = true
      await opening?.catch(() => undefined)
      await changes.catch(() => {})
      await runtime?.close()
    }
  }, 'ds-bot: durable tasks')
}
