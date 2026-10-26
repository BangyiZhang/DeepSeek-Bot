// Real macOS restart acceptance. Only a throwaway app, profile and loopback mock are used.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { cp, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { cleanEnvironment } from '../src/local-update/install.mjs'
import { alive, json } from '../src/local-update/files.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const report = await json(resolve(process.argv[2]))
const folder = await realpath(await mkdtemp(join(tmpdir(), '.dsh-test-local-update-')))
const target = join(folder, 'DeepSeek Bot.app'), home = join(folder, 'home'), shell = join(folder, 'shell')
await mkdir(join(home, 'profiles/ds-bot'), { recursive: true })
await mkdir(join(folder, 'workspace'))
await mkdir(shell)
await writeFile(join(home, 'profiles/ds-bot/cordis.patch.yml'), '- id: bot\n  config:\n    localCodex: false\n    localAntigravity: false\n    updateCheck: false\n    diagnosticsFile: false\n')
await cp(report.appPath, target, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
const log = await open(join(folder, 'process.log'), 'a', 0o600)
const env = cleanEnvironment(process.env)
const mock = spawn(process.execPath, [join(root, 'ds-bot/dev/mock-llm.mjs')], { env: { ...env, MOCK_PORT: '0', MOCK_LOG: join(folder, 'mock.jsonl') }, stdio: ['ignore', 'pipe', log.fd] })
let original, replacementPid, workerPid, socket
const until = async (check, label, ms = 180000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { const result = await check(); if (result) return result; await sleep(250) }
  throw new Error(`Timed out: ${label}; isolated evidence: ${folder}`)
}
try {
  let output = ''
  mock.stdout.on('data', chunk => { output += chunk })
  const modelUrl = await until(() => /http:\/\/127\.0\.0\.1:\d+\/v1/u.exec(output)?.[0], 'mock socket')
  const port = await new Promise(done => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const n = server.address().port; server.close(() => done(n)) }) })
  original = spawn(join(target, 'Contents/MacOS/DeepSeek Bot'), [`--remote-debugging-port=${port}`], {
    env: { ...env, DS_BOT_HOME: home, DS_BOT_SHELL_DATA: shell, DS_BOT_WORKSPACE: join(folder, 'workspace'), DS_BOT_LOCAL_UPDATE_TEST: '1', DEEPSEEK_BASE_URL: modelUrl, DEEPSEEK_API_KEY: 'mock-key' }, stdio: ['ignore', log.fd, log.fd],
  })
  const page = await until(async () => {
    try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(page => page.type === 'page' && page.url.startsWith('http://127.0.0.1:')) } catch { return null }
  }, 'initial app page')
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((done, reject) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  const pending = new Map(); let sequence = 0
  socket.addEventListener('message', event => {
    const response = JSON.parse(String(event.data)), wait = pending.get(response.id)
    if (!wait) return
    clearTimeout(wait.timer); pending.delete(response.id)
    if (response.error || response.result?.exceptionDetails) wait.reject(new Error('Isolated page command failed'))
    else wait.resolve(response.result)
  })
  const call = (method, params = {}) => new Promise((done, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('Isolated CDP timeout')) }, 30000)
    pending.set(id, { resolve: done, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value
  await until(() => evaluate("Boolean(document.querySelector('.bt-tile'))"), 'team UI')
  const api = async (endpoint, payload = {}) => evaluate(`fetch('/api/bot', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(${JSON.stringify({ endpoint, payload })})}).then(r=>r.json())`)
  const state = (await api('state')).value, botId = state.mainBotId
  await evaluate(`document.querySelector('[data-bot-id="${botId}"]').click()`)
  await evaluate("[...document.querySelectorAll('[role=dialog] button')].find(node => /^(Continue|继续)$/u.test(node.textContent.trim()))?.click()")
  await until(() => evaluate("Boolean(document.querySelector('.bt-model-chip:not(.bt-model-chip-quiet)'))"), 'model picker')
  await evaluate("document.querySelector('.bt-model-chip:not(.bt-model-chip-quiet)').click()")
  await until(() => evaluate("document.body.innerText.includes('先让团队帮你做哪块')"), 'mock greeting')
  const command = `Desktop update fixture ${JSON.stringify({ appPath: report.appPath, evidencePath: report.evidencePath })}`
  assert.equal((await api('send', { sessionId: botId, text: command })).ok, true)
  console.log('local-update acceptance: tool request sent from the isolated chat')
  const records = join(shell, 'local-updates')
  const jobFile = await until(async () => {
    try { const latest = await json(join(records, 'latest.json')); return join(records, latest.id, 'job.json') } catch (error) {
      const output = await readFile(join(folder, 'mock.jsonl'), 'utf8').catch(() => '')
      if (output.includes('Desktop update refused:')) throw new Error(`Desktop tool refused the isolated fixture; inspect ${folder}`)
      return null
    }
  }, 'tool admitted update')
  let previousPhase
  const result = await until(async () => {
    const job = await json(jobFile)
    workerPid = job.workerPid; replacementPid = job.newPid
    if (job.phase !== previousPhase) { previousPhase = job.phase; console.log(`local-update acceptance: ${job.phase}`) }
    if (['failed', 'rolled_back', 'recovery_failed'].includes(job.phase)) throw new Error(`Update ended ${job.phase}: ${job.message}; ${folder}`)
    return job.phase === 'completed' && job.report === 'admitted' ? job : null
  }, 'replacement Host/UI and Bot receipt', 240000)
  assert.equal(alive(original.pid), false)
  assert.notEqual(result.oldPid, result.newPid)
  assert.equal(alive(result.newPid), true)
  const receipt = await json(join(dirname(jobFile), 'health.json'))
  assert.equal(receipt.pid, result.newPid); assert.equal(receipt.hash, report.appHash); assert.equal(receipt.uiReady, true)
  await until(async () => (await readFile(join(folder, 'mock.jsonl'), 'utf8')).includes('Desktop application update receipt'), 'receipt reached model')
  const textFiles = async at => {
    let text = ''
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name)
      if (entry.isDirectory()) text += await textFiles(path)
      else if (/\.(json|jsonl)$/u.test(entry.name)) text += await readFile(path, 'utf8').catch(() => '')
    }
    return text
  }
  await until(async () => (await textFiles(home)).includes('Desktop update report: completed'), 'completion visible in saved chat')
  console.log(`local-update acceptance passed: original exited, detached worker survived, exact-hash replacement Host/UI ready, one Bot report saved; ${folder}`)
} finally {
  socket?.close()
  for (const pid of [replacementPid, original?.pid]) {
    if (!pid || !alive(pid)) continue
    process.kill(pid, 'SIGTERM')
    await until(() => !alive(pid), 'owned test application exit', 30000).catch(() => {})
  }
  mock.kill('SIGTERM')
  await until(() => mock.exitCode !== null || mock.signalCode !== null, 'mock exit', 10000).catch(() => {})
  if (workerPid) await until(() => !alive(workerPid), 'owned installer exit', 10000).catch(() => {})
  await log.close()
  // A failed acceptance keeps its isolated receipts for diagnosis; the app copy never persists.
  await rm(target, { recursive: true, force: true })
}
