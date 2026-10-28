import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { openDurableRuntime } from '../src/host/durable/runtime.js'

async function until(read) {
  for (let i = 0; i < 600; i += 1) { const value = await read(); if (value) return value; await delay(10) }
  throw new Error('Durable interaction did not settle')
}
async function bench(t, completeContinuations = true) {
  const home = await mkdtemp(join(tmpdir(), 'dsb-durable-interaction-'))
  const calls = []
  const states = new Map()
  const config = { database: join(home, 'tasks.sqlite'), pollMs: 5, executor: {
    inspect: async input => ({ status: states.get(input.requestId) ?? 'absent', result: 'Saved final result.' }),
    dispatch: async input => { calls.push(input); states.set(input.requestId, calls.length === 1 || !completeContinuations ? 'running' : 'completed') },
    stop: async () => ({ status: 'stopped' }),
  } }
  let runtime = await openDurableRuntime(config)
  t.after(async () => { await runtime.close(); await rm(home, { recursive: true, force: true }) })
  await runtime.prepareCreate({ key: 'task', title: 'Same task', prompts: ['Inspect then confirm'], model: 'mock/model',
    origin: { botId: 'chief', sessionId: 'chief' }, execution: { cwd: tmpdir(), permission: 'workspace-write', permissionSpec: '{}',
      instructions: 'Keep scope', allowedTools: ['read', 'ask_user'], botManaged: true, capabilities: { names: [], digest: '0'.repeat(64) }, context: '' } })
  await runtime.updateCreateAllocation('task', { index: 0, sessionId: 'worker' })
  await runtime.submit({ key: 'task', steps: [{ sessionId: 'worker', prompt: 'Inspect then confirm' }] })
  await until(() => calls.length)
  const ask = async (callId = 'call-one') => {
    const question = await runtime.ask('task', { sessionId: 'worker', callId, question: 'Apply the checked change?', detail: 'Inspection saved; nothing applied yet.', options: [{ label: 'Apply' }, { label: 'Leave it' }] })
    states.set(calls.at(-1).requestId, 'completed')
    await until(async () => (await runtime.get('task')).state.status === 'waiting')
    return question
  }
  return { calls, states, ask, get runtime() { return runtime }, async reopen() { await runtime.close(); runtime = await openDurableRuntime(config) } }
}

test('question survives restart and its answer continues the same session without replaying its original input', async t => {
  const b = await bench(t)
  const question = await b.ask()
  const taskId = (await b.runtime.get('task')).id
  assert.equal((await b.runtime.get('task')).question.id, question.id)
  await b.reopen()
  assert.equal((await b.runtime.get('task')).question.id, question.id)
  assert.equal(b.calls.length, 1)
  await b.runtime.answerQuestion('task', question.id, 'Apply only the checked change')
  const done = await b.runtime.wait('task')
  assert.equal(done.id, taskId)
  assert.equal(done.state.outcome.status, 'completed')
  assert.deepEqual(b.calls.map(input => input.requestId), ['task:0', 'task:0:a1'])
  assert.equal(b.calls[1].sessionId, 'worker')
  assert.deepEqual(b.calls[1].priorRequestIds, ['task:0'])
  assert.match(b.calls[1].prompt, /Apply only the checked change/)
  await b.reopen()
  assert.equal(b.calls.length, 2)
  const saved = await b.runtime.get('task')
  assert.equal(saved.question, undefined)
  assert.equal(saved.questions[0].question, question.question)
  assert.equal(saved.questions[0].answer, 'Apply only the checked change')
  assert.ok(saved.questions[0].answeredAt >= saved.questions[0].askedAt)
  assert.deepEqual(saved.events.filter(event => ['created', 'answer_continued', 'step_completed', 'completed'].includes(event.type)).map(event => event.type),
    ['created', 'answer_continued', 'step_completed', 'completed'])
  assert.equal(saved.events.filter(event => event.type === 'step_completed').length, 1)
  await assert.rejects(b.runtime.answerQuestion('task', question.id, 'again'), /finished|no longer|already/)
})

test('waiting task can be cancelled and a late answer cannot restart it', async t => {
  const b = await bench(t)
  const question = await b.ask()
  await b.runtime.cancel('task')
  assert.equal((await b.runtime.wait('task')).state.outcome.status, 'aborted')
  await assert.rejects(b.runtime.answerQuestion('task', question.id, 'Apply'), /finished|cancelling/)
  await b.reopen()
  assert.equal(b.calls.length, 1)
  const saved = await b.runtime.get('task')
  assert.equal(saved.questions[0].question, question.question)
  assert.equal(saved.questions[0].answer, undefined)
  assert.equal(saved.events.at(-1).type, 'cancelled')
})

test('answer does not bypass a manual pause; duplicate and wrong question answers are refused', async t => {
  const b = await bench(t)
  const question = await b.ask()
  await assert.rejects(b.runtime.answerQuestion('task', 'wrong-question', 'Apply'), /no longer/)
  await b.runtime.pause('task')
  await b.runtime.answerQuestion('task', question.id, 'Apply')
  await until(async () => (await b.runtime.get('task')).state.checkpoint?.paused)
  await assert.rejects(b.runtime.answerQuestion('task', question.id, 'Leave it'), /already/)
  await b.reopen()
  assert.equal(b.calls.length, 1)
  await b.runtime.resume('task')
  assert.equal((await b.runtime.wait('task')).state.outcome.status, 'completed')
  assert.equal(b.calls.length, 2)
  const events = (await b.runtime.get('task')).events.map(event => event.type)
  assert.equal(events.filter(type => type === 'pause_requested').length, 1)
  assert.equal(events.filter(type => type === 'paused').length, 1)
  assert.equal(events.filter(type => type === 'resume_requested').length, 1)
  assert.ok(events.indexOf('paused') < events.indexOf('answer_continued'))
})

test('one stable tool call creates one question and foreign workers cannot ask for the task', async t => {
  const b = await bench(t)
  const question = await b.ask()
  assert.equal((await b.runtime.ask('task', { sessionId: 'worker', callId: 'call-one', question: question.question })).id, question.id)
  await assert.rejects(b.runtime.ask('task', { sessionId: 'other-worker', callId: 'call-two', question: '?' }), /no longer active/)
  await assert.rejects(b.runtime.ask('task', { sessionId: 'worker', callId: 'call-two', question: '?' }), /already has a question/)
})

test('several questions in one stage retain separate answers and continuation identities', async t => {
  const b = await bench(t, false)
  const first = await b.ask()
  await b.runtime.answerQuestion('task', first.id, 'First decision')
  await until(() => b.calls.length === 2)
  const second = await b.ask('call-two')
  assert.notEqual(first.id, second.id)
  await b.reopen()
  assert.equal((await b.runtime.get('task')).question.id, second.id)
  await b.runtime.answerQuestion('task', second.id, 'Second decision')
  await until(() => b.calls.length === 3)
  b.states.set('task:0:a2', 'completed')
  assert.equal((await b.runtime.wait('task')).state.outcome.status, 'completed')
  assert.deepEqual(b.calls.map(input => input.requestId), ['task:0', 'task:0:a1', 'task:0:a2'])
  assert.deepEqual(b.calls[2].priorRequestIds, ['task:0', 'task:0:a1'])
  const record = await b.runtime.get('task')
  assert.deepEqual(record.questions.map(question => question.answer), ['First decision', 'Second decision'])
})
