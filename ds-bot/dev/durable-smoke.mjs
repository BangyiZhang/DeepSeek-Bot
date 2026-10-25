// Run with the project's Node >=22.19 after npm ci in ds-bot and app.
// Real Pi Durable -> public DSH -> loopback mock, with deliberate process crashes.
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const root = resolve(import.meta.dirname, '../..')
const home = resolve(root, `.dsh-test-durable-prototype-${Date.now()}`)
const database = resolve(home, 'workflow.sqlite')
mkdirSync(home, { recursive: true })
const children = []
let dsh
let ds
let pi
let pc

function launch(file, args, env, label) {
  const out = openSync(resolve(home, `${label}.out`), 'a')
  const err = openSync(resolve(home, `${label}.err`), 'a')
  let child
  try {
    child = fork(resolve(root, file), args, {
      cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', out, err, 'ipc'],
    })
  } finally { closeSync(out); closeSync(err) }
  children.push(child)
  return child
}

function rpc(child) {
  let sequence = 0
  const pending = new Map()
  const fail = error => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error) }
    pending.clear()
  }
  child.on('error', fail)
  child.on('exit', () => fail(new Error('Worker exited')))
  child.on('message', message => {
    const item = pending.get(message.id)
    if (!item) return
    if (message.type === 'error' || (message.type === 'reply' && message.error)) {
      pending.delete(message.id); clearTimeout(item.timer)
      item.reject(new Error(message.message ?? message.error))
    } else if (message.type === item.expected) {
      pending.delete(message.id); clearTimeout(item.timer)
      item.resolve(message.type === 'reply' ? message.value : message)
    }
  })
  return (type, input = {}, expected = 'reply') => new Promise((resolve, reject) => {
    if (!child.connected) { reject(new Error('Worker disconnected')); return }
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${type} timed out`)) }, 60_000)
    pending.set(id, { resolve, reject, expected, timer })
    child.send({ type, id, ...input }, error => {
      if (!error) return
      clearTimeout(timer); pending.delete(id); reject(error)
    })
  })
}

function ready(child) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exited); child.off('error', errored) }
    const message = value => { if (value.type === 'ready') { cleanup(); resolve() } }
    const exited = () => { cleanup(); reject(new Error('Worker exited during startup')) }
    const errored = error => { cleanup(); reject(error) }
    const timer = setTimeout(() => { cleanup(); reject(new Error('Startup timed out')) }, 60_000)
    child.on('message', message); child.once('exit', exited); child.once('error', errored)
  })
}

async function stop(child, hard = false) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise(resolve => {
    const finish = () => { clearTimeout(timer); child.off('exit', finish); resolve() }
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    child.once('exit', finish)
    if (hard || !child.connected) child.kill('SIGKILL')
    else child.send({ type: 'shutdown', id: 999999 }, error => { if (error) child.kill('SIGKILL') })
  })
}

const newPort = () => new Promise((resolve, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)) })
})
async function waitPort(port, child) {
  const until = Date.now() + 15_000
  while (Date.now() < until) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Mock model exited')
    if (await new Promise(resolve => {
      const socket = createConnection({ port, host: '127.0.0.1' })
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => { socket.destroy(); resolve(false) })
    })) return
    await delay(100)
  }
  throw new Error('Mock model startup timed out')
}

let port
async function startDsh() {
  dsh = launch('ds-bot/dev/durable-dsh-worker.mjs', [], {
    DSH_HOME: home, DURABLE_DSH_TEST: '1',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/v1`, DEEPSEEK_API_KEY: 'mock-key',
  }, 'dsh')
  ds = rpc(dsh)
  await ready(dsh)
}
async function startPi(hooks = {}) {
  pi = launch('ds-bot/dev/durable-pi-worker.mjs', [database], { DURABLE_DSH_TEST: '1' }, 'pi')
  pc = rpc(pi)
  const target = pi
  target.on('message', message => {
    void (async () => {
      if (message.type === 'checkpoint') { hooks.checkpoint?.(message, target); return }
      if (message.type !== 'bridge') return
      try {
        const receipt = ds(message.action, message.input, message.action === 'run' ? 'ack' : 'inspection')
        // A crash hook may end the DSH worker before its acknowledgement arrives.
        void receipt.catch(() => {})
        if (message.action === 'run' && hooks.dispatching && await hooks.dispatching(message, target) === false) return
        const value = await receipt
        if (message.action === 'run' && hooks.dispatched && await hooks.dispatched(message, target) === false) return
        if (target.connected) target.send({ type: 'bridge-result', id: message.id, value }, () => {})
      } catch (error) {
        if (target.connected) target.send({ type: 'bridge-result', id: message.id, error: error.message }, () => {})
      }
    })().catch(error => { console.error(error.message); target.kill('SIGKILL') })
  })
  await ready(pi)
}
const create = async () => (await ds('create', {}, 'created')).sessionId
const request = (key, sessions) => ({ key, steps: sessions.map((sessionId, index) => ({ sessionId, prompt: `Durable integration ${key} stage ${index + 1}` })) })
const boundary = () => {
  let resolve
  let reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}
async function waitBoundary(signal) {
  let timer
  try { await Promise.race([signal.promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Crash boundary timed out')), 60_000) })]) }
  finally { clearTimeout(timer) }
}

try {
  port = await newPort()
  const mock = launch('ds-bot/dev/mock-llm.mjs', [home], {
    MOCK_PORT: String(port), MOCK_DELAY_MS: '1500', MOCK_LOG: resolve(home, 'mock.jsonl'),
  }, 'mock')
  await waitPort(port, mock)
  await startDsh(); await startPi()
  const session = await create()
  const input = request('basic', [session])
  const admission = await pc('submit', { input })
  const outcome = await pc('wait', { key: input.key })
  assert.equal(outcome.state.outcome.status, 'completed', outcome.state.outcome.error?.message)
  assert.match(outcome.state.outcome.result[0], /Durable result basic:0:/)
  assert.equal((await pc('submit', { input })).taskId, admission.taskId)
  await assert.rejects(pc('submit', { input: { ...input, steps: [{ sessionId: session, prompt: 'different' }] } }), /different input/)
  console.log('PASS: Pi task -> public DSH -> mock -> persisted result; idempotent submit and conflict rejection')

  await stop(pi)
  const accepted = boundary()
  await startPi({ dispatched: (_message, target) => { target.kill('SIGKILL'); accepted.resolve(); return false } })
  const crashSession = await create()
  await pc('submit', { input: request('crash', [crashSession]) })
  await waitBoundary(accepted); await stop(pi, true); await startPi()
  const recovered = await pc('wait', { key: 'crash' })
  assert.equal(recovered.state.outcome.status, 'completed')
  assert.match(recovered.state.outcome.result[0], /Durable result crash:0:/)
  assert.equal((await ds('inspect', { sessionId: crashSession, requestId: 'crash:0' }, 'inspection')).inputs, 1)
  console.log('PASS: Pi SIGKILL after DSH admission; original execution recovered and one input observed')

  await stop(pi)
  const committed = boundary()
  await startPi({ checkpoint: (message, target) => {
    if (message.key === 'stages' && message.completed === 1) { target.kill('SIGKILL'); committed.resolve() }
  } })
  const sessions = [await create(), await create()]
  await pc('submit', { input: request('stages', sessions) })
  await waitBoundary(committed); await stop(pi, true); await stop(dsh); await startDsh(); await startPi()
  const resumed = await pc('wait', { key: 'stages' })
  assert.equal(resumed.state.outcome.status, 'completed')
  assert.equal(resumed.state.outcome.result.length, 2)
  for (let index = 0; index < 2; index += 1) {
    assert.match(resumed.state.outcome.result[index], new RegExp(`Durable result stages:${index}:`))
    assert.equal((await ds('inspect', { sessionId: sessions[index], requestId: `stages:${index}` }, 'inspection')).inputs, 1)
  }
  console.log('PASS: Pi and DSH restart at committed boundary; completed stage retained, remaining stage executes once')

  await stop(pi)
  const interrupted = boundary()
  await startPi({ dispatching: async (message, target) => {
    if (message.input.requestId !== 'interrupted:0') return
    try {
      const until = Date.now() + 15_000
      let inspection
      while (Date.now() < until) {
        inspection = await ds('inspect', message.input, 'inspection')
        if (inspection.status === 'running' && inspection.inputs === 1) break
        if (inspection.status === 'completed' || (inspection.status === 'interrupted' && inspection.endReason)) {
          throw new Error(`DSH interruption boundary was ${inspection.status} (${inspection.reason ?? inspection.endReason ?? 'no reason'})`)
        }
        await delay(25)
      }
      assert.ok(inspection?.status === 'running' && inspection.inputs === 1,
        `DSH never reached the interruption boundary (${inspection?.status}; ${inspection?.reason ?? 'no reason'}; inputs=${inspection?.inputs ?? 0})`)
      await stop(target, true)
      await stop(dsh, true)
      await startDsh()
      interrupted.resolve()
      return false
    } catch (error) {
      console.error(`DSH interruption boundary failed: ${error.message}`)
      interrupted.reject(error)
      throw error
    }
  } })
  const interruptedSession = await create()
  await pc('submit', { input: request('interrupted', [interruptedSession]) })
  await waitBoundary(interrupted)
  await stop(pi, true)
  await startPi()
  const blocked = await pc('wait', { key: 'interrupted' })
  assert.equal(blocked.state.outcome.status, 'failed')
  assert.equal(blocked.state.outcome.error.code, 'NEEDS_RECONCILIATION')
  assert.equal((await ds('inspect', { sessionId: interruptedSession, requestId: 'interrupted:0' }, 'inspection')).inputs, 1)
  console.log('PASS: DSH mid-turn SIGKILL requires reconciliation without automatically repeating input')
  console.log('Durable integration smoke passed')
} finally {
  for (const child of children.toReversed()) await stop(child)
}
