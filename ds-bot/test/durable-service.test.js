import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { install } from '../src/host/durable/index.js'

async function bench(t, { enabled = true, savedEnabled, readOnly, behavior = 'complete', withAgent = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsb-durable-service-'))
  const effects = []
  const calls = { prompts: [], resolves: 0, flushes: 0, loads: 0, allocated: 0, selected: [], renamed: [], modelFails: false }
  const sessions = new Map()
  const agents = withAgent ? { 'raw-agent': { id: 'raw-agent', sessions: ['dedicated'] } } : {}
  const session = id => {
    const value = { agent: { session: { id, seq: 0 }, status: 'idle', inbox: { nextStep: [], nextTurn: [] } }, records: [] }
    sessions.set(id, value)
    return value
  }
  const dedicated = session('dedicated')
  const appendTo = (value, event) => { value.records.push({ event: { ...event, seq: value.agent.session.seq++ } }) }
  const ctx = {
    effect(execute) { const cleanup = execute(); effects.push(cleanup) },
    sessionController: {
      async resolveAgent(sessionId) { calls.resolves += 1; return sessions.has(sessionId) ? { agent: sessions.get(sessionId).agent } : { error: { message: 'Unknown session' } } },
      async page({ address, throughSeq }) { return { records: sessions.get(address.sessionId).records.filter(record => record.event.seq <= throughSeq), hasMore: false } },
      async prompt(request) {
        calls.prompts.push(request)
        const value = sessions.get(request.sessionId)
        value.agent.status = 'running'
        appendTo(value, { type: 'turn/start', data: { turn: 1 } })
        appendTo(value, { type: 'user/message', data: { content: request.content } })
        if (behavior === 'complete') {
          appendTo(value, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Fixture checked by DSH.' }] } } })
          appendTo(value, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
          value.agent.status = 'idle'
        }
      },
    },
    sessions: { async flush() { calls.flushes += 1 } },
  }
  const rt = {
    ctx, home, config: { durableTasks: enabled }, state: { agents, prefs: savedEnabled === undefined ? {} : { durableTasks: savedEnabled } },
    async load() { calls.loads += 1 },
    readOnly: () => readOnly,
    agentOf: sessionId => Object.values(agents).find(agent => agent.sessions.includes(sessionId)),
    catalog: async () => [{ ref: 'mock/model', provider: 'mock', id: 'model' }],
    async createAgentSession(agentId) {
      const id = `allocated-${++calls.allocated}`
      session(id); agents[agentId].sessions.push(id); return id
    },
    async addAgent() {
      const agent = { id: 'new-agent', sessions: [] }
      agents[agent.id] = agent; await this.createAgentSession(agent.id); return agent
    },
    async selectSessionModel(sessionId, route) {
      calls.selected.push({ sessionId, ...route })
      return calls.modelFails ? { error: { message: 'fixture model failure' } } : { selected: route }
    },
    async renameAgentSession(agentId, sessionId, title) { calls.renamed.push({ agentId, sessionId, title }) },
    warn() {},
  }
  install(rt)
  const cleanup = async () => { for (const dispose of effects.splice(0).reverse()) await dispose?.() }
  t.after(async () => { await cleanup(); await rm(home, { recursive: true, force: true }) })
  return { rt, calls, effects, home, agent: dedicated.agent, append: event => appendTo(dedicated, event), cleanup }
}
const job = (sessionId = 'dedicated', key = 'fixture') => ({ key, steps: [{ sessionId, prompt: 'Check the fixture' }] })
async function until(check) {
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await delay(10)
  }
  throw new Error('Durable service did not reach the expected state')
}
const stateOf = async (rt, key = 'fixture') => (await rt.durableEndpoint('durable-state', { key })).jobs[0]?.state

test('disabled service creates no task storage or execution side effects', async t => {
  const b = await bench(t, { enabled: false })
  assert.equal(b.effects.length, 1)
  assert.deepEqual(await b.rt.durableEndpoint('durable-state'), { enabled: false, jobs: [] })
  await assert.rejects(b.rt.durableEndpoint('durable-submit', job()), /disabled/)
  await b.rt.assertDurableSessionAvailable('dedicated')
  assert.deepEqual(await readdir(b.home), [])
  assert.equal(b.calls.resolves, 0)
  assert.equal(b.calls.prompts.length, 0)
})
test('read-only host neither opens SQLite nor submits DSH work', async t => {
  const b = await bench(t, { readOnly: 'Read-only test Host' })
  assert.deepEqual(await b.rt.durableEndpoint('durable-state'), { enabled: true, readOnly: true, jobs: [] })
  await assert.rejects(b.rt.durableEndpoint('durable-submit', job()), /Read-only/)
  await assert.rejects(b.rt.assertDurableSessionAvailable('dedicated'), /Read-only/)
  assert.deepEqual(await readdir(b.home), [])
  assert.equal(b.calls.resolves, 0)
  assert.equal(b.calls.prompts.length, 0)
})
test('Bot, group and foreign sessions cannot enter the durable execution path', async t => {
  const b = await bench(t)
  for (const sessionId of ['bot-chat', 'group-chat', 'external-session']) {
    await assert.rejects(b.rt.durableEndpoint('durable-submit', job(sessionId)), /dedicated DSH Agent sessions/)
  }
  await assert.rejects(b.rt.durableEndpoint('durable-submit', { key: 'bad', steps: [null] }), /dedicated DSH Agent sessions/)
  assert.equal(b.calls.prompts.length, 0)
  assert.equal(b.calls.resolves, 0)
})
test('dedicated DSH work reaches real Pi SQLite and completed sessions are available for archive', async t => {
  const b = await bench(t)
  const admission = await b.rt.durableEndpoint('durable-submit', job())
  assert.equal(Number.isSafeInteger(admission.taskId), true)
  const result = await until(async () => {
    const state = await stateOf(b.rt)
    return state?.status === 'terminal' ? state : undefined
  })
  assert.equal(result.outcome.status, 'completed')
  assert.deepEqual(result.outcome.result, ['Fixture checked by DSH.'])
  assert.equal(b.calls.prompts.length, 1)
  assert.equal(b.calls.flushes, 1)
  assert.deepEqual(await b.rt.durableEndpoint('durable-submit', job()), admission)
  await b.rt.assertDurableSessionAvailable('dedicated')
  assert.equal((await readdir(join(b.home, 'durable'))).includes('tasks.sqlite'), true)
})
test('sessions with pending work cannot be archived or removed', async t => {
  const b = await bench(t, { behavior: 'wait' })
  await b.rt.durableEndpoint('durable-submit', job())
  await until(() => b.calls.prompts.length === 1)
  await assert.rejects(b.rt.assertDurableSessionAvailable('dedicated'), /unfinished durable work|reconciliation/)
  await b.rt.assertDurableSessionAvailable('unrelated-session')
  const state = await stateOf(b.rt)
  assert.notEqual(state.status, 'terminal')
})
test('foreign input requires reconciliation and keeps the session protected', async t => {
  const b = await bench(t)
  b.append({ type: 'user/message', data: { content: [{ type: 'text', text: 'This session already has unrelated work' }] } })
  await b.rt.durableEndpoint('durable-submit', job())
  const result = await until(async () => {
    const state = await stateOf(b.rt)
    return state?.status === 'terminal' ? state : undefined
  })
  assert.equal(result.outcome.status, 'failed')
  assert.equal(result.outcome.error.code, 'NEEDS_RECONCILIATION')
  assert.equal(b.calls.prompts.length, 0)
  await assert.rejects(b.rt.assertDurableSessionAvailable('dedicated'), /reconciliation/)
})


const creation = overrides => ({ key: 'created', title: 'Check fixtures', prompts: ['Inspect the first fixture', 'Summarize the result'], model: 'mock/model', ...overrides })
test('durable-create allocates named sessions and uses the selected DSH model', async t => {
  const b = await bench(t, { withAgent: false })
  const admission = await b.rt.durableEndpoint('durable-create', creation())
  assert.equal(Number.isSafeInteger(admission.taskId), true)
  const completed = await until(async () => {
    const job = (await b.rt.durableEndpoint('durable-state', { key: 'created' })).jobs[0]
    return job.state.status === 'terminal' ? job : undefined
  })
  assert.equal(completed.state.outcome.status, 'completed')
  assert.equal(completed.title, 'Check fixtures')
  assert.equal(completed.stepCount, 2)
  assert.deepEqual(completed.sessionIds, ['allocated-1', 'allocated-2'])
  assert.equal(b.calls.allocated, 2)
  assert.equal(b.calls.selected.length, 2)
  assert.equal(b.calls.renamed.length, 2)
  assert.equal(b.calls.prompts.length, 2)
  assert.equal(b.calls.selected.every(entry => entry.provider === 'mock' && entry.model === 'model'), true)
  assert.deepEqual(await b.rt.durableEndpoint('durable-create', creation()), admission)
  assert.equal(b.calls.allocated, 2)
  await assert.rejects(b.rt.durableEndpoint('durable-create', creation({ prompts: ['Changed instructions'] })), /different task/)
})
test('all phase and model validation completes before session allocation', async t => {
  const b = await bench(t)
  for (const input of [creation({ prompts: ['valid', ''] }), creation({ prompts: [null] }), creation({ model: 'missing/model' }), creation({ agentId: 'missing' })]) {
    await assert.rejects(b.rt.durableEndpoint('durable-create', input))
  }
  assert.equal(b.calls.allocated, 0)
  assert.equal(b.calls.prompts.length, 0)
})
test('retrying a prepared creation reuses its persisted session allocation', async t => {
  const b = await bench(t)
  b.calls.modelFails = true
  await assert.rejects(b.rt.durableEndpoint('durable-create', creation({ prompts: ['One fixture'] })), /could not be selected/)
  assert.equal(b.calls.allocated, 1)
  assert.equal(b.calls.prompts.length, 0)
  const preparing = (await b.rt.durableEndpoint('durable-state', { key: 'created' })).jobs[0]
  assert.equal(preparing.state.status, 'preparing')
  await assert.rejects(b.rt.assertDurableSessionAvailable('allocated-1'), /unfinished/)
  b.calls.modelFails = false
  await b.rt.durableEndpoint('durable-create', { key: 'created' })
  await until(async () => (await stateOf(b.rt, 'created'))?.status === 'terminal')
  assert.equal(b.calls.allocated, 1)
  assert.equal(b.calls.prompts.length, 1)
})
test('saved enable preference opens the service and interactive enable needs no Host restart', async t => {
  const saved = await bench(t, { enabled: false, savedEnabled: true })
  assert.equal((await saved.rt.durableEndpoint('durable-state')).enabled, true)
  const interactive = await bench(t, { enabled: false })
  assert.equal((await interactive.rt.durableEndpoint('durable-state')).enabled, false)
  interactive.rt.state.prefs.durableTasks = true
  const admission = await interactive.rt.durableEndpoint('durable-create', creation({ prompts: ['One fixture'] }))
  assert.equal(Number.isSafeInteger(admission.taskId), true)
  await until(async () => (await stateOf(interactive.rt, 'created'))?.status === 'terminal')
})

test('disposal before saved preferences finish loading cannot open storage later', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsb-durable-dispose-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  let resolveLoad
  const load = new Promise(resolve => { resolveLoad = resolve })
  let cleanup
  const rt = { home, config: {}, state: { prefs: { durableTasks: true } },
    ctx: { effect(execute) { cleanup = execute() } },
    load: () => load, readOnly: () => undefined, warn() { assert.fail('normal startup disposal should be quiet') } }
  install(rt)
  await cleanup()
  resolveLoad()
  await delay(10)
  assert.deepEqual(await readdir(home), [])
})
