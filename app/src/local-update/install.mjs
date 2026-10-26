import { spawn } from 'node:child_process'
import { rename, rm } from './fs.mjs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { alive, exists, json, patch, TERMINAL } from './files.mjs'
import { validateBundle } from './bundle.mjs'

export const cleanEnvironment = env => Object.fromEntries(['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL'].filter(key => typeof env[key] === 'string').map(key => [key, env[key]]))
export function launchEnvironment(env = {}) {
  const allowed = ['DS_BOT_SHELL_DATA', 'DS_BOT_WORKSPACE']
  if (env.DS_BOT_LOCAL_UPDATE_TEST === '1' && env.DS_BOT_HOME?.includes('.dsh-test-local-update-')
    && /^http:\/\/127\.0\.0\.1:\d+\/v1$/u.test(env.DEEPSEEK_BASE_URL ?? '') && env.DEEPSEEK_API_KEY === 'mock-key') {
    allowed.push('DS_BOT_HOME', 'DS_BOT_LOCAL_UPDATE_TEST', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_API_KEY')
  }
  return Object.fromEntries(allowed.filter(key => typeof env[key] === 'string').map(key => [key, env[key]]))
}
export function launch(job) {
  const env = { ...cleanEnvironment(process.env), ...launchEnvironment(job.launchEnv) }
  const child = spawn(join(job.target, 'Contents', 'MacOS', job.executable), [`--ds-bot-local-update=${job.id}`], { detached: true, stdio: 'ignore', env })
  let stopped = false
  const exited = new Promise(resolve => { child.once('exit', () => { stopped = true; resolve() }); child.once('error', () => { stopped = true; resolve() }) })
  child.unref()
  return { pid: child.pid, async stop() {
    if (stopped) return
    child.kill('SIGTERM')
    await Promise.race([exited, sleep(10000)])
    if (!stopped) { child.kill('SIGKILL'); await Promise.race([exited, sleep(5000)]) }
    if (!stopped) throw new Error('Replacement process did not exit; backup retained')
  } }
}
async function wait(check, ms, pause) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await check()) return true; await pause(200) }
  return false
}
export async function installJob(file, options = {}) {
  const validate = options.validate ?? validateBundle
  const start = options.launch ?? launch
  const isAlive = options.alive ?? alive
  const pause = options.sleep ?? sleep
  const timeout = options.timeout ?? 120000
  let job = await json(file)
  if (job.schema !== 1 || !/^[a-f0-9-]{36}$/u.test(job.id) || !isAbsolute(job.target) || !job.target.endsWith('.app')
    || job.stage !== join(dirname(job.target), `.DeepSeek-Bot-stage-${job.id}.app`)
    || job.backup !== join(dirname(job.target), `.DeepSeek-Bot-backup-${job.id}.app`)
    || ![job.executable, job.oldExecutable].every(name => typeof name === 'string' && name && name === basename(name))
    || ![job.oldHash, job.newHash].every(hash => /^[a-f0-9]{64}$/u.test(hash))
    || !Number.isSafeInteger(job.oldPid) || job.oldPid <= 1) throw new Error('Invalid installer job')
  if (TERMINAL.has(job.phase)) return job
  const healthFile = join(dirname(file), 'health.json')
  let replacement
  try {
    if (job.phase !== 'prepared') throw new Error('Recovering an interrupted installation')
    if ((await validate(job.stage)).hash !== job.newHash || (await validate(job.target)).hash !== job.oldHash) throw new Error('Application changed after staging')
    job = await patch(file, { phase: 'controller_ready', workerPid: process.pid })
    if (!await wait(() => exists(join(dirname(file), 'go')), 30000, pause)) throw new Error('Application did not arm the handoff')
    job = await patch(file, { phase: 'waiting_exit' })
    if (!await wait(() => !isAlive(job.oldPid), timeout, pause)) throw new Error('Original application is still running; it was not forced to stop')
    job = await patch(file, { phase: 'swapping' })
    if ((await validate(job.target)).hash !== job.oldHash || (await validate(job.stage)).hash !== job.newHash || await exists(job.backup)) throw new Error('Staged application or target changed')
    await rename(job.target, job.backup)
    await rename(job.stage, job.target)
    job = await patch(file, { phase: 'launching' })
    replacement = start(job, file)
    if (!Number.isInteger(replacement.pid)) throw new Error('Replacement could not be launched')
    job = await patch(file, { newPid: replacement.pid })
    const healthy = await wait(async () => {
      if (!await exists(healthFile)) return false
      const health = await json(healthFile)
      return health.id === job.id && health.pid === replacement.pid && health.hash === job.newHash && health.uiReady === true
    }, timeout, pause)
    if (!healthy) throw new Error('Replacement did not confirm its Host and chat UI')
    if ((await validate(job.target)).hash !== job.newHash) throw new Error('Installed application changed during startup')
    const completed = await patch(file, { phase: 'completed', message: 'Replacement Host and chat UI are ready', completedAt: Date.now() })
    await rm(job.backup, { recursive: true }).catch(() => {})
    return completed
  } catch (error) {
    try { await replacement?.stop() } catch (stopping) { return patch(file, { phase: 'recovery_failed', message: stopping.message }) }
    if (!replacement && ((job.phase === 'launching' && (!job.newPid || isAlive(job.newPid)))
      || (job.phase === 'rollback' && (!job.rollbackPid || isAlive(job.rollbackPid))))) return patch(file, { phase: 'recovery_failed', message: 'Replacement identity cannot be reacquired; backup retained for manual recovery' })
    const backup = await exists(job.backup)
    if (!backup) return patch(file, { phase: 'failed', message: error.message })
    try {
      if ((await validate(job.backup)).hash !== job.oldHash) throw new Error('The previous application cannot be verified')
      if (await exists(job.target)) {
        if ((await validate(job.target)).hash !== job.newHash) throw new Error('Target identity is uncertain; no files were overwritten')
        const failed = `${job.stage}.failed.app`
        if (await exists(failed)) throw new Error('Recovery destination is occupied')
        await rename(job.target, failed)
      }
      await rename(job.backup, job.target)
      job = await patch(file, { phase: 'rollback', message: error.message })
      const previous = start({ ...job, executable: job.oldExecutable }, file)
      if (!Number.isInteger(previous.pid)) throw new Error('Previous application could not be launched')
      job = await patch(file, { rollbackPid: previous.pid })
      if (!await wait(async () => {
        if (!await exists(healthFile)) return false
        const health = await json(healthFile)
        return health.id === job.id && health.pid === previous.pid && health.hash === job.oldHash && health.uiReady === true
      }, timeout, pause)) throw new Error('Previous bundle was restored but its startup could not be confirmed')
      return patch(file, { phase: 'rolled_back', message: error.message, completedAt: Date.now() })
    } catch (recovery) { return patch(file, { phase: 'recovery_failed', message: recovery.message }) }
  }
}
