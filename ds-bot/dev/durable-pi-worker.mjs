// Pi's real SQLite/runtime in a separate process so the bench can kill it mid-phase.
import { basename, dirname, resolve } from 'node:path'
import { openDurableRuntime } from '../src/host/durable/runtime.js'

const database = process.argv[2] && resolve(process.argv[2])
if (process.env.DURABLE_DSH_TEST !== '1' || !database || !basename(dirname(database)).startsWith('.dsh-test-durable-')) {
  throw new Error('The durable Pi worker requires an isolated .dsh-test-durable-* database')
}
let sequence = 0
let closing = false
const pending = new Map()
const send = value => new Promise((done, reject) => {
  if (!process.connected) { reject(new Error('Bench disconnected')); return }
  process.send(value, error => error ? reject(error) : done())
})
const bridge = (action, input) => new Promise((resolve, reject) => {
  if (closing) { reject(new Error('Pi worker is closing')); return }
  const id = ++sequence
  const timer = setTimeout(() => {
    pending.delete(id)
    reject(new Error('DSH bridge timed out'))
  }, 45_000)
  pending.set(id, { resolve, reject, timer })
  void send({ type: 'bridge', id, action, input }).catch(error => {
    clearTimeout(timer)
    pending.delete(id)
    reject(error)
  })
})
const runtime = await openDurableRuntime({
  database,
  executor: { inspect: input => bridge('inspect', input), dispatch: input => bridge('run', input) },
  checkpoint: value => { if (process.connected) process.send({ type: 'checkpoint', ...value }) },
})

async function close() {
  if (closing) return
  closing = true
  try { await runtime.close() } finally {
    for (const { timer, reject } of pending.values()) {
      clearTimeout(timer)
      reject(new Error('Pi worker closed'))
    }
    pending.clear()
  }
}

process.on('message', message => {
  if (message.type === 'bridge-result') {
    const item = pending.get(message.id)
    if (item) {
      pending.delete(message.id)
      clearTimeout(item.timer)
      if (message.error) item.reject(new Error(message.error))
      else item.resolve(message.value)
    }
    return
  }
  void (async () => {
    let value
    switch (message.type) {
      case 'submit': value = await runtime.submit(message.input); break
      case 'get': value = await runtime.get(message.key); break
      case 'wait': value = await runtime.wait(message.key); break
      case 'shutdown':
        await close()
        await send({ type: 'reply', id: message.id })
        if (process.connected) process.disconnect()
        return
      default: throw new Error('Unknown Pi bench command')
    }
    await send({ type: 'reply', id: message.id, value })
  })().catch(error => { if (process.connected) void send({ type: 'reply', id: message.id, error: error.message }) })
})
process.once('disconnect', () => { void close() })
process.once('SIGTERM', () => { void close().finally(() => { if (process.connected) process.disconnect() }) })
await send({ type: 'ready' })
