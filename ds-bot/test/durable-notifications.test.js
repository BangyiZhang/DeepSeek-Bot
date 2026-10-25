import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openDurableRuntime } from '../src/host/durable/runtime.js'
import { createDurableNotifier, durableNotificationText } from '../src/host/durable/notifications.js'

const metadata = (over = {}) => ({
  key: 'chat-task', title: 'A saved deliverable', prompts: ['Check the fixture'], model: 'mock/model',
  origin: { botId: 'bot', sessionId: 'chat-original' },
  execution: { cwd: tmpdir(), permission: 'default', permissionSpec: '{}', instructions: 'Check facts.', allowedTools: ['read_file'] },
  ...over,
})

async function bench(t, { observeMs = 0 } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsb-durable-notifications-'))
  const configuration = { database: join(home, 'tasks.sqlite'), pollMs: 5,
    executor: { inspect: async () => ({ status: 'completed', result: 'The fixture is correct.' }), dispatch: async () => assert.fail('Unexpected execution') } }
  let tasks = await openDurableRuntime(configuration)
  const receipts = []
  const histories = new Map()
  const agents = new Map()
  const owners = new Map([['chat-original', 'bot'], ['chat-current', 'bot'], ['chat-next', 'bot']])
  const calls = { deliveries: 0, flushes: 0, warnings: 0 }
  let chat = 'chat-current'
  let present = true
  let readOnly
  let now = 0
  const rt = {
    ctx: { sessions: { flush: async () => { calls.flushes += 1 } } },
    readOnly: () => readOnly,
    botOf: id => present && id === 'bot' ? { id: 'bot', name: 'Fixture Bot' } : undefined,
    selfOf: id => owners.get(id),
    chatOf: () => chat,
    groupOwners: new Map(),
    warn: () => { calls.warnings += 1 },
    resolveAgent: async id => {
      if (!agents.has(id)) agents.set(id, { session: { id }, inbox: { nextStep: [], nextTurn: [] } })
      return agents.get(id)
    },
    async * eventsBackwards(id) { yield* [...(histories.get(id) ?? [])].reverse() },
    attachLong: async text => ({ text, files: [] }),
    deliver: async args => {
      calls.deliveries += 1
      receipts.push(args)
      const event = { type: 'user/message', data: { source: { kind: 'bot', role: args.role, exchangeId: args.exchangeId } } }
      histories.set(args.sessionId, [...(histories.get(args.sessionId) ?? []), event])
    },
  }
  const makeNotifier = () => createDurableNotifier({ rt, tasks, pollMs: 0, observeMs, now: () => now })
  let notifier = makeNotifier()
  const prepare = async (input = metadata(), submit = true) => {
    await tasks.prepareCreate(input)
    if (submit) {
      await tasks.submit({ key: input.key, steps: input.prompts.map((prompt, index) => ({ sessionId: `worker-${input.key}-${index}`, prompt })) })
      await tasks.wait(input.key)
    }
    return input
  }
  t.after(async () => { await notifier.close(); await tasks.close(); await rm(home, { recursive: true, force: true }) })
  return {
    rt, calls, receipts, histories, agents, owners, prepare,
    get tasks() { return tasks }, get notifier() { return notifier },
    chat: value => { chat = value }, present: value => { present = value }, readOnly: value => { readOnly = value },
    advance: milliseconds => { now += milliseconds },
    async reopen() {
      await notifier.close()
      await tasks.close()
      tasks = await openDurableRuntime(configuration)
      notifier = makeNotifier()
    },
  }
}

test('completed chat work reports once to the current Bot part and keeps its receipt on reopen', async t => {
  const b = await bench(t)
  await b.prepare()
  await Promise.all([b.notifier.poll(), b.notifier.poll()])
  assert.equal(b.calls.deliveries, 1)
  assert.equal(b.receipts[0].sessionId, 'chat-current')
  assert.equal(b.receipts[0].toId, 'bot')
  assert.equal(b.receipts[0].role, 'durable')
  assert.match(b.receipts[0].text, /Status: completed/)
  assert.match(b.receipts[0].text, /The fixture is correct/)
  assert.match(b.receipts[0].text, /Do not execute, recreate, retry, or delegate/)
  assert.equal((await b.tasks.getNotification('chat-task')).status, 'delivered')
  await b.reopen()
  b.chat('chat-next')
  await b.notifier.poll()
  assert.equal(b.calls.deliveries, 1)
})

test('an attempted callback reconciles its saved old part after the Bot rolls over', async t => {
  const b = await bench(t)
  await b.prepare()
  const receipt = { sessionId: 'chat-current', exchangeId: 'stable-terminal-receipt' }
  await b.tasks.beginNotification('chat-task', receipt)
  b.histories.set(receipt.sessionId, [{ type: 'user/message', data: { source: { kind: 'bot', role: 'durable', exchangeId: receipt.exchangeId } } }])
  await b.reopen()
  b.chat('chat-next')
  await b.notifier.poll()
  assert.equal(b.calls.deliveries, 0)
  assert.equal((await b.tasks.getNotification('chat-task')).status, 'delivered')
  assert.ok(b.calls.flushes > 0)
})

test('an attempted callback with no admission proof is never blindly repeated', async t => {
  const b = await bench(t)
  await b.prepare()
  await b.tasks.beginNotification('chat-task', { sessionId: 'chat-original', exchangeId: 'uncertain-terminal-receipt' })
  await b.reopen()
  await b.notifier.poll()
  assert.equal((await b.tasks.getNotification('chat-task')).status, 'needs_reconciliation')
  assert.equal(b.calls.deliveries, 0)
  await b.reopen()
  await b.notifier.poll()
  assert.equal(b.calls.deliveries, 0)
  assert.equal((await b.tasks.get('chat-task')).state.outcome.status, 'completed')
})

test('a flush error after admission retains a queued receipt until the Bot consumes it', async t => {
  const b = await bench(t)
  await b.prepare()
  b.rt.deliver = async args => {
    b.calls.deliveries += 1
    const agent = await b.rt.resolveAgent(args.sessionId)
    agent.inbox.nextTurn.push({ source: { kind: 'bot', role: 'durable', exchangeId: args.exchangeId } })
    throw new Error('Injected flush failure')
  }
  await b.notifier.poll()
  assert.equal(b.calls.deliveries, 1)
  assert.equal(b.calls.flushes, 1)
  assert.equal((await b.tasks.getNotification('chat-task')).status, 'queued')
  await b.reopen()
  await b.notifier.poll()
  assert.equal(b.calls.deliveries, 1)
  const notification = await b.tasks.getNotification('chat-task')
  const agent = await b.rt.resolveAgent(notification.sessionId)
  const [message] = agent.inbox.nextTurn.splice(0)
  b.histories.set(notification.sessionId, [{ type: 'user/message', data: message }])
  await b.notifier.poll()
  assert.equal((await b.tasks.getNotification('chat-task')).status, 'delivered')
  assert.equal(b.calls.deliveries, 1)
})

test('a clean restart that drops an unconsumed callback exposes review after a bounded observation', async t => {
  const b = await bench(t, { observeMs: 50 })
  await b.prepare()
  b.rt.deliver = async args => {
    b.calls.deliveries += 1
    const agent = await b.rt.resolveAgent(args.sessionId)
    agent.inbox.nextTurn.push({ source: { kind: 'bot', role: 'durable', exchangeId: args.exchangeId } })
  }
  await b.notifier.poll()
  assert.equal((await b.tasks.getNotification('chat-task')).status, 'queued')
  const agent = await b.rt.resolveAgent('chat-current')
  agent.inbox.nextTurn.splice(0)
  await b.reopen()
  await b.notifier.poll()
  assert.equal((await b.tasks.getNotification('chat-task')).status, 'queued')
  b.advance(49)
  await b.notifier.poll()
  assert.equal((await b.tasks.getNotification('chat-task')).status, 'queued')
  b.advance(1)
  await b.notifier.poll()
  assert.equal((await b.tasks.getNotification('chat-task')).status, 'needs_reconciliation')
  assert.equal((await b.tasks.get('chat-task')).state.outcome.result[0], 'The fixture is correct.')
  await b.reopen()
  await b.notifier.poll()
  assert.equal(b.calls.deliveries, 1)
})

test('the inbox claim gap can commit its receipt before the observation deadline', async t => {
  const b = await bench(t, { observeMs: 50 })
  await b.prepare()
  b.rt.deliver = async () => { b.calls.deliveries += 1 }
  await b.notifier.poll()
  assert.equal((await b.tasks.getNotification('chat-task')).status, 'attempting')
  b.advance(49)
  await b.notifier.poll()
  assert.equal((await b.tasks.getNotification('chat-task')).status, 'attempting')
  const notification = await b.tasks.getNotification('chat-task')
  b.histories.set(notification.sessionId, [{ type: 'user/message', data: { source: { kind: 'bot', role: 'durable', exchangeId: notification.exchangeId } } }])
  await b.notifier.poll()
  assert.equal((await b.tasks.getNotification('chat-task')).status, 'delivered')
  assert.equal(b.calls.deliveries, 1)
})

test('an unavailable result attachment is visible and is not retried indefinitely', async t => {
  const b = await bench(t)
  await b.prepare()
  let attachments = 0
  b.rt.attachLong = async () => { attachments += 1; return undefined }
  await b.notifier.poll()
  assert.equal((await b.tasks.getNotification('chat-task')).status, 'unavailable')
  assert.equal(b.calls.deliveries, 0)
  assert.equal(attachments, 1)
  await b.reopen()
  await b.notifier.poll()
  assert.equal(attachments, 1)
  assert.equal((await b.tasks.get('chat-task')).state.outcome.result[0], 'The fixture is correct.')
})

test('failure before admission keeps the saved outcome and exposes uncertain reporting', async t => {
  const b = await bench(t)
  await b.prepare()
  b.rt.deliver = async () => { b.calls.deliveries += 1; throw new Error('Injected admission failure') }
  await b.notifier.poll()
  assert.equal((await b.tasks.getNotification('chat-task')).status, 'needs_reconciliation')
  assert.equal((await b.tasks.get('chat-task')).state.outcome.result[0], 'The fixture is correct.')
  await b.notifier.poll()
  assert.equal(b.calls.deliveries, 1)
})

test('removed Bots and unsupported group origins cannot redirect a result into a private chat', async t => {
  const b = await bench(t)
  await b.prepare()
  b.present(false)
  await b.notifier.poll()
  assert.equal((await b.tasks.getNotification('chat-task')).status, 'unavailable')
  b.present(true)
  await b.prepare(metadata({ key: 'group-task', origin: { botId: 'bot', sessionId: 'member-chat', roomId: 'private-group' } }))
  await b.notifier.poll()
  assert.equal((await b.tasks.getNotification('group-task')).status, 'unavailable')
  assert.equal(b.calls.deliveries, 0)
})

test('read-only and preparing tasks produce no callback or receipt', async t => {
  const b = await bench(t)
  await b.prepare(metadata({ key: 'preparing' }), false)
  await b.prepare()
  b.readOnly('Read-only fixture')
  await b.notifier.poll()
  assert.equal(b.calls.deliveries, 0)
  assert.equal(await b.tasks.getNotification('chat-task'), undefined)
  b.readOnly(undefined)
  await b.notifier.poll()
  assert.equal(b.calls.deliveries, 1)
  assert.equal(await b.tasks.getNotification('preparing'), undefined)
})

test('shutdown while preparing an attachment prevents callback admission', async t => {
  const b = await bench(t)
  await b.prepare()
  let started
  let release
  const attaching = new Promise(resolve => { started = resolve })
  b.rt.attachLong = text => new Promise(resolve => { release = () => resolve({ text, files: [] }); started() })
  const pending = b.notifier.poll()
  await attaching
  const closing = b.notifier.close()
  release()
  await Promise.all([pending, closing])
  assert.equal(b.calls.deliveries, 0)
  assert.equal(await b.tasks.getNotification('chat-task'), undefined)
})

test('failure reporting preserves prior outputs and does not imply task completion', () => {
  const text = durableNotificationText(metadata({ prompts: ['First', 'Second'] }), {
    state: { status: 'terminal', outcome: { status: 'failed', error: { code: 'NEEDS_RECONCILIATION', completed: 1, results: ['First saved result'] } } },
  })
  assert.match(text, /Status: needs reconciliation/)
  assert.match(text, /Saved stages: 1\/2/)
  assert.match(text, /First saved result/)
  assert.match(text, /Review the task before repeating any action/)
})

test('origin and bounded execution context are immutable, validated, and persisted', async t => {
  const b = await bench(t)
  const original = metadata()
  await b.prepare(original, false)
  original.execution.instructions = 'Changed outside the ledger'
  await b.reopen()
  assert.equal((await b.tasks.getCreate('chat-task')).execution.instructions, 'Check facts.')
  await assert.rejects(b.tasks.prepareCreate(metadata({ origin: { botId: 'another-bot', sessionId: 'chat-original' } })), /different task/)
  await assert.rejects(b.tasks.prepareCreate(metadata({ execution: { ...metadata().execution, permissionSpec: '{"broader":true}' } })), /different task/)
  for (const extra of [
    { origin: { botId: 'bot' } },
    { origin: { ...metadata().origin, unexpected: true } },
    { execution: { ...metadata().execution, cwd: 'relative' } },
    { execution: { ...metadata().execution, permissionSpec: 'x'.repeat(4097) } },
    { execution: { ...metadata().execution, instructions: 'x'.repeat(16001) } },
    { execution: { ...metadata().execution, allowedTools: ['read_file', 'read_file'] } },
    { execution: { ...metadata().execution, allowedTools: ['x'.repeat(257)] } },
  ]) await assert.rejects(b.tasks.prepareCreate(metadata({ key: 'bad-context', ...extra })), /Invalid durable/)
})

test('notification admission is atomic and delivered receipts cannot be reopened', async t => {
  const b = await bench(t)
  await b.prepare()
  const receipts = await Promise.all(['one', 'two'].map(exchangeId => b.tasks.beginNotification('chat-task', { sessionId: 'chat-current', exchangeId })))
  assert.equal(receipts.filter(receipt => receipt.started).length, 1)
  assert.equal(receipts[0].notification.exchangeId, receipts[1].notification.exchangeId)
  const exchangeId = receipts[0].notification.exchangeId
  await assert.rejects(b.tasks.settleNotification('chat-task', { exchangeId: 'wrong', status: 'delivered' }), /Unknown/)
  await b.tasks.settleNotification('chat-task', { exchangeId, status: 'delivered' })
  await assert.rejects(b.tasks.settleNotification('chat-task', { exchangeId, status: 'needs_reconciliation' }), /cannot be reopened/)
  await assert.rejects(b.tasks.settleNotification('chat-task', { exchangeId, status: 'queued' }), /cannot be reopened/)
})
