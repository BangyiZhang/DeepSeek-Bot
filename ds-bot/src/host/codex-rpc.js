import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const failure = message => Object.assign(new Error(message), { code: 'CODEX_CLI' })

// A dedicated stdio server, never the user's shared daemon. Protocol traffic and
// stderr can contain conversation data or credentials and must not be logged.
export class CodexRpc {
  constructor(command, { args = ['app-server', '--listen', 'stdio://'], cwd } = {}) {
    this.pending = new Map()
    this.events = []
    this.nextId = 0
    this.child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32' })
    this.child.on('error', () => this.fail(failure('Could not start Codex CLI. Check its executable path.')))
    this.child.on('exit', () => this.fail(failure('Codex CLI exited before completing the request.')))
    this.child.stdin.on('error', () => this.fail(failure('The Codex CLI connection closed.')))
    this.lines = createInterface({ input: this.child.stdout })
    this.lines.on('line', (line) => {
      try {
        if (line.length > 16_000_000) throw failure('Oversized message')
        const message = JSON.parse(line)
        if (message.id !== undefined && message.method === undefined) {
          const pending = this.pending.get(message.id)
          if (!pending) return
          this.pending.delete(message.id)
          clearTimeout(pending.timer)
          if (message.error) pending.reject(failure('Codex CLI rejected the request. Check its login and configuration in a terminal.'))
          else pending.resolve(message.result)
        } else {
          this.events.push(message)
          this.wake?.()
        }
      } catch {
        this.fail(failure('Codex CLI returned an invalid protocol message. Update Codex CLI and try again.'))
      }
    })
  }

  fail(error) {
    this.error ??= error
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(this.error) }
    this.pending.clear()
    this.wake?.()
  }

  send(message) {
    if (this.error) throw this.error
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(failure('Codex CLI did not respond in time. Check it in a terminal.'))
      }, 30_000)
      this.pending.set(id, { resolve, reject, timer })
      try { this.send({ id, method, params }) } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'ds_bot_local_codex', title: 'DS Bot', version: '0.2.0' },
      capabilities: { experimentalApi: true },
    })
    this.send({ method: 'initialized' })
  }

  async next() {
    while (!this.error && this.events.length === 0) {
      await new Promise(resolve => { this.wake = resolve })
      this.wake = undefined
    }
    if (this.error) throw this.error
    return this.events.shift()
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.fail(failure('Codex CLI request was closed.'))
    this.lines.close()
    const kill = signal => {
      try {
        if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, signal)
        else this.child.kill(signal)
      } catch { /* The dedicated process may already have exited. */ }
    }
    kill('SIGTERM')
    const timer = setTimeout(() => { if (this.child.exitCode === null && this.child.signalCode === null) kill('SIGKILL') }, 2000)
    timer.unref()
  }
}
