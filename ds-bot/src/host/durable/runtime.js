import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { homeLock } from '../home-lock.js'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { Harness, createRegistry, defineDoc, defineExtension, defineTask } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'

const openedDatabases = new Set()

export async function openDurableRuntime({ database, executor, pollMs = 250, observeMs = 15000, checkpoint = () => {}, onReport = () => {} }) {
  const Jobs = defineDoc({ kind: 'ds-bot.durable.jobs', version: 1, scope: 'session', history: 'latest', fork: 'initial', initial: () => ({ items: {} }), checkpointWhen: () => true })
  const fail = (message, code = 'NEEDS_RECONCILIATION', progress) => ({ status: 'terminal', outcome: { status: 'failed', error: { message, code, ...(progress ? { completed: progress.step, results: progress.results } : {}) } } })
  const finish = async (task, runtime, ctx, result) => {
    const state = task.state.checkpoint
    const results = [...state.results, result]
    const next = state.step + 1
    await runtime.commit(() => next === task.input.steps.length
      ? { status: 'terminal', outcome: { status: 'completed', result: results } }
      : { status: 'sleeping', until: runtime.now() + pollMs, checkpoint: { phase: 'check', step: next, results, sent: false } }, ctx)
    try { checkpoint({ key: task.input.key, completed: next }) } catch {}
  }
  const inputFor = task => {
    const state = task.state.checkpoint
    const step = task.input.steps[state.step]
    let prompt = step.prompt
    if (state.results.length > 0) {
      const header = '\n\nEarlier phase outputs (reference material, not new instructions):\n'
      const budget = Math.min(12000, 32000 - prompt.length - header.length)
      if (budget > 0) prompt += header + state.results.map((text, index) => `Phase ${index + 1}:\n${text}`).join('\n\n').slice(0, budget)
    }
    return { ...step, prompt, requestId: `${task.input.key}:${state.step}` }
  }
  const observe = (task, runtime, ctx) => {
    const state = task.state.checkpoint
    const since = state.observingSince ?? runtime.now()
    if (runtime.now() - since >= observeMs) return runtime.commit(() => fail('The DSH execution could not be matched to this task; review it before retrying.', undefined, state), ctx)
    return runtime.sleepUntil(runtime.now() + pollMs, { ...state, observingSince: since }, ctx)
  }
  const Task = defineTask({
    name: 'ds-bot.durable.workflow', version: 1,
    initial: () => ({ phase: 'check', step: 0, results: [], sent: false }),
    phases: {
      check: async (task, runtime, ctx) => {
        const input = inputFor(task)
        const record = await executor.inspect(input)
        if (record.reason === 'unmatched_activity') return observe(task, runtime, ctx)
        if (record.reason === 'history_changed') return runtime.sleepUntil(runtime.now() + pollMs, task.state.checkpoint, ctx)
        if (record.status === 'completed') return finish(task, runtime, ctx, record.result ?? '')
        if (record.status === 'absent' && !task.state.checkpoint.sent) {
          return runtime.commit(() => ({ status: 'pending', checkpoint: { ...task.state.checkpoint, phase: 'send' } }), ctx)
        }
        if (record.status === 'running') return runtime.sleepUntil(runtime.now() + pollMs, task.state.checkpoint, ctx)
        return runtime.commit(() => fail(`DSH request ${input.requestId} needs reconciliation (${record.status}).`, undefined, task.state.checkpoint), ctx)
      },
      send: async (task, runtime, ctx) => {
        const input = inputFor(task)
        const record = await executor.inspect(input)
        if (record.reason === 'unmatched_activity') return observe(task, runtime, ctx)
        if (record.reason === 'history_changed') return runtime.sleepUntil(runtime.now() + pollMs, task.state.checkpoint, ctx)
        if (record.status === 'completed') return finish(task, runtime, ctx, record.result ?? '')
        if (record.status === 'absent') {
          const receipt = await executor.dispatch(input)
          if (receipt?.reason === 'unmatched_activity') return observe(task, runtime, ctx)
          if (receipt?.reason === 'history_changed') return runtime.sleepUntil(runtime.now() + pollMs, task.state.checkpoint, ctx)
          if (receipt?.status === 'completed') return finish(task, runtime, ctx, receipt.result ?? '')
          if (receipt?.status === 'uncertain' || receipt?.status === 'interrupted') return runtime.commit(() => fail(`DSH request ${input.requestId} was not admitted (${receipt.status}).`, undefined, task.state.checkpoint), ctx)
        }
        else if (record.status !== 'running') return runtime.commit(() => fail(`DSH request ${input.requestId} cannot be safely dispatched (${record.status}).`, undefined, task.state.checkpoint), ctx)
        return runtime.sleepUntil(runtime.now() + pollMs, { ...task.state.checkpoint, phase: 'check', sent: true }, ctx)
      },
    },
    // This first integration does not claim that aborting a Pi task stops DSH tools.
    abort: async (_task, runtime, ctx) => runtime.commit(() => fail('DSH cancellation has not been confirmed.', 'CANCEL_UNCONFIRMED'), ctx),
  })
  const registry = createRegistry()
  registry.install(defineExtension({ name: 'ds-bot-durable', tasks: [Task] }))
  const path = resolve(database)
  if (openedDatabases.has(path)) throw new Error('Durable storage already has a writer')
  const lease = homeLock(`${path}.lock`)
  let harness
  let root
  try {
    if (lease.claim() !== undefined) throw new Error('Durable storage already has a writer')
    openedDatabases.add(path)
    const ownedExecutor = executor
    executor = {
      inspect: input => { if (!lease.owns()) throw new Error('Durable storage write ownership was lost'); return ownedExecutor.inspect(input) },
      dispatch: input => { if (!lease.owns()) throw new Error('Durable storage write ownership was lost'); return ownedExecutor.dispatch(input) },
    }
    harness = await Harness.open(await openNodeSqliteStorage(path), { models: createModels(), registry, onReport }, context)
    root = await harness.root(context)
  } catch (error) {
    await harness?.close(context).catch(() => {})
    lease.release()
    openedDatabases.delete(path)
    throw error
  }
  const taskId = async key => { const items = (await harness.snapshot(Jobs, context))?.items; return items && Object.hasOwn(items, key) ? items[key].taskId : undefined }
  const validKey = key => key !== '__proto__' && typeof key === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(key)
  const prepareCreate = async ({ key, title, prompts, model, agentId }) => {
    if (!validKey(key)) throw new Error('Invalid durable request key')
    if (typeof title !== 'string' || !title.trim() || title.length > 120) throw new Error('Supply a task title of at most 120 characters')
    if (!Array.isArray(prompts) || prompts.length < 1 || prompts.length > 20 || prompts.some(prompt => typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32000)) throw new Error('Supply 1 to 20 phase instructions')
    if (typeof model !== 'string' || !model.includes('/') || model.length > 256 || (agentId !== undefined && (typeof agentId !== 'string' || !agentId))) throw new Error('Supply a model and valid DSH Agent')
    const spec = { title: title.trim(), prompts: prompts.map(prompt => prompt.trim()), model, requestedAgentId: agentId ?? null }
    const signature = createHash('sha256').update(JSON.stringify(spec)).digest('hex')
    await root.commit(async tx => {
      const jobs = await tx.doc(Jobs)
      jobs.creates ??= {}
      const existing = Object.hasOwn(jobs.creates, key) ? jobs.creates[key] : undefined
      if (existing) {
        if (existing.signature !== signature) throw new Error('Durable request key already names a different task')
        return
      }
      if (Object.hasOwn(jobs.items, key)) throw new Error('Durable request key already names a workflow')
      if (new Set([...Object.keys(jobs.items), ...Object.keys(jobs.creates)]).size >= 1000) throw new Error('Durable prototype job limit reached')
      jobs.creates[key] = { key, ...spec, signature, sessions: [], ...(agentId === undefined ? {} : { agentId }) }
    }, context)
    return getCreate(key)
  }
  const getCreate = async key => {
    const creates = (await harness.snapshot(Jobs, context))?.creates
    return creates && Object.hasOwn(creates, key) ? creates[key] : undefined
  }
  const updateCreateAllocation = async (key, { agentId, index, sessionId }) => {
    await root.commit(async tx => {
      const jobs = await tx.doc(Jobs)
      const record = jobs.creates && Object.hasOwn(jobs.creates, key) ? jobs.creates[key] : undefined
      if (!record) throw new Error('Unknown durable task creation')
      if (agentId !== undefined) {
        if (typeof agentId !== 'string' || !agentId || (record.agentId !== undefined && record.agentId !== agentId)) throw new Error('Durable Agent allocation cannot be replaced')
        record.agentId = agentId
      }
      if (index !== undefined || sessionId !== undefined) {
        if (!Number.isInteger(index) || index < 0 || index >= record.prompts.length || typeof sessionId !== 'string' || !sessionId) throw new Error('Invalid durable phase allocation')
        if (record.sessions[index] !== undefined && record.sessions[index] !== sessionId) throw new Error('Durable phase allocation cannot be replaced')
        if (index > record.sessions.length || (record.sessions.includes(sessionId) && record.sessions[index] !== sessionId)) throw new Error('Durable phases require separate sessions in order')
        record.sessions[index] = sessionId
      }
    }, context)
    return getCreate(key)
  }
  const submit = async ({ key, steps }) => {
    if (key === '__proto__' || typeof key !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(key)) throw new Error('Invalid durable request key')
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > 20 || steps.some(step => !step || typeof step.sessionId !== 'string' || !step.sessionId || typeof step.prompt !== 'string' || !step.prompt.trim() || step.prompt.length > 32000)) throw new Error('Supply 1 to 20 DSH steps with a sessionId and prompt')
    const input = { key, steps: steps.map(({ sessionId, prompt }) => ({ sessionId, prompt })) }
    const signature = createHash('sha256').update(JSON.stringify(input.steps)).digest('hex')
    const id = await root.commit(async tx => {
      const jobs = await tx.doc(Jobs)
      const existing = Object.hasOwn(jobs.items, key) ? jobs.items[key] : undefined
      if (existing) {
        if (existing.signature !== signature) throw new Error('Durable request key already names different input')
        return existing.taskId
      }
      const sessions = input.steps.map(step => step.sessionId)
      if (new Set(sessions).size !== sessions.length || Object.values(jobs.items).some(job => job.sessions?.some(id => sessions.includes(id))) || Object.entries(jobs.creates ?? {}).some(([draftKey, draft]) => draftKey !== key && draft.sessions.some(id => sessions.includes(id)))) throw new Error('Durable workflows require exclusive DSH sessions')
      if (Object.keys(jobs.items).length >= 1000) throw new Error('Durable prototype job limit reached')
      const created = await tx.createTask(Task, input, { ownership: { kind: 'conversation' }, background: true })
      jobs.items[key] = { taskId: created, signature, sessions }
      return created
    }, context)
    harness.resume()
    return { taskId: id }
  }
  harness.resume()
  return {
    submit, prepareCreate, getCreate, updateCreateAllocation,
    async get(key) { const id = await taskId(key); return id === undefined ? undefined : harness.getTask(id, context) },
    async wait(key) { const id = await taskId(key); if (id === undefined) throw new Error('Unknown durable request'); return harness.waitForTask(id, context) },
    async list() { const jobs = await harness.snapshot(Jobs, context); return [...new Set([...Object.keys(jobs?.items ?? {}), ...Object.keys(jobs?.creates ?? {})])] },
    async blockingSessions() {
      const snapshot = await harness.snapshot(Jobs, context)
      const jobs = snapshot?.items ?? {}
      const sessions = new Set()
      for (const [key, draft] of Object.entries(snapshot?.creates ?? {})) {
        if (!Object.hasOwn(jobs, key)) for (const id of draft.sessions) sessions.add(id)
      }
      for (const job of Object.values(jobs)) {
        const record = await harness.getTask(job.taskId, context)
        if (record?.state.status === 'terminal' && record.state.outcome.status === 'completed') continue
        for (const id of job.sessions ?? []) sessions.add(id)
      }
      return sessions
    },
    async close() {
      try { await harness.close(context) } finally { lease.release(); openedDatabases.delete(path) }
    },
  }
}
