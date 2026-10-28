// Only DSH's public Session Controller and session persistence are used here.
const contextSources = new Set([
  'agent-instructions:instructions', 'runtime-context:snapshot',
  'skill-catalog:catalog', 'time-context:snapshot',
  'repeat-tool-reminder:notice', 'tool-jobs:notice',
])
const marker = requestId => `[DS Bot durable request ${requestId}]`
const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text ?? '').join('\n') : ''
const sourceOf = message => `${message?.source?.kind ?? 'unknown'}:${message?.source?.form ?? 'unknown'}`
export const matchesDurableInput = (message, requestId) => (message?.source?.kind === undefined || message.source.kind === 'user')
  && textOf(message?.content).startsWith(`${marker(requestId)}\n`)
export const isExecutionContext = message => contextSources.has(sourceOf(message))
export const matchesTaskInput = (message, input) => [input.requestId, ...(input.priorRequestIds ?? [])].some(id => matchesDurableInput(message, id))
const queued = agent => [...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])]
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value)
const isChildReply = message => ['agent-message:relay', 'subagent-settled:notice'].includes(sourceOf(message))

export async function executionContextFor(ctx, sessionId, messages) {
  const children = new Set()
  let ownershipUnavailable = false
  if (messages.some(isChildReply)) {
    try {
      const service = ctx.get?.('subagents')
      if (typeof service?.listChildren !== 'function') throw new Error('Child ownership is unavailable')
      const catalog = await service.listChildren(sessionId, AbortSignal.timeout(15_000))
      if (!Array.isArray(catalog)) throw new Error('Child catalog is unavailable')
      for (const child of catalog) if (validId(child?.id) && child.id !== sessionId) children.add(child.id)
    } catch { ownershipUnavailable = true }
  }
  return {
    accepts: message => isExecutionContext(message) || (isChildReply(message) && children.has(message.source.senderSessionId)),
    ownershipUnavailable,
  }
}

export function createDshExecutor({ ctx, canWrite = () => true, validateSession = () => true, stopMs = 10000 }) {
  const childWaits = new WeakMap()
  const childWork = async agent => {
    const service = ctx.get?.('subagents')
    if (!service) return { pending: false }
    if (typeof service.waitForChildren !== 'function') return { pending: false, failed: true }
    const sequence = String(agent.session.seq)
    let observation = childWaits.get(agent)
    if (!observation || (!observation.pending && observation.sequence !== sequence)) {
      observation = { sequence, pending: true, failed: false }
      childWaits.set(agent, observation)
      const current = observation
      // Observe the public join without blocking Pi polling or user cancellation.
      void Promise.resolve().then(() => service.waitForChildren(agent)).then(() => { current.pending = false }, () => { current.failed = true; current.pending = false })
    }
    await new Promise(resolve => setImmediate(resolve))
    return observation
  }
  const guard = async input => {
    if (!input || typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 256 || !validId(input.requestId)) {
      throw new Error('A dedicated sessionId and valid durable requestId are required')
    }
    if (await canWrite() !== true) throw new Error('The durable DSH executor has no write ownership')
    if (await validateSession(input.sessionId) !== true) throw new Error('Session is not reserved for durable execution')
  }
  const agentOf = async sessionId => {
    const result = await ctx.sessionController.resolveAgent(sessionId)
    if (result?.error || !result?.agent) throw new Error('The durable DSH session is unavailable')
    return result.agent
  }
  const snapshot = agent => JSON.stringify({
    seq: String(agent.session.seq), status: agent.status,
    inbox: queued(agent).map(message => ({ id: message.id, text: textOf(message.content), source: sourceOf(message), senderSessionId: message.source?.senderSessionId })),
  })
  const recordsOf = async sessionId => {
    const agent = await agentOf(sessionId)
    const before = snapshot(agent)
    const throughSeq = Number(agent.session.seq) - 1
    if (!Number.isSafeInteger(throughSeq) || throughSeq < -1) return { agent, records: [], reason: 'invalid_history_sequence' }
    const records = []
    if (throughSeq < 0) return { agent, records, ...(before === snapshot(agent) ? {} : { reason: 'history_changed' }) }
    let beforeSeq
    for (let count = 0; count < 128; count += 1) {
      const page = await ctx.sessionController.page({
        address: { kind: 'session', sessionId }, throughSeq,
        ...(beforeSeq === undefined ? {} : { beforeSeq }), maxMessages: 256,
      }, AbortSignal.timeout(15_000))
      if (!Array.isArray(page?.records)) return { agent, records, reason: 'incomplete_history' }
      records.unshift(...page.records.map(record => record.event))
      if (page.hasMore === false) return { agent, records, ...(before === snapshot(agent) ? {} : { reason: 'history_changed' }) }
      if (page.hasMore !== true || page.records.length === 0) return { agent, records, reason: 'incomplete_history' }
      const next = page.records[0].event?.seq
      if (next === undefined || (beforeSeq !== undefined && Number(next) >= Number(beforeSeq))) return { agent, records, reason: 'incomplete_history' }
      beforeSeq = next
    }
    return { agent, records, reason: 'history_limit' }
  }
  const inspect = async input => {
    await guard(input)
    const { sessionId, requestId } = input
    const { agent, records, reason } = await recordsOf(sessionId)
    if (reason) return { sessionId, requestId, status: 'uncertain', reason }
    const cut = snapshot(agent)
    const inbox = queued(agent)
    const context = await executionContextFor(ctx, sessionId, [...records.filter(event => event?.type === 'user/message').map(event => event.data), ...inbox])
    if (cut !== snapshot(agent)) return { sessionId, requestId, status: 'uncertain', reason: 'history_changed' }
    let found = false
    let currentTurn
    let turn
    let ended
    let text = ''
    let inputs = 0
    let foreignInputs = 0
    const tools = []
    const foreignSources = new Set()
    for (const event of records) {
      if (event?.type === 'turn/start') currentTurn = event.data?.turn
      if (event?.type === 'user/message' && matchesDurableInput(event.data, requestId)) {
        inputs += 1
        found = true
        turn = currentTurn
        ended = undefined
        text = ''
      } else if (event?.type === 'user/message') {
        if (!context.accepts(event.data) && !matchesTaskInput(event.data, input)) { foreignInputs += 1; foreignSources.add(sourceOf(event.data).slice(0, 256)) }
        else if (found && isChildReply(event.data)) { turn = currentTurn; ended = undefined }
      } else if (found && ended === undefined && event?.type === 'tool/call') {
        tools.push({ name: event.data?.name, seq: event.seq })
      } else if (found && ended === undefined && event?.type === 'assistant/message') {
        const line = textOf(event.data?.message?.content)
        if (line) text = [text, line].filter(Boolean).join('\n')
      } else if (found && ended === undefined && event?.type === 'turn/end') {
        ended = event.data?.reason?.kind ?? 'unknown'
      }
    }
    const waiting = inbox.some(message => matchesDurableInput(message, requestId))
    const foreignQueued = []
    for (const [queue, messages] of [['next-step', agent.inbox?.nextStep ?? []], ['next-turn', agent.inbox?.nextTurn ?? []]]) for (const message of messages) {
      if (matchesTaskInput(message, input) || context.accepts(message)) continue
      const source = sourceOf(message).slice(0, 256)
      foreignSources.add(source)
      foreignQueued.push({ queue, source, ...(validId(message.source?.senderSessionId) ? { senderSessionId: message.source.senderSessionId } : {}) })
    }
    const childWaiting = inbox.some(message => isChildReply(message) && context.accepts(message))
    const children = ended === 'completed' && !foreignInputs && !foreignQueued.length ? await childWork(agent) : { pending: false }
    if (cut !== snapshot(agent)) return { sessionId, requestId, status: 'uncertain', reason: 'history_changed' }
    const status = inputs > 1 || foreignInputs > 0 || foreignQueued.length || children.failed ? 'uncertain' : ended === 'completed' ? childWaiting || children.pending || agent.status === 'running' ? 'running' : agent.status === 'idle' ? 'completed' : 'uncertain'
      : ended !== undefined ? 'interrupted' : found ? (agent.status === 'running' ? 'running' : 'interrupted')
        : waiting ? 'running' : agent.status === 'idle' ? 'absent' : 'uncertain'
    return {
      sessionId, requestId, status, inputs, foreignInputs, sequence: Number(agent.session.seq),
      activity: { tools: tools.slice(-20), foreignSources: [...foreignSources].slice(0, 20), foreignQueued: foreignQueued.slice(0, 20),
        ...(context.ownershipUnavailable ? { ownershipUnavailable: true } : {}) },
      ...(inputs > 1 ? { reason: 'duplicate_inputs' } : foreignInputs > 0 ? { reason: 'foreign_inputs' } : foreignQueued.length ? { reason: 'foreign_queued' } : children.failed ? { reason: 'child_teardown_unconfirmed' } : status === 'uncertain' ? { reason: 'unmatched_activity' } : {}),
      ...(turn === undefined ? {} : { turn }), ...(ended === undefined ? {} : { endReason: ended }), ...(text ? { result: text.slice(-24000) } : {}),
    }
  }
  const dispatch = async input => {
    await guard(input)
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 32000) throw new Error('Supply a durable task prompt of at most 32000 characters')
    const existing = await inspect(input)
    if (existing.status !== 'absent') return { ...existing, reused: true }
    // The checks guard dispatch too: a session can be removed or a writer can lose
    // ownership while history was read. DSH admission is not a Pi transaction.
    await guard(input)
    const result = await ctx.sessionController.prompt({
      sessionId: input.sessionId, requestId: input.requestId, mode: 'queue',
      content: [{ type: 'text', text: `${marker(input.requestId)}\n${input.prompt}` }],
    }, AbortSignal.timeout(30_000))
    if (result?.error) throw new Error('DSH refused the durable task input')
    await ctx.sessions.flush((await agentOf(input.sessionId)).session)
    return { sessionId: input.sessionId, requestId: input.requestId, reused: false }
  }
  const stop = async input => {
    await guard(input)
    const before = await inspect(input)
    if (before.status === 'uncertain') return { status: 'uncertain', reason: before.reason }
    const agent = await agentOf(input.sessionId)
    if (typeof agent.cancel !== 'function' || typeof agent.whenIdle !== 'function') return { status: 'uncertain', reason: 'stop_unavailable' }
    const jobs = ctx.get?.('jobs')
    const children = ctx.get?.('subagents')
    const ownedJobs = () => (jobs?.list(input.sessionId) ?? []).filter(job => job.owner === input.sessionId && ['running', 'stopping'].includes(job.status))
    const stoppingJobs = ownedJobs()
    // Dedicated sessions have one durable input. Never cancel a session whose
    // transcript or inbox contains another person's work.
    const verified = await inspect(input)
    if (verified.status === 'uncertain' || verified.sequence !== Number(agent.session.seq)
      || (verified.endReason !== undefined && agent.status === 'running')) return { status: 'uncertain', reason: 'history_changed' }
    agent.cancel({ kind: 'user' })
    for (const job of stoppingJobs) { try { jobs.kill(job.id, input.sessionId, 'Durable task cancelled by user') } catch {} }
    let timer
    try {
      const settled = await Promise.race([
        Promise.all([agent.whenIdle(), children?.drainDescendants([agent]),
          ...stoppingJobs.map(job => jobs.wait(job.id, stopMs, input.sessionId).catch(() => undefined))]).then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), stopMs) }),
      ])
      if (!settled || agent.status !== 'idle' || ownedJobs().length) return { status: 'uncertain', reason: 'still_stopping' }
      await ctx.sessions.flush(agent.session)
      const after = await recordsOf(input.sessionId)
      const context = await executionContextFor(ctx, input.sessionId, queued(agent))
      if (after.reason || queued(agent).some(message => !context.accepts(message))) return { status: 'uncertain', reason: 'stop_not_confirmed' }
      for (const job of stoppingJobs) {
        const receipt = after.records.findLast(event => event.type === 'job/settled' && event.data?.jobId === job.id)
        if (receipt?.data?.producerReported !== true) return { status: 'uncertain', reason: 'job_stop_not_confirmed' }
      }
      const checked = await inspect(input)
      return checked.status === 'uncertain' ? checked : { status: 'stopped', ...(before.status === 'completed' ? { result: before.result } : {}) }
    } finally { clearTimeout(timer) }
  }
  return { inspect, dispatch, stop }
}
