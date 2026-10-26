// Only DSH's public Session Controller and session persistence are used here.
const contextSources = new Set([
  'agent-instructions:instructions', 'runtime-context:snapshot',
  'skill-catalog:catalog', 'time-context:snapshot',
])
const marker = requestId => `[DS Bot durable request ${requestId}]`
const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text ?? '').join('\n') : ''
const sourceOf = message => `${message?.source?.kind ?? 'unknown'}:${message?.source?.form ?? 'unknown'}`
export const matchesDurableInput = (message, requestId) => textOf(message?.content).startsWith(`${marker(requestId)}\n`)
export const isExecutionContext = message => contextSources.has(sourceOf(message))
const queued = agent => [...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])]
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value)

export function createDshExecutor({ ctx, canWrite = () => true, validateSession = () => true, stopMs = 10000 }) {
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
    inbox: queued(agent).map(message => ({ id: message.id, text: textOf(message.content), source: sourceOf(message) })),
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
    let found = false
    let currentTurn
    let turn
    let ended
    let text = ''
    let inputs = 0
    let foreignInputs = 0
    for (const event of records) {
      if (event?.type === 'turn/start') currentTurn = event.data?.turn
      if (event?.type === 'user/message' && matchesDurableInput(event.data, requestId)) {
        inputs += 1
        found = true
        turn = currentTurn
        ended = undefined
        text = ''
      } else if (event?.type === 'user/message') {
        if (!contextSources.has(sourceOf(event.data))) foreignInputs += 1
      } else if (found && ended === undefined && event?.type === 'assistant/message') {
        const line = textOf(event.data?.message?.content)
        if (line) text = [text, line].filter(Boolean).join('\n')
      } else if (found && ended === undefined && event?.type === 'turn/end') {
        ended = event.data?.reason?.kind ?? 'unknown'
      }
    }
    const inbox = queued(agent)
    const waiting = inbox.some(message => matchesDurableInput(message, requestId))
    const foreignQueued = inbox.some(message => !matchesDurableInput(message, requestId) && !contextSources.has(sourceOf(message)))
    const status = inputs > 1 || foreignInputs > 0 || foreignQueued ? 'uncertain' : ended === 'completed' ? 'completed'
      : ended !== undefined ? 'interrupted' : found ? (agent.status === 'running' ? 'running' : 'interrupted')
        : waiting ? 'running' : agent.status === 'idle' ? 'absent' : 'uncertain'
    return {
      sessionId, requestId, status, inputs, foreignInputs, sequence: Number(agent.session.seq),
      ...(inputs > 1 ? { reason: 'duplicate_inputs' } : foreignInputs > 0 ? { reason: 'foreign_inputs' } : foreignQueued ? { reason: 'foreign_queued' } : status === 'uncertain' ? { reason: 'unmatched_activity' } : {}),
      ...(turn === undefined ? {} : { turn }), ...(ended === undefined ? {} : { endReason: ended }), ...(text ? { result: text } : {}),
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
      if (after.reason || queued(agent).some(message => !contextSources.has(sourceOf(message)))) return { status: 'uncertain', reason: 'stop_not_confirmed' }
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
