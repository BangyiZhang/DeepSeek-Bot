// Exercise the normal plugin smoke flow through the app's documented profile boot.
import { fork, spawn } from 'node:child_process'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const name = `desktop-smoke-${randomUUID().slice(0, 8)}`
const home = join(root, `.dsh-test-${name}`)
const freePort = () => new Promise((done, reject) => {
  const server = createServer(); server.once('error', reject)
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => done(port)) })
})
const port = await freePort(), mockPort = await freePort()
const env = Object.fromEntries(['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
await mkdir(join(home, 'profiles', 'ds-bot'), { recursive: true })
await writeFile(join(home, 'profiles', 'ds-bot', 'cordis.patch.yml'), '- id: bot\n  config:\n    localCodex: false\n    localAntigravity: false\n    diagnosticsFile: false\n    updateCheck: false\n    checkRatio: 0.45\n- id: llm-deepseek\n  config:\n    models:\n      - { id: deepseek-flash, contextWindow: 100000, maxTokens: 8000, inputModalities: [text, image] }\n      - { id: deepseek-v4-pro, contextWindow: 100000, maxTokens: 8000 }\n')
const log = await open(join(home, 'process.log'), 'a', 0o600)
const stdio = ['ignore', log.fd, log.fd, 'ipc']
const mock = fork(join(root, 'ds-bot/dev/mock-llm.mjs'), [], { env: { ...env, MOCK_PORT: String(mockPort), MOCK_DELAY_MS: '300', MOCK_LOG: join(home, 'mock.jsonl') }, stdio })
let host
try {
  // Do not race profile boot against binding the mock's socket.
  for (let n = 0; n < 100; n++) {
    try { await fetch(`http://127.0.0.1:${mockPort}/`); break } catch { await new Promise(done => setTimeout(done, 100)) }
  }
  host = fork(join(root, 'app/src/host.mjs'), [], { cwd: root, env: { ...env, DSH_HOME: home, DS_BOT_PORT: String(port), DEEPSEEK_BASE_URL: `http://127.0.0.1:${mockPort}/v1`, DEEPSEEK_API_KEY: 'mock-key' }, stdio })
  const ready = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`Smoke Host timeout: ${home}`)), 60000)
    host.on('message', message => {
      if (message.type === 'ready') { clearTimeout(timer); done(message) }
      if (message.type === 'fatal') { clearTimeout(timer); reject(new Error(`Smoke Host failed: ${home}`)) }
    })
    host.once('exit', () => { clearTimeout(timer); reject(new Error('Smoke Host exited')) })
  })
  await writeFile(join(home, 'web.log'), `dsh web: ${ready.url}\n`, { mode: 0o600 })
  const code = await new Promise((done, reject) => {
    const child = spawn(process.execPath, ['ds-bot/dev/smoke.mjs', name, String(port)], { cwd: root, env, stdio: 'inherit' })
    child.once('error', reject); child.once('exit', done)
  })
  if (code !== 0) throw new Error(`Smoke failed: ${home}`)
} finally {
  if (host?.connected) host.send({ type: 'shutdown' })
  for (const child of [host, mock]) {
    if (!child || child.exitCode !== null || child.signalCode !== null) continue
    if (child === mock) child.kill('SIGTERM')
    await new Promise(done => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); done() }, 15000)
      child.once('exit', () => { clearTimeout(timer); done() })
    })
  }
  await log.close()
}
