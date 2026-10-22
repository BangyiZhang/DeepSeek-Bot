import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const failure = message => Object.assign(new Error(message), { code: 'ANTIGRAVITY_CLI' })

// Prompts travel on stdin; neither the process list nor diagnostic logs receive
// conversation contents. One closed input pipe is exactly one fresh CLI turn.
export class AntigravityRun {
  constructor(command, { cwd, schema, args, onProgress = () => {} } = {}) {
    this.result = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject })
    this.result.catch(() => {})
    this.child = spawn(command, args ?? [
      '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--json-schema', JSON.stringify(schema), '--mode', 'plan', '--sandbox', '--disable-slash-commands',
    ], { cwd, stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32' })
    this.child.on('error', () => this.reject(failure('Could not start Antigravity CLI. Check the agy executable path.')))
    this.child.stdin.on('error', () => this.reject(failure('The Antigravity CLI input connection closed.')))
    this.lines = createInterface({ input: this.child.stdout })
    let bytes = 0
    this.child.stdout.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > 32_000_000) { this.reject(failure('Antigravity CLI response exceeded the size limit.')); void this.close() }
    })
    this.lines.on('line', (line) => {
      try {
        const event = JSON.parse(line)
        const step = event.step_update
        // AGY enforces --json-schema with its internal finish tool. It is part
        // of producing the final result, not a request to execute a native action.
        const names = [step?.tool_name, step?.tool_info?.name].filter(name => name !== undefined)
        const schemaFinish = names.length > 0 && names.every(name => name === 'finish')
        if (event.event === 'init') onProgress('waiting')
        if (event.event === 'step_update' && step?.step_type === 'agent_response') onProgress('responding')
        if (schemaFinish || (event.event === 'step_update' && step?.step_type === 'finish')) onProgress('validating')
        if (event.event === 'step_update' && (step?.subagent_info || (step?.step_type === 'tool' && !schemaFinish))) {
          this.reject(failure('Antigravity CLI attempted a native tool. Use the tools provided by DS Bot instead.'))
          void this.close()
          return
        }
        if (event.event !== 'result') return
        if (this.value) throw new Error('Duplicate result')
        this.value = event.result
      } catch {
        this.reject(failure('Antigravity CLI returned an invalid response. Update agy and try again.'))
        void this.close()
      }
    })
    this.exited = new Promise((resolve) => {
      this.child.once('close', (code) => {
        this.lines.close()
        if (code !== 0 || this.value?.status !== 'SUCCESS') {
          const location = typeof this.value?.error === 'string' && /user location is not supported/i.test(this.value.error)
          this.reject(failure(location
            ? 'Antigravity CLI is unavailable for your current user location. Check agy in a terminal.'
            : 'Antigravity CLI did not complete the request. Check its login, model and configuration by running agy in a terminal.'))
        } else this.resolve(this.value)
        resolve()
      })
    })
  }

  run(prompt) {
    this.child.stdin.end(`${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`)
    return this.result
  }

  close() {
    if (this.stopping) return this.stopping
    this.reject(failure('Antigravity CLI request stopped.'))
    const kill = signal => {
      try {
        if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, signal)
        else this.child.kill(signal)
      } catch { /* This request's process group may already have exited. */ }
    }
    if (this.child.exitCode === null && this.child.signalCode === null) kill('SIGTERM')
    this.stopping = new Promise((resolve) => {
      const timer = setTimeout(() => { kill('SIGKILL') }, 2000)
      this.exited.then(() => { clearTimeout(timer); resolve() })
    })
    return this.stopping
  }
}
