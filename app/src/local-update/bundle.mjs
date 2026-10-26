import { execFile } from 'node:child_process'
import { lstat, readlink, readdir, realpath } from './fs.mjs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { digest, json, CHECKS } from './files.mjs'

const execute = promisify(execFile)
export const BUNDLE_ID = 'io.github.fei2411.deepseekbot'
export const within = (path, root) => { const part = relative(root, path); return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part)) }
export async function command(file, args) {
  try { return (await execute(file, args, { timeout: 60000, maxBuffer: 1024 * 1024 })).stdout.trim() }
  catch { throw new Error(`Update validation command failed: ${basename(file)}`) }
}
async function links(root, at = root) {
  for (const entry of await readdir(at, { withFileTypes: true })) {
    const path = join(at, entry.name)
    if (entry.isSymbolicLink()) {
      const target = resolve(dirname(path), await readlink(path))
      if (!within(target, root) || !within(await realpath(path), root)) throw new Error('Application contains an external symbolic link')
    } else if (entry.isDirectory()) await links(root, path)
  }
}
export async function validateBundle(given, arch = process.arch) {
  if (typeof given !== 'string' || !isAbsolute(given) || !given.endsWith('.app')) throw new Error('Choose an absolute local .app path')
  const info = await lstat(given)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Application must be a real directory')
  const path = await realpath(given)
  const plist = JSON.parse(await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(path, 'Contents', 'Info.plist')]))
  if (plist.CFBundleIdentifier !== BUNDLE_ID || typeof plist.CFBundleExecutable !== 'string'
    || basename(plist.CFBundleExecutable) !== plist.CFBundleExecutable || !plist.CFBundleExecutable) throw new Error('Application identity does not match DeepSeek Bot')
  const executable = join(path, 'Contents', 'MacOS', plist.CFBundleExecutable)
  if (!within(await realpath(executable), path)) throw new Error('Application executable escapes its bundle')
  await links(path)
  await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', path])
  if (!(await command('/usr/bin/lipo', ['-archs', executable])).split(/\s+/u).includes(arch === 'x64' ? 'x86_64' : arch)) throw new Error('Application architecture does not match this Mac')
  return { path, executable: plist.CFBundleExecutable, version: String(plist.CFBundleShortVersionString ?? ''), hash: await digest(join(path, 'Contents', 'Resources', 'app.asar')) }
}
export async function evidence(file, bundle) {
  if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('Choose an absolute build report path')
  const report = await json(file)
  if (report.schema !== 1 || report.appHash !== bundle.hash || !Array.isArray(report.checks)
    || CHECKS.some(name => !report.checks.some(check => check.name === name && check.passed === true))) throw new Error('A passing build report for this exact application is required')
  return { buildId: String(report.buildId ?? '').slice(0, 100), revision: String(report.revision ?? '').slice(0, 100), checks: CHECKS }
}
