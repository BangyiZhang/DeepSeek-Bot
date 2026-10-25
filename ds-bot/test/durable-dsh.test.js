import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDshExecutor } from '../src/host/durable/dsh.js'

const input = { sessionId: 'session', requestId: 'work:0', prompt: 'Read the fixture' }
const text = value => [{ type: 'text', text: value }]
const own = (requestId = input.requestId) => ({ type: 'user/message', data: { content: text(`[DS Bot durable request ${requestId}]\nRead the fixture`) } })
const answer = { type: 'assistant/message', data: { message: { content: text('The fixture is valid.') } } }
const end = kind => ({ type: 'turn/end', data: { reason: { kind } } })
function fixture(events = [], options = {}) {
  const agent = { session: { id: 'session', seq: events.length }, status: 'idle', inbox: { nextStep: [], nextTurn: [] } }
  const calls = { prompts: [], flushes: 0, pages: [] }
  const records = events.map((event, seq) => ({ event: { ...event, seq } }))
  const ctx = {
    sessionController: {
      resolveAgent: async () => ({ agent }),
      page: async request => { calls.pages.push(request); options.page?.(agent, request); return { records, hasMore: false } },
      prompt: async request => { calls.prompts.push(request); return options.promptResult },
    },
    sessions: { flush: async () => { calls.flushes += 1 } },
  }
  return { agent, ctx, calls, records, executor: createDshExecutor({ ctx, ...options }) }
}

test('stop cancels only matched dedicated input and waits for actual idle', async () => {
  const f = fixture([own()])
  f.agent.status = 'running'
  let cancelled = 0
  f.agent.cancel = () => { cancelled += 1; f.agent.status = 'idle'; f.records.push({ event: { ...end('aborted'), seq: f.agent.session.seq++ } }) }
  f.agent.whenIdle = async () => {}
  assert.equal((await f.executor.stop(input)).status, 'stopped')
  assert.equal(cancelled, 1)
  const foreign = fixture([{ type: 'user/message', data: { content: text('unrelated work') } }])
  foreign.agent.cancel = () => assert.fail('must not cancel foreign work')
  foreign.agent.whenIdle = async () => {}
  assert.equal((await foreign.executor.stop(input)).status, 'uncertain')
})

test('stop does not claim success when a producer ignores cancellation', async () => {
  const f = fixture([own()], { stopMs: 5 })
  f.agent.status = 'running'
  f.agent.cancel = () => {}
  f.agent.whenIdle = () => new Promise(() => {})
  assert.equal((await f.executor.stop(input)).reason, 'still_stopping')
})

test('queued input is cleared and unrelated unowned jobs are left alone', async () => {
  const f = fixture()
  f.agent.inbox.nextTurn.push(own().data)
  f.agent.cancel = () => { f.agent.inbox.nextTurn = [] }
  f.agent.whenIdle = async () => {}
  f.ctx.get = name => name === 'jobs' ? { list: () => [{ id: 'unowned', status: 'running' }], kill: () => assert.fail('unowned job') } : undefined
  assert.equal((await f.executor.stop(input)).status, 'stopped')
})
test('owned jobs and descendants must settle, and forced job settlement is not proof of exit', async () => {
  for (const producerReported of [true, false]) {
    const f = fixture([own()])
    f.agent.status = 'running'
    f.agent.cancel = () => { f.agent.status = 'idle' }
    f.agent.whenIdle = async () => {}
    let live = true
    let drained = false
    f.ctx.get = name => name === 'jobs' ? {
      list: () => [{ id: 'owned', owner: 'session', status: live ? 'running' : 'killed' }, { id: 'other', owner: 'other', status: 'running' }],
      kill: (id, caller) => { assert.equal(id, 'owned'); assert.equal(caller, 'session') },
      wait: async () => { live = false; f.records.push({ event: { type: 'job/settled', seq: f.agent.session.seq++, data: { jobId: 'owned', producerReported } } }) },
    } : name === 'subagents' ? { drainDescendants: async parents => { assert.deepEqual(parents, [f.agent]); drained = true } } : undefined
    assert.equal((await f.executor.stop(input)).status, producerReported ? 'stopped' : 'uncertain')
    assert.equal(drained, true)
  }
})
test('completed request reads the public transcript result; interrupted requests are distinguished', async () => {
  const complete = fixture([{ type: 'turn/start', data: { turn: 7 } }, own(), answer, end('completed')])
  const record = await complete.executor.inspect(input)
  assert.equal(record.status, 'completed')
  assert.equal(record.turn, 7)
  assert.equal(record.result, 'The fixture is valid.')
  assert.equal((await fixture([own(), end('aborted')]).executor.inspect(input)).status, 'interrupted')
  assert.equal((await fixture([own()]).executor.inspect(input)).status, 'interrupted')
})
test('exact engine context sources are allowed; arbitrary sources and embedded markers are foreign', async () => {
  for (const [kind, form] of [['agent-instructions', 'instructions'], ['runtime-context', 'snapshot'], ['skill-catalog', 'catalog'], ['time-context', 'snapshot']]) {
    const context = { type: 'user/message', data: { source: { kind, form }, content: text('context') } }
    assert.equal((await fixture([context, own(), end('completed')]).executor.inspect(input)).status, 'completed')
    assert.equal((await fixture([{ ...context, data: { ...context.data, source: { kind, form: 'other' } } }, own(), end('completed')]).executor.inspect(input)).status, 'uncertain')
  }
  assert.equal((await fixture([{ type: 'user/message', data: { content: text('a different request') } }]).executor.inspect(input)).reason, 'foreign_inputs')
  assert.equal((await fixture([{ type: 'user/message', data: { content: text(`Quoted ${own().data.content[0].text}`) } }]).executor.inspect(input)).status, 'uncertain')
})
test('duplicate input, foreign queued input and unowned running work are uncertain', async () => {
  assert.equal((await fixture([own(), own(), end('completed')]).executor.inspect(input)).reason, 'duplicate_inputs')
  const queued = fixture()
  queued.agent.inbox.nextTurn.push({ content: text('external input') })
  assert.equal((await queued.executor.inspect(input)).reason, 'foreign_queued')
  const working = fixture()
  working.agent.status = 'running'
  assert.equal((await working.executor.inspect(input)).status, 'uncertain')
  working.agent.inbox.nextStep.push(own().data)
  assert.equal((await working.executor.inspect(input)).status, 'running')
})
test('a changing sequence or inbox cannot certify absence or completion', async () => {
  const changing = fixture([{ type: 'session/start', data: {} }], { page: agent => { agent.session.seq += 1 } })
  assert.equal((await changing.executor.inspect(input)).reason, 'history_changed')
  const inbox = fixture([own(), end('completed')], { page: agent => { agent.inbox.nextTurn.push({ content: text('new input') }) } })
  assert.equal((await inbox.executor.inspect(input)).reason, 'history_changed')
})
test('incomplete and bounded history never produce absent', async () => {
  const incomplete = fixture([{ type: 'session/start', data: {} }])
  incomplete.ctx.sessionController.page = async () => ({ records: [], hasMore: true })
  assert.equal((await incomplete.executor.inspect(input)).reason, 'incomplete_history')
  const repeated = fixture([{ type: 'session/start', data: {} }])
  repeated.ctx.sessionController.page = async () => ({ records: [{ event: { seq: 0, type: 'session/start' } }], hasMore: true })
  assert.equal((await repeated.executor.inspect(input)).reason, 'incomplete_history')
  const truncated = fixture([{ type: 'session/start', data: {} }])
  let pages = 0
  truncated.ctx.sessionController.page = async () => ({ records: [{ event: { seq: 1000 - pages++, type: 'session/start' } }], hasMore: true })
  assert.equal((await truncated.executor.inspect(input)).reason, 'history_limit')
  assert.equal(pages, 128)
})
test('dispatch rechecks public state, sends once and flushes admission', async () => {
  const fresh = fixture()
  assert.equal((await fresh.executor.dispatch(input)).reused, false)
  assert.equal(fresh.calls.prompts.length, 1)
  assert.equal(fresh.calls.prompts[0].requestId, input.requestId)
  assert.equal(fresh.calls.prompts[0].mode, 'queue')
  assert.match(fresh.calls.prompts[0].content[0].text, /^\[DS Bot durable request work:0\]\n/)
  assert.equal(fresh.calls.flushes, 1)
  for (const existing of [[own(), answer, end('completed')], [own(), end('aborted')], [{ type: 'user/message', data: { content: text('foreign') } }]]) {
    const f = fixture(existing)
    assert.equal((await f.executor.dispatch(input)).reused, true)
    assert.equal(f.calls.prompts.length, 0)
  }
})
test('dispatch rechecks writer and session ownership after reading history', async () => {
  let writable = true
  const writer = fixture([{ type: 'session/start', data: {} }], { canWrite: () => writable, page: () => { writable = false } })
  await assert.rejects(writer.executor.dispatch(input), /write ownership/)
  assert.equal(writer.calls.prompts.length, 0)
  const foreign = fixture([], { validateSession: () => false })
  await assert.rejects(foreign.executor.inspect(input), /reserved/)
  const refused = fixture([], { promptResult: { error: { message: 'refused' } } })
  await assert.rejects(refused.executor.dispatch(input), /DSH refused/)
  assert.equal(refused.calls.flushes, 0)
})
test('malformed calls and unknown agent states fail closed', async () => {
  const f = fixture()
  await assert.rejects(f.executor.inspect({ sessionId: 'session', requestId: '../key' }), /requestId/)
  await assert.rejects(f.executor.dispatch({ ...input, prompt: '' }), /prompt/)
  f.agent.status = 'unknown'
  assert.equal((await f.executor.inspect(input)).status, 'uncertain')
  f.agent.session.seq = undefined
  assert.equal((await f.executor.inspect(input)).reason, 'invalid_history_sequence')
})
