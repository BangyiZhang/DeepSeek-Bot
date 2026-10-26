import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { installJob, cleanEnvironment, launchEnvironment } from '../src/local-update/install.mjs'
import { createLocalUpdates } from '../src/local-update/manager.mjs'
import { createRpc } from '../src/local-update/rpc.mjs'
import { updateReadiness } from '../src/local-update/readiness.mjs'
import { CHECKS, digest, json, save, alive } from '../src/local-update/files.mjs'
import { evidence } from '../src/local-update/bundle.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ds-bot-update-unit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const app = async (path, content) => { await mkdir(join(path, 'Contents/Resources'), { recursive: true }); await writeFile(join(path, 'Contents/Resources/app.asar'), content); return path }
  const validate = async path => ({ path, hash: await digest(join(path, 'Contents/Resources/app.asar')), executable: 'DeepSeek Bot', version: '0.2.1' })
  const id = randomUUID(), folder = join(root, id)
  await mkdir(folder)
  const target = await app(join(root, 'DeepSeek Bot.app'), 'old')
  const stage = await app(join(root, `.DeepSeek-Bot-stage-${id}.app`), 'new')
  const job = { schema: 1, id, phase: 'prepared', target, stage, backup: join(root, `.DeepSeek-Bot-backup-${id}.app`),
    oldHash: (await validate(target)).hash, newHash: (await validate(stage)).hash, executable: 'DeepSeek Bot', oldExecutable: 'DeepSeek Bot', oldPid: 1234567 }
  const file = join(folder, 'job.json')
  await save(file, job); await writeFile(join(folder, 'go'), id)
  let starts = 0, stops = 0
  const launch = selected => {
    const pid = ++starts + 2000
    const phase = starts === 1 ? 'newHash' : 'oldHash'
    void save(join(folder, 'health.json'), { id, hash: selected[phase], pid, uiReady: true })
    return { pid, async stop() { stops++ } }
  }
  return { root, folder, app, validate, job, file, launch, starts: () => starts, stops: () => stops }
}
test('installer replaces atomically and waits for the owned PID, exact hash and UI receipt', async t => {
  const f = await fixture(t)
  const result = await installJob(f.file, { validate: f.validate, launch: f.launch, alive: () => false, timeout: 1000 })
  assert.equal(result.phase, 'completed')
  assert.equal((await f.validate(f.job.target)).hash, f.job.newHash)
  await assert.rejects(readFile(join(f.job.backup, 'Contents/Resources/app.asar')))
  assert.equal(f.stops(), 0)
})
test('busy original app is never killed or replaced', async t => {
  const f = await fixture(t)
  const result = await installJob(f.file, { validate: f.validate, launch: f.launch, alive: () => true, timeout: 5, sleep: async () => {} })
  assert.equal(result.phase, 'failed')
  assert.equal((await f.validate(f.job.target)).hash, f.job.oldHash)
  assert.equal(f.starts(), 0)
})
test('startup timeout stops only its replacement and confirms rollback health', async t => {
  const f = await fixture(t)
  let count = 0
  const result = await installJob(f.file, { validate: f.validate, alive: () => false, timeout: 30, sleep: async () => {}, launch(job) {
    count++
    if (count === 1) return { pid: 100, stop: async () => {} }
    return f.launch({ ...job, newHash: job.oldHash })
  } })
  assert.equal(result.phase, 'rolled_back')
  assert.equal((await f.validate(f.job.target)).hash, f.job.oldHash)
})
test('interrupted rename recovers a missing target from the verified backup', async t => {
  const f = await fixture(t)
  await rename(f.job.target, f.job.backup)
  await save(f.file, { ...f.job, phase: 'swapping' })
  const result = await installJob(f.file, { validate: f.validate, alive: () => false, timeout: 1000, launch: job => f.launch({ ...job, newHash: job.oldHash }) })
  assert.equal(result.phase, 'rolled_back')
})
test('unknown target and live unowned replacement preserve backups for recovery', async t => {
  const f = await fixture(t)
  await rename(f.job.target, f.job.backup)
  await f.app(f.job.target, 'unknown')
  await save(f.file, { ...f.job, phase: 'swapping' })
  const result = await installJob(f.file, { validate: f.validate, alive: () => false })
  assert.equal(result.phase, 'recovery_failed')
  assert.equal((await f.validate(f.job.backup)).hash, f.job.oldHash)
  assert.equal(await readFile(join(f.job.target, 'Contents/Resources/app.asar'), 'utf8'), 'unknown')
  await save(f.file, { ...f.job, phase: 'launching', newPid: 123 })
  assert.equal((await installJob(f.file, { validate: f.validate, alive: () => true })).phase, 'recovery_failed')
  await save(f.file, { ...f.job, phase: 'launching' })
  assert.equal((await installJob(f.file, { validate: f.validate, alive: () => false })).phase, 'recovery_failed')
})
test('unsafe job paths and launch environment are refused before destructive work', async t => {
  const f = await fixture(t)
  await save(f.file, { ...f.job, backup: '/somewhere-else.app' })
  await assert.rejects(installJob(f.file), /Invalid installer job/u)
  assert.deepEqual(cleanEnvironment({ HOME: '/home', SECRET_TOKEN: 'sensitive', NODE_OPTIONS: '--inspect' }), { HOME: '/home' })
  assert.deepEqual(launchEnvironment({ DS_BOT_WORKSPACE: '/work', DEEPSEEK_API_KEY: 'sensitive', ELECTRON_RUN_AS_NODE: '1' }), { DS_BOT_WORKSPACE: '/work' })
  assert.equal(alive(0), false); assert.equal(alive(-1), false); assert.equal(alive(undefined), false)
})
test('evidence requires every check for the exact ASAR, queueing is idempotent and reports are claimed once', async t => {
  const f = await fixture(t)
  const report = join(f.root, 'report.json')
  const bundle = await f.validate(f.job.stage)
  await save(report, { schema: 1, appHash: bundle.hash, checks: CHECKS.map(name => ({ name, passed: true })) })
  await evidence(report, bundle)
  await assert.rejects(evidence(report, { ...bundle, hash: 'wrong' }))
  const manager = createLocalUpdates({ root: join(f.root, 'records'), target: f.job.target, validate: f.validate, probe: async () => ({ idle: false }), quit() { assert.fail('must not quit a busy app') }, platform: 'darwin' })
  t.after(() => manager.close())
  const body = { appPath: f.job.stage, evidencePath: report, requestKey: 'a'.repeat(64), origin: { botId: 'dev', sessionId: 'private' } }
  const first = await manager.queue(body)
  assert.equal((await manager.queue(body)).id, first.id)
  await assert.rejects(manager.queue({ ...body, requestKey: 'b'.repeat(64) }), /pending/u)
  await manager.tick(); assert.equal((await manager.status()).job.phase, 'queued')
  const file = join(f.root, 'records', first.id, 'job.json')
  await save(file, { ...await json(file), phase: 'completed' })
  assert.equal((await manager.claimReport()).id, first.id)
  assert.equal(await manager.claimReport(), null)
  await manager.reportDone(first.id)
  assert.equal((await manager.status()).job.report, 'admitted')
})
test('corrupt latest receipt fails closed instead of admitting another installer', async t => {
  const f = await fixture(t), root = join(f.root, 'records')
  const manager = createLocalUpdates({ root, target: f.job.target, platform: 'darwin' })
  t.after(() => manager.close())
  await mkdir(root, { recursive: true }); await writeFile(join(root, 'latest.json'), 'broken')
  await assert.rejects(manager.status())
})
test('private RPC settles responses, rejects on disconnect, times out and closes listeners', async () => {
  const a = new EventEmitter(), b = new EventEmitter()
  a.connected = b.connected = true
  a.send = (message, cb) => { queueMicrotask(() => b.emit('message', message)); cb(null) }
  b.send = (message, cb) => { queueMicrotask(() => a.emit('message', message)); cb(null) }
  const left = createRpc(a, undefined, 20), right = createRpc(b, (op, body) => { if (op === 'error') throw new Error('rejected'); return body })
  assert.deepEqual(await left.request('echo', { ok: true }), { ok: true })
  await assert.rejects(left.request('error'), /rejected/u)
  right.close()
  await assert.rejects(left.request('missing'), /timed out/u)
  const waiting = left.request('closed'); a.emit('disconnect')
  await assert.rejects(waiting, /closed/u)
  assert.equal(a.listenerCount('message'), 0)
})
test('readiness fails closed for unknown services, agents, queued input or background jobs', async () => {
  const services = { agents: { list: () => [] }, jobs: { list: () => [] }, dsBotDesktopUpdates: { readiness: async () => ({ idle: true }) } }
  const ctx = { get: key => services[key] }
  assert.equal((await updateReadiness(ctx)).idle, true)
  services.agents.list = () => [{ status: 'idle', inbox: { nextTurn: ['queued'], nextStep: [] } }]
  assert.equal((await updateReadiness(ctx)).idle, false)
  services.agents.list = () => []
  services.jobs.list = () => [{ status: 'stopping' }]
  assert.equal((await updateReadiness(ctx)).idle, false)
  delete services.jobs
  assert.equal((await updateReadiness(ctx)).idle, false)
})

test('independent workers respect a live owner lock and reclaim only a dead owner', async t => {
  const { spawn } = await import('node:child_process')
  const f = await fixture(t), lock = join(f.folder, 'worker.lock')
  await mkdir(lock)
  await save(join(lock, 'owner.json'), { pid: process.pid })
  const run = () => new Promise((done, reject) => {
    const child = spawn(process.execPath, [new URL('../src/local-update/worker.mjs', import.meta.url).pathname, f.file], { stdio: 'ignore' })
    child.once('error', reject); child.once('exit', done)
  })
  assert.equal(await run(), 1)
  assert.equal((await json(join(lock, 'owner.json'))).pid, process.pid)
  await save(join(lock, 'owner.json'), { pid: 2147483647 })
  await save(f.file, { ...f.job, phase: 'failed' })
  assert.equal(await run(), 0)
  await assert.rejects(json(join(lock, 'owner.json')), /ENOENT/u)
})

test('an unarmed controller never relaunches an app the user has closed', async t => {
  const f = await fixture(t)
  await save(f.file, { ...f.job, phase: 'controller_ready' })
  const result = await installJob(f.file, { validate: f.validate, alive: () => false, launch: f.launch })
  assert.equal(result.phase, 'failed')
  assert.equal(f.starts(), 0)
  assert.equal((await f.validate(f.job.target)).hash, f.job.oldHash)
})

test('Electron Node mode hashes and copies ASAR as a raw sealed file', async t => {
  const { createRequire } = await import('node:module')
  const { spawn } = await import('node:child_process')
  const electron = createRequire(import.meta.url)('electron')
  const f = await fixture(t)
  const expected = await digest(join(f.job.target, 'Contents/Resources/app.asar'))
  const code = `import {digest} from ${JSON.stringify(new URL('../src/local-update/files.mjs', import.meta.url).href)};
    import {cp} from ${JSON.stringify(new URL('../src/local-update/fs.mjs', import.meta.url).href)};
    const source=${JSON.stringify(f.job.target)}, copy=${JSON.stringify(join(f.root, 'copied.app'))};
    await cp(source,copy,{recursive:true});
    if(await digest(copy+'/Contents/Resources/app.asar')!==${JSON.stringify(expected)})throw Error('Raw ASAR copy mismatch');`
  const exit = await new Promise((done, reject) => {
    const child = spawn(electron, ['--input-type=module', '-e', code], { env: { ELECTRON_RUN_AS_NODE: '1', PATH: process.env.PATH }, stdio: 'ignore' })
    child.once('error', reject); child.once('exit', done)
  })
  assert.equal(exit, 0)
})
