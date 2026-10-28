import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/approvals.js'

test('a hidden durable worker approval is answered from its owning Bot, and cancellation settles it', async () => {
  let listener
  const rt = { ctx: { on: (_event, fn) => { listener = fn } }, groupOwners: new Map(), chatOwners: new Map(),
    durableOwnerOf: id => id === 'worker' ? { botId: 'chief' } : undefined }
  install(rt)
  const request = { agent: { id: 'worker' }, toolName: 'bash', reason: 'Needs approval' }
  const pending = listener(request, () => assert.fail('Native card is invisible in this session'))
  const approval = rt.approvalsView()[0]
  assert.equal(approval.botId, 'chief')
  assert.equal(approval.durable, true)
  assert.equal(approval.answerable, true)
  rt.answerApproval(approval.id, 'allow')
  assert.equal(await pending, 'allowed-once')
  assert.deepEqual(rt.approvalsView(), [])
  await assert.rejects(async () => rt.answerApproval(approval.id, 'allow'), /no longer open/)
  const abort = new AbortController()
  const cancelled = listener({ ...request, signal: abort.signal }, () => assert.fail())
  abort.abort()
  assert.equal(await cancelled, 'cancelled')
  assert.deepEqual(rt.approvalsView(), [])
})
