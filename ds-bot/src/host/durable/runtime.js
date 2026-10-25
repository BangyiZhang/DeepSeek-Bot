import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { homeLock } from '../home-lock.js'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { Harness, createRegistry, defineDoc, defineExtension, defineTask } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'

const openedDatabases = new Set()
const objectWith = (value, fields) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => fields.includes(key))
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256

export function validateChatContext(origin, execution) {
  if (origin === undefined && execution === undefined) return {}
  if (!objectWith(origin, ['botId', 'sessionId', 'roomId']) || !identifier(origin.botId) || !identifier(origin.sessionId)
    || (origin.roomId !== undefined && !identifier(origin.roomId))) throw new Error('Invalid durable task origin')
  if (!objectWith(execution, ['cwd', 'permission', 'permissionSpec', 'instructions', 'allowedTools', 'effort'])
    || typeof execution.cwd !== 'string' || !isAbsolute(execution.cwd) || execution.cwd.length > 4096
    || (execution.permission !== null && (typeof execution.permission !== 'string' || !execution.permission || execution.permission.length > 128))
    || typeof execution.permissionSpec !== 'string' || execution.permissionSpec.length > 4096
    || typeof execution.instructions !== 'string' || execution.instructions.length > 16000
    || !Array.isArray(execution.allowedTools) || execution.allowedTools.length > 1024
    || execution.allowedTools.some(name => typeof name !== 'string' || !name || name.length > 256)
    || new Set(execution.allowedTools).size !== execution.allowedTools.length
    || (execution.effort !== undefined && (typeof execution.effort !== 'string' || !execution.effort || execution.effort.length > 128))) {
    throw new Error('Invalid durable execution context')
  }
  return {
    origin: { botId: origin.botId, sessionId: origin.sessionId, ...(origin.roomId === undefined ? {} : { roomId: origin.roomId }) },
    execution: { cwd: execution.cwd, permission: execution.permission, permissionSpec: execution.permissionSpec, instructions: execution.instructions,
      allowedTools: [...execution.allowedTools],
      ...(execution.effort === undefined ? {} : { effort: execution.effort }) },
  }
}

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
  const stage = execute => async (task, runtime, ctx) => {
    try { return await execute(task, runtime, ctx) } catch (error) {
      const message = error?.code === 'DURABLE_SCOPE_CHANGED' && typeof error.message === 'string'
        ? error.message.slice(0, 500) : 'DSH execution could not be safely confirmed; review this task before continuing.'
      return runtime.commit(() => fail(message, undefined, task.state.checkpoint), ctx)
    }
  }
  const failureReason = (record, fallback) => record.reason === 'scope_changed'
    ? 'The original working folder, permission preset, or available tools changed; review this task before continuing.' : fallback
  // A waiting workflow owns a durable gate. Resuming aborts only this gate;
  // completed DSH work is never cancelled or replayed to implement a pause.
  const Pause = defineTask({
    name: 'ds-bot.durable.pause', version: 1,
    initial: () => ({ phase: 'hold' }),
    phases: { hold: (task, runtime, ctx) => runtime.sleepUntil(runtime.now() + 365 * 86400000, task.state.checkpoint, ctx) },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })
  const pauseRequested = async task => (await harness.snapshot(Jobs, context))?.items?.[task.input.key]?.pauseRequested === true
  const park = (task, runtime, ctx) => runtime.commit(async tx => {
    const jobs = await tx.doc(Jobs)
    const job = jobs.items[task.input.key]
    const checkpoint = { ...task.state.checkpoint, phase: 'check', paused: false }
    if (!job.pauseRequested) return { status: 'pending', checkpoint }
    const gate = await tx.createTask(Pause, {}, { ownership: { kind: 'task', taskId: task.id } })
    job.pauseGate = gate
    return { status: 'waiting', checkpoint: { ...checkpoint, paused: true }, on: [gate], policy: 'allSettled' }
  }, ctx)
  const Task = defineTask({
    name: 'ds-bot.durable.workflow', version: 1,
    initial: () => ({ phase: 'check', step: 0, results: [], sent: false }),
    phases: {
      check: stage(async (task, runtime, ctx) => {
        if (task.state.checkpoint.paused && !await pauseRequested(task)) {
          return runtime.commit(() => ({ status: 'pending', checkpoint: { ...task.state.checkpoint, paused: false } }), ctx)
        }
        const input = inputFor(task)
        const record = await executor.inspect(input)
        if (record.reason === 'unmatched_activity') return observe(task, runtime, ctx)
        if (record.reason === 'history_changed') return runtime.sleepUntil(runtime.now() + pollMs, task.state.checkpoint, ctx)
        if (record.status === 'completed') return finish(task, runtime, ctx, record.result ?? '')
        if (record.status === 'absent' && !task.state.checkpoint.sent) {
          if (await pauseRequested(task)) return park(task, runtime, ctx)
          return runtime.commit(() => ({ status: 'pending', checkpoint: { ...task.state.checkpoint, phase: 'send' } }), ctx)
        }
        if (record.status === 'running') return runtime.sleepUntil(runtime.now() + pollMs, task.state.checkpoint, ctx)
        return runtime.commit(() => fail(failureReason(record, `DSH request ${input.requestId} needs reconciliation (${record.status}).`), undefined, task.state.checkpoint), ctx)
      }),
      send: stage(async (task, runtime, ctx) => {
        const input = inputFor(task)
        const record = await executor.inspect(input)
        if (record.reason === 'unmatched_activity') return observe(task, runtime, ctx)
        if (record.reason === 'history_changed') return runtime.sleepUntil(runtime.now() + pollMs, task.state.checkpoint, ctx)
        if (record.status === 'completed') return finish(task, runtime, ctx, record.result ?? '')
        if (record.status === 'absent') {
          if (await pauseRequested(task)) return park(task, runtime, ctx)
          const receipt = await executor.dispatch(input)
          if (receipt?.reason === 'unmatched_activity') return observe(task, runtime, ctx)
          if (receipt?.reason === 'history_changed') return runtime.sleepUntil(runtime.now() + pollMs, task.state.checkpoint, ctx)
          if (receipt?.status === 'completed') return finish(task, runtime, ctx, receipt.result ?? '')
          if (receipt?.status === 'uncertain' || receipt?.status === 'interrupted') return runtime.commit(() => fail(failureReason(receipt, `DSH request ${input.requestId} was not admitted (${receipt.status}).`), undefined, task.state.checkpoint), ctx)
        }
        else if (record.status !== 'running') return runtime.commit(() => fail(failureReason(record, `DSH request ${input.requestId} cannot be safely dispatched (${record.status}).`), undefined, task.state.checkpoint), ctx)
        return runtime.sleepUntil(runtime.now() + pollMs, { ...task.state.checkpoint, phase: 'check', sent: true }, ctx)
      }),
    },
    abort: async (task, runtime, ctx) => {
      const progress = task.state.checkpoint
      let stopped
      try { stopped = await executor.stop?.(inputFor(task)) } catch {}
      if (stopped?.status !== 'stopped') return runtime.commit(() => fail('Stopping DSH work could not be confirmed. Review the work chat before repeating any action.', 'CANCEL_UNCONFIRMED', progress), ctx)
      const results = [...progress.results, ...(stopped.result === undefined ? [] : [stopped.result])]
      return runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted', reason: 'Cancelled by user', result: results } }), ctx)
    },
  })
  const registry = createRegistry()
  registry.install(defineExtension({ name: 'ds-bot-durable', tasks: [Task, Pause] }))
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
      stop: input => { if (!lease.owns()) throw new Error('Durable storage write ownership was lost'); return ownedExecutor.stop?.(input) },
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
  const prepareCreate = async ({ key, title, prompts, model, agentId, origin, execution }) => {
    if (!validKey(key)) throw new Error('Invalid durable request key')
    if (typeof title !== 'string' || !title.trim() || title.length > 120) throw new Error('Supply a task title of at most 120 characters')
    if (!Array.isArray(prompts) || prompts.length < 1 || prompts.length > 20 || prompts.some(prompt => typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32000)) throw new Error('Supply 1 to 20 phase instructions')
    if (typeof model !== 'string' || !model.includes('/') || model.length > 256 || (agentId !== undefined && (typeof agentId !== 'string' || !agentId))) throw new Error('Supply a model and valid DSH Agent')
    const spec = { title: title.trim(), prompts: prompts.map(prompt => prompt.trim()), model, requestedAgentId: agentId ?? null,
      ...validateChatContext(origin, execution) }
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
  // The receipt is committed before DSH admission. A restart reconciles this exact
  // target even if the Bot has moved on to a fresh conversation part meanwhile.
  const beginNotification = async (key, { sessionId, exchangeId }) => {
    if (!validKey(key) || !identifier(sessionId) || !identifier(exchangeId)) throw new Error('Invalid durable notification receipt')
    return root.commit(async tx => {
      const jobs = await tx.doc(Jobs)
      const record = jobs.creates && Object.hasOwn(jobs.creates, key) ? jobs.creates[key] : undefined
      if (!record?.origin || !Object.hasOwn(jobs.items, key)) throw new Error('No chat task to notify')
      if (record.notification) return { started: false, notification: { ...record.notification } }
      record.notification = { status: 'attempting', sessionId, exchangeId }
      return { started: true, notification: { ...record.notification } }
    }, context)
  }
  const settleNotification = async (key, { status, exchangeId }) => {
    if (!['queued', 'delivered', 'needs_reconciliation', 'unavailable'].includes(status)) throw new Error('Invalid durable notification status')
    return root.commit(async tx => {
      const jobs = await tx.doc(Jobs)
      const record = jobs.creates && Object.hasOwn(jobs.creates, key) ? jobs.creates[key] : undefined
      const notification = record?.notification
      if (!notification || notification.exchangeId !== exchangeId) throw new Error('Unknown durable notification receipt')
      if (notification.status === 'delivered' && status !== 'delivered') throw new Error('A delivered durable notification cannot be reopened')
      notification.status = status
      return { ...notification }
    }, context)
  }
  const submit = async ({ key, steps }) => {
    if (key === '__proto__' || typeof key !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(key)) throw new Error('Invalid durable request key')
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > 20 || steps.some(step => !step || typeof step.sessionId !== 'string' || !step.sessionId || typeof step.prompt !== 'string' || !step.prompt.trim() || step.prompt.length > 32000)) throw new Error('Supply 1 to 20 DSH steps with a sessionId and prompt')
    const input = { key, steps: steps.map(({ sessionId, prompt }) => ({ sessionId, prompt })) }
    const signature = createHash('sha256').update(JSON.stringify(input.steps)).digest('hex')
    const id = await root.commit(async tx => {
      const jobs = await tx.doc(Jobs)
      if (jobs.creates?.[key]?.cancelled) throw new Error('This durable task was cancelled; create a new task for new work')
      const existing = Object.hasOwn(jobs.items, key) ? jobs.items[key] : undefined
      if (existing) {
        if (existing.signature !== signature) throw new Error('Durable request key already names different input')
        return existing.taskId
      }
      const sessions = input.steps.map(step => step.sessionId)
      if (new Set(sessions).size !== sessions.length || Object.values(jobs.items).some(job => job.sessions?.some(id => sessions.includes(id))) || Object.entries(jobs.creates ?? {}).some(([draftKey, draft]) => draftKey !== key && draft.sessions.some(id => sessions.includes(id)))) throw new Error('Durable workflows require exclusive DSH sessions')
      if (Object.keys(jobs.items).length >= 1000) throw new Error('Durable prototype job limit reached')
      const created = await tx.createTask(Task, input, { ownership: { kind: 'conversation' }, background: true })
      jobs.items[key] = { taskId: created, signature, sessions, ...(jobs.creates?.[key]?.pauseRequested ? { pauseRequested: true } : {}) }
      return created
    }, context)
    harness.resume()
    return { taskId: id }
  }
  const cancel = async key => {
    if (!validKey(key)) throw new Error('Invalid durable request key')
    const id = await taskId(key)
    if (id !== undefined) {
      const record = await harness.getTask(id, context)
      if ((await harness.snapshot(Jobs, context))?.items?.[key]?.cancellation?.status === 'stopped') return
      if (record.state.status === 'terminal' && !['completed', 'aborted'].includes(record.state.outcome.status)) {
        const progress = record.state.outcome.error ?? {}
        const index = Math.min(progress.completed ?? 0, record.input.steps.length - 1)
        let stopped
        try { stopped = await executor.stop?.({ ...record.input.steps[index], requestId: `${key}:${index}` }) } catch {}
        await root.commit(async tx => {
          const jobs = await tx.doc(Jobs)
          jobs.items[key].cancellation = { status: stopped?.status === 'stopped' ? 'stopped' : 'needs_reconciliation', results: progress.results ?? [] }
        }, context)
        return
      }
      await harness.abortTask(id, context)
      harness.resume()
      return
    }
    await root.commit(async tx => {
      const jobs = await tx.doc(Jobs)
      const draft = jobs.creates && Object.hasOwn(jobs.creates, key) ? jobs.creates[key] : undefined
      if (!draft) throw new Error('Unknown durable task')
      draft.cancelled = true
    }, context)
  }
  const setPaused = async (key, paused) => {
    if (!validKey(key)) throw new Error('Invalid durable request key')
    const gate = await root.commit(async tx => {
      const jobs = await tx.doc(Jobs)
      const job = Object.hasOwn(jobs.items, key) ? jobs.items[key] : jobs.creates?.[key]
      if (!job) throw new Error('Unknown durable task')
      if (job.cancelled) throw new Error('A cancelled task cannot be paused or resumed')
      if (job.taskId !== undefined) {
        const record = await tx.task(job.taskId)
        if (record.abortRequested || record.state.status === 'terminal') throw new Error('Only unfinished tasks can be paused or resumed; cancelled or failed work cannot be restarted')
      }
      job.pauseRequested = paused
      return paused ? undefined : job.pauseGate
    }, context)
    if (gate !== undefined) await harness.abortTask(gate, context)
    harness.resume()
  }
  // A crash can fall between clearing the request and releasing its gate.
  // Repair that release before scheduling, using only Pi's public task API.
  for (const job of Object.values((await harness.snapshot(Jobs, context))?.items ?? {})) {
    if (job.pauseGate !== undefined && !job.pauseRequested) await harness.abortTask(job.pauseGate, context)
  }
  harness.resume()
  return {
    submit, cancel, pause: key => setPaused(key, true), resume: key => setPaused(key, false), prepareCreate, getCreate, updateCreateAllocation, beginNotification, settleNotification,
    async getNotification(key) { return (await getCreate(key))?.notification },
    async get(key) {
      const id = await taskId(key)
      if (id === undefined) return undefined
      const record = await harness.getTask(id, context)
      const job = (await harness.snapshot(Jobs, context))?.items?.[key]
      return { ...record, ...(job?.cancellation ? { cancellation: job.cancellation } : {}), pauseRequested: job?.pauseRequested === true }
    },
    async wait(key) { const id = await taskId(key); if (id === undefined) throw new Error('Unknown durable request'); return harness.waitForTask(id, context) },
    async list() { const jobs = await harness.snapshot(Jobs, context); return [...new Set([...Object.keys(jobs?.items ?? {}), ...Object.keys(jobs?.creates ?? {})])] },
    async blockingSessions() {
      const snapshot = await harness.snapshot(Jobs, context)
      const jobs = snapshot?.items ?? {}
      const sessions = new Set()
      for (const [key, draft] of Object.entries(snapshot?.creates ?? {})) {
        if (!Object.hasOwn(jobs, key) && !draft.cancelled) for (const id of draft.sessions) sessions.add(id)
      }
      for (const job of Object.values(jobs)) {
        if (job.cancellation?.status === 'stopped') continue
        const record = await harness.getTask(job.taskId, context)
        if (record?.state.status === 'terminal' && ['completed', 'aborted'].includes(record.state.outcome.status)) continue
        for (const id of job.sessions ?? []) sessions.add(id)
      }
      return sessions
    },
    async close() {
      try { await harness.close(context) } finally { lease.release(); openedDatabases.delete(path) }
    },
  }
}
