import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { addTaskEvent, taskHistory } from '../src/host/durable/history.js'
import { openDurableRuntime } from '../src/host/durable/runtime.js'

const code = await build({ entryPoints: [fileURLToPath(new URL('../src/client/durable-history.js', import.meta.url))], bundle: true, format: 'cjs', platform: 'node', write: false, external: ['react'] })
const module = { exports: {} }
runInNewContext(code.outputFiles[0].text, { module, exports: module.exports, require: () => ({}) })
const { durableHistoryRows } = module.exports

test('old and new saved questions retain full answers and options without exposing executor metadata', () => {
  const history = taskHistory({ state: { status: 'terminal' }, questions: [{ id: 'q', sessionId: 'worker', callId: 'hidden-call', gate: 'hidden-gate',
    question: 'Apply FIXTURE_SECRET?', detail: 'Only the reviewed files.', options: [{ label: 'Yes', description: 'Apply FIXTURE_SECRET' }], askedAt: 10, answer: 'Yes, only FIXTURE_SECRET', answeredAt: 20 }] }, ['worker'], text => text.replaceAll('FIXTURE_SECRET', '<hidden>'))
  assert.equal(history.questions[0].step, 0)
  assert.equal(history.questions[0].status, 'answered')
  assert.equal(history.questions[0].answer, 'Yes, only <hidden>')
  assert.equal(history.questions[0].options[0].description, 'Apply <hidden>')
  assert.doesNotMatch(JSON.stringify(history), /FIXTURE_SECRET|hidden-call|hidden-gate|sessionId|requestId/)
  const rows = durableHistoryRows(history)
  assert.equal(rows[0].label, 'Question answered')
  assert.equal(rows[0].answer, history.questions[0].answer)
  assert.equal(rows[0].answeredAt, 20)
})

test('terminal unanswered questions remain visible and legacy tasks have no invented events', () => {
  for (const record of [{ state: { status: 'terminal' } }, { abortRequested: true }]) {
    const history = taskHistory({ ...record, questions: [{ id: 'q', sessionId: 'worker', question: 'Continue?', askedAt: 15 }] }, [])
    assert.equal(durableHistoryRows(history)[0].label, 'Closed without an answer')
    assert.equal(history.questions[0].answer, undefined)
    assert.deepEqual(history.events, [])
    assert.equal(history.questions[0].step, -1)
  }
  assert.deepEqual(taskHistory(undefined), { events: [], questions: [], omittedEvents: 0 })
})

test('activity retention is bounded without trimming the independent question ledger', () => {
  const job = { questions: [{ id: 'saved-answer', answer: 'Keep this.' }] }
  for (let index = 0; index < 300; index++) addTaskEvent(job, 'tool_called', { tool: 'read' })
  assert.equal(job.events.length, 256)
  assert.equal(job.omittedEvents, 44)
  assert.equal(job.questions[0].answer, 'Keep this.')
  addTaskEvent(job, 'completed', { id: 'terminal' })
  const count = job.eventSequence
  addTaskEvent(job, 'completed', { id: 'terminal' })
  assert.equal(job.eventSequence, count)
})

test('real Pi tool activity is saved once across polling and restart; cancellation partial output is not a completed step', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsb-history-'))
  let sent = false
  let sequence = 12
  const options = { database: join(home, 'tasks.sqlite'), pollMs: 5, executor: {
    inspect: async () => ({ status: sent ? 'running' : 'absent', activity: { tools: sent ? [{ name: 'read', seq: sequence }] : [] } }),
    dispatch: async () => { sent = true }, stop: async () => ({ status: 'stopped', result: 'Partial unfinished output' }),
  } }
  let runtime = await openDurableRuntime(options)
  t.after(async () => { await runtime.close(); await rm(home, { recursive: true, force: true }) })
  await runtime.submit({ key: 'job', steps: [{ sessionId: 'worker', prompt: 'Inspect files' }] })
  const untilTool = async count => {
    for (let index = 0; index < 300; index++) {
      const job = await runtime.get('job')
      if (job.events.filter(event => event.type === 'tool_called').length === count) return
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.fail('Tool history did not settle')
  }
  await untilTool(1)
  await runtime.close()
  runtime = await openDurableRuntime(options)
  sequence = 13
  await untilTool(2)
  await runtime.cancel('job')
  await runtime.wait('job')
  const job = await runtime.get('job')
  assert.equal(job.events.filter(event => event.type === 'tool_called').length, 2)
  assert.equal(job.events.filter(event => event.type === 'step_completed').length, 0)
  assert.equal(job.events.at(-1).type, 'cancelled')
  assert.deepEqual(job.state.outcome.result, [])
  assert.deepEqual(job.partialResult, { step: 0, text: 'Partial unfinished output' })
})
