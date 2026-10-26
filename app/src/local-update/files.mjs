import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, lstat, readFile, rename, writeFile } from './fs.mjs'

export const JOB_ID = /^[a-f0-9-]{36}$/u
export const TERMINAL = new Set(['completed', 'rolled_back', 'failed', 'recovery_failed'])
export const CHECKS = ['plugin-build', 'plugin-test', 'plugin-lint', 'client-check', 'app-test', 'host-smoke', 'app-build', 'pack', 'packaged-check', 'signature', 'archive']

export async function json(file) {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw new Error('Invalid update record')
  return JSON.parse(await readFile(file, 'utf8'))
}
export async function save(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
  await rename(temporary, file)
}
export async function patch(file, value) {
  const next = { ...await json(file), ...value, updatedAt: Date.now() }
  await save(file, next)
  return next
}
export async function digest(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
export const exists = file => lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}
