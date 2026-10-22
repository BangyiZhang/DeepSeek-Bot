import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/local-cli-progress.js'

function runtime() {
  const listeners = {}
  let cleanup
  let notices = 0
  const rt = { live: new Map([['a', { since: Date.now() - 10_000 }]]),
    notifyLive: () => notices++,
    ctx: { on: (name, listener) => { listeners[name] = listener }, effect: make => { cleanup = make() } },
  }
  install(rt)
  return { rt, listeners, cleanup: () => cleanup(), notices: () => notices }
}

test('CLI progress appears before the first model chunk, preserves turn time and finishes', () => {
  const { rt, notices } = runtime()
  const update = rt.beginCliProgress('local-antigravity', { sessionId: 'a' })
  assert.equal(rt.cliProgressView().a.phase, 'starting')
  assert.equal(rt.cliProgressView().a.startedAt, rt.live.get('a').since)
  update('waiting')
  update('waiting')
  update('done')
  assert.equal(notices(), 3)
  assert.equal(rt.cliProgressView().a.active, false)
  assert.ok(rt.cliProgressView().a.elapsedMs >= 10_000)
})

test('independent CLI requests isolate progress and ignore late updates from superseded runs', () => {
  const { rt } = runtime()
  const old = rt.beginCliProgress('local-codex', { sessionId: 'a' })
  const current = rt.beginCliProgress('local-antigravity', { sessionId: 'a' })
  const other = rt.beginCliProgress('local-codex', { sessionId: 'b' })
  old('error')
  current('responding')
  other('aborted')
  assert.equal(rt.cliProgressView().a.phase, 'responding')
  assert.equal(rt.cliProgressView().b.phase, 'aborted')
})

test('background model calls and arbitrary diagnostic text never enter CLI progress', () => {
  const { rt, cleanup } = runtime()
  rt.beginCliProgress('local-codex', { sessionId: 'a', purpose: 'summary' })('done')
  assert.deepEqual(rt.cliProgressView(), {})
  rt.beginCliProgress('local-codex', {})('done')
  const update = rt.beginCliProgress('local-codex', { sessionId: 'a' })
  update('private diagnostic with credentials')
  assert.equal(rt.cliProgressView().a.phase, 'starting')
  cleanup()
  assert.deepEqual(rt.cliProgressView(), {})
})

test('the next turn clears the prior completion and ignores stale callbacks', () => {
  const { rt, listeners } = runtime()
  const update = rt.beginCliProgress('local-codex', { sessionId: 'a' })
  update('done')
  listeners['session/event']({ id: 'a' }, { type: 'turn/start' })
  update('responding')
  assert.deepEqual(rt.cliProgressView(), {})
})

test('a tool handoff keeps elapsed time when the next CLI invocation starts', () => {
  const { rt } = runtime()
  rt.live.clear()
  const update = rt.beginCliProgress('local-antigravity', { sessionId: 'a' })
  const first = rt.cliProgressView().a.startedAt
  update('tools')
  rt.beginCliProgress('local-antigravity', { sessionId: 'a' })
  assert.equal(rt.cliProgressView().a.startedAt, first)
})
