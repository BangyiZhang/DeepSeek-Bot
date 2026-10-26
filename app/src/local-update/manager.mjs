import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { constants, cp, chmod, lstat, mkdir, realpath, rm, writeFile } from './fs.mjs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { alive, digest, exists, json, JOB_ID, patch, save, TERMINAL } from './files.mjs'
import { evidence, validateBundle, within } from './bundle.mjs'
import { cleanEnvironment, launchEnvironment } from './install.mjs'

const directory = dirname(fileURLToPath(import.meta.url))
const pause = ms => sleep(ms)
export function createLocalUpdates({ root, target, probe, quit, launchEnv = {}, validate = validateBundle, platform = process.platform }) {
  let closed = false
  let polling
  let changing = Promise.resolve()
  let idleSamples = 0
  const serial = fn => { const work = changing.then(fn); changing = work.catch(() => {}); return work }
  const ready = (async () => {
    await mkdir(root, { recursive: true, mode: 0o700 })
    const info = await lstat(root)
    if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('Update directory must belong to the current user')
    await chmod(root, 0o700)
  })()
  const jobFile = id => { if (!JOB_ID.test(id)) throw new Error('Invalid update id'); return join(root, id, 'job.json') }
  const latest = async () => { await ready; const last = await json(join(root, 'latest.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error }); return last ? json(jobFile(last.id)) : null }
  const view = job => job ? { id: job.id, phase: job.phase, version: job.version, hash: job.newHash, message: job.message ?? '', origin: job.origin, report: job.report ?? null } : null
  const queue = body => serial(async () => {
    if (closed || platform !== 'darwin') throw new Error('Local application updates are available only in the packaged Mac app')
    const previous = await latest()
    if (typeof body.requestKey !== 'string' || !/^[a-f0-9]{64}$/u.test(body.requestKey)) throw new Error('A stable update request identity is required')
    if (!body.origin || !['botId', 'sessionId'].every(key => typeof body.origin[key] === 'string' && body.origin[key].length < 257)) throw new Error('A private Bot origin is required')
    if (previous?.requestKey === body.requestKey) return view(previous)
    if (previous && (!TERMINAL.has(previous.phase) || previous.phase === 'recovery_failed' || (previous.workerPid && alive(previous.workerPid)))) throw new Error('Another local application update is pending')
    const [old, next] = await Promise.all([validate(target), validate(body.appPath)])
    if (within(next.path, old.path) || within(old.path, next.path)) throw new Error('Build a separate application bundle before requesting an update')
    const checked = await evidence(body.evidencePath, next)
    const id = randomUUID()
    const folder = join(root, id)
    await mkdir(folder, { mode: 0o700 })
    const job = { schema: 1, id, requestKey: body.requestKey, origin: body.origin, phase: 'queued', createdAt: Date.now(),
      target: old.path, source: next.path, oldHash: old.hash, newHash: next.hash, executable: next.executable, oldExecutable: old.executable, version: next.version,
      stage: join(dirname(old.path), `.DeepSeek-Bot-stage-${id}.app`), backup: join(dirname(old.path), `.DeepSeek-Bot-backup-${id}.app`),
      oldPid: process.pid, launchEnv: launchEnvironment(launchEnv), evidence: checked }
    await save(jobFile(id), job)
    await save(join(root, 'latest.json'), { id })
    idleSamples = 0
    return view(job)
  })
  const stage = async job => {
    const file = jobFile(job.id)
    if ((await validate(job.target)).hash !== job.oldHash || (await validate(job.source)).hash !== job.newHash) throw new Error('Application changed before staging')
    if (!await exists(job.stage)) await cp(job.source, job.stage, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE, force: false, errorOnExist: true })
    if ((await validate(job.stage)).hash !== job.newHash) throw new Error('Staged bundle does not match the build report')
    const folder = dirname(file)
    const runner = join(folder, 'Runner.app')
    if (!await exists(runner)) await cp(job.target, runner, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
    if ((await validate(runner)).hash !== job.oldHash) throw new Error('Independent installer runtime could not be verified')
    for (const name of ['fs.mjs', 'files.mjs', 'bundle.mjs', 'install.mjs', 'worker.mjs']) await writeFile(join(folder, name), await readFile(join(directory, name)), { mode: 0o600 })
    if (!(await probe()).idle || closed) { idleSamples = 0; return }
    await patch(file, { phase: 'prepared', oldPid: process.pid })
    const child = spawn(join(runner, 'Contents', 'MacOS', job.oldExecutable), [join(folder, 'worker.mjs'), file], {
      detached: true, stdio: 'ignore', env: { ...cleanEnvironment(process.env), ELECTRON_RUN_AS_NODE: '1' },
    })
    child.unref()
    let failed = false
    child.once('error', () => { failed = true })
    const end = Date.now() + 30000
    while (Date.now() < end && !failed) {
      const record = await json(file)
      if (record.phase === 'controller_ready') {
        if (closed || !(await probe()).idle) throw new Error('The team became busy before handoff; application was not stopped')
        await writeFile(join(folder, 'go'), job.id, { flag: 'wx', mode: 0o600 })
        quit()
        return
      }
      if (TERMINAL.has(record.phase)) return
      await pause(100)
    }
    throw new Error('Independent installer did not become ready')
  }
  const tick = async () => {
    if (closed) return
    const job = await latest()
    if (!job) return
    if (TERMINAL.has(job.phase)) {
      // The runtime snapshot must outlive its worker, even after the receipt is written.
      if (job.phase !== 'recovery_failed' && job.workerPid && !alive(job.workerPid)) await rm(join(root, job.id, 'Runner.app'), { recursive: true, force: true }).catch(() => {})
      return
    }
    if (job.phase !== 'queued') return
    if (!(await probe()).idle) { idleSamples = 0; return }
    if (++idleSamples < 3) return
    try { await stage(job) } catch (error) { await patch(jobFile(job.id), { phase: 'failed', message: error.message }) }
  }
  const timer = setInterval(() => { polling ??= tick().catch(() => {}).finally(() => { polling = undefined }) }, 1500)
  timer.unref?.()
  return {
    queue,
    async dispatch(op, body) {
      if (op === 'queue') return queue(body)
      if (op === 'status') return this.status()
      if (op === 'claimReport') return this.claimReport()
      if (op === 'reportDone') return this.reportDone(body.id)
      throw new Error('Unknown desktop update operation')
    },
    async status() { return { available: platform === 'darwin', job: view(await latest()) } },
    async claimReport() { return serial(async () => {
      const job = await latest()
      if (!job || !TERMINAL.has(job.phase) || job.report) return null
      await patch(jobFile(job.id), { report: 'attempted' })
      return view(job)
    }) },
    async reportDone(id) { if ((await latest())?.id === id) await patch(jobFile(id), { report: 'admitted' }) },
    async acknowledge(id, { pid, uiReady }) {
      if (!JOB_ID.test(id) || !uiReady) return
      const job = await json(jobFile(id))
      const hash = await digest(join(target, 'Contents', 'Resources', 'app.asar'))
      if (!['launching', 'rollback'].includes(job.phase) || (job.phase === 'rollback' ? job.oldHash : job.newHash) !== hash || await realpath(target) !== job.target || pid !== process.pid) return
      await save(join(root, id, 'health.json'), { id, pid, hash, uiReady: true })
    },
    tick,
    close() { closed = true; clearInterval(timer) },
  }
}
