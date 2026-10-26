import { randomUUID } from 'node:crypto'

// A private shell/Host channel; it never exposes the Host launch URL to a tool.
export function createRpc(channel, handler, timeout = 30000) {
  let closed = false
  const pending = new Map()
  const prefix = 'ds-bot:local-update:'
  const send = message => new Promise((resolve, reject) => {
    if (closed || !channel.connected) return reject(new Error('Desktop update channel is closed'))
    channel.send(message, error => error ? reject(error) : resolve())
  })
  const receive = message => {
    if (message?.type === `${prefix}response`) {
      const wait = pending.get(message.id)
      if (!wait) return
      pending.delete(message.id); clearTimeout(wait.timer)
      if (message.error) wait.reject(new Error(message.error)); else wait.resolve(message.value)
    } else if (message?.type === `${prefix}request` && handler) {
      void Promise.resolve().then(() => handler(message.op, message.body)).then(
        value => send({ type: `${prefix}response`, id: message.id, value }),
        error => send({ type: `${prefix}response`, id: message.id, error: error.message }),
      ).catch(() => {})
    }
  }
  const close = () => {
    closed = true
    channel.off('message', receive); channel.off('disconnect', close)
    for (const wait of pending.values()) { clearTimeout(wait.timer); wait.reject(new Error('Desktop update channel closed')) }
    pending.clear()
  }
  channel.on('message', receive); channel.once('disconnect', close)
  return { close, request(op, body = {}) {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Desktop update request timed out')) }, timeout)
      pending.set(id, { resolve, reject, timer })
      void send({ type: `${prefix}request`, id, op, body }).catch(error => {
        clearTimeout(timer); pending.delete(id); reject(error)
      })
    })
  } }
}
