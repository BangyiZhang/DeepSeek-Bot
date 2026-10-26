// Prepare an artifact and an exact-hash receipt. Installation is a separate Bot tool call.
import { spawn } from 'node:child_process'
import { cp, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { validateBundle, command } from '../src/local-update/bundle.mjs'
import { CHECKS, digest } from '../src/local-update/files.mjs'
import { cleanEnvironment } from '../src/local-update/install.mjs'

if (process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) < 24) throw new Error('Use native Node 24+ on macOS')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const buildId = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`
const folder = join(root, 'work', 'local-updates', buildId)
await mkdir(folder, { recursive: true, mode: 0o700 })
const env = { ...cleanEnvironment(process.env), PATH: `${dirname(process.execPath)}:${process.env.PATH}`, TMPDIR: '/private/tmp' }
async function fingerprint() {
  const hash = createHash('sha256')
  async function collect(path) {
    for (const item of (await readdir(join(root, path), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = `${path}/${item.name}`
      if (item.isDirectory()) await collect(relative)
      else if (item.isFile()) { hash.update(relative); hash.update(await readFile(join(root, relative))) }
    }
  }
  for (const path of ['ds-bot/src', 'app/src', 'app/assets', 'app/ui/src']) await collect(path)
  for (const path of ['ds-bot/index.js', 'ds-bot/client.js', 'ds-bot/package.json', 'ds-bot/cordis.patch.yml', 'ds-bot/web-search.js', 'app/package.json', 'app/electron-builder.yml']) {
    hash.update(path); hash.update(await readFile(join(root, path)))
  }
  return hash.digest('hex')
}
const checks = []
async function run(name, executable, args, cwd = root) {
  const log = await open(join(folder, `${name}.log`), 'wx', 0o600)
  console.log(`local-update: ${name}`)
  try {
    const code = await new Promise((done, reject) => {
      const child = spawn(executable, args, { cwd, env, stdio: ['ignore', log.fd, log.fd] })
      child.once('error', reject); child.once('exit', done)
    })
    if (code !== 0) throw new Error(`${name} failed; inspect ${join(folder, `${name}.log`)}`)
    checks.push({ name, passed: true })
  } finally { await log.close() }
}
const npm = (name, project, args) => process.env.npm_execpath
  ? run(name, process.execPath, [process.env.npm_execpath, '--prefix', project, ...args])
  : run(name, 'npm', ['--prefix', project, ...args])
await npm('plugin-build', 'ds-bot', ['run', 'build'])
for (const file of ['index.js', 'client.js', 'web-search.js', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
  await cp(join(root, 'ds-bot', file), join(root, 'app', 'node_modules', 'ds-bot', file))
}
for (const path of ['src/host', 'src/shared']) await cp(join(root, 'ds-bot', path), join(root, 'app', 'node_modules', 'ds-bot', path), { recursive: true })
const sourceHash = await fingerprint()
await npm('plugin-test', 'ds-bot', ['test'])
await npm('plugin-lint', 'ds-bot', ['run', 'lint'])
await run('client-check', process.execPath, ['ds-bot/scripts/build-client.mjs', '--check'])
await npm('app-test', 'app', ['test'])
await run('host-smoke', process.execPath, ['ds-bot/dev/desktop-smoke.mjs'])
await run('source-check', '/usr/bin/git', ['-C', root, 'diff', '--check'])
await npm('app-build', 'app', ['run', 'build'])
if (await fingerprint() !== sourceHash) throw new Error('Source changed during validation; rerun preparation')
await npm('pack', 'app', ['run', 'pack', '--', '--mac', `--${process.arch}`])
const appPath = join(root, 'app', 'dist-pack', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'DeepSeek Bot.app')
const bundle = await validateBundle(appPath)
const asar = createRequire(import.meta.url)('@electron/asar')
const archive = join(appPath, 'Contents/Resources/app.asar')
async function compare(folder, packedPrefix) {
  for (const item of await readdir(folder, { withFileTypes: true })) {
    const source = join(folder, item.name), packed = `${packedPrefix}/${item.name}`
    if (item.isDirectory()) await compare(source, packed)
    else if (item.isFile() && !asar.extractFile(archive, packed).equals(await readFile(source))) throw new Error(`Packaged source mismatch: ${packed}`)
  }
}
await compare(join(root, 'app/src'), 'src')
for (const path of ['src/host', 'src/shared']) await compare(join(root, 'ds-bot', path), `node_modules/ds-bot/${path}`)
for (const file of ['index.js', 'client.js', 'web-search.js', 'cordis.patch.yml']) {
  if (!asar.extractFile(archive, `node_modules/ds-bot/${file}`).equals(await readFile(join(root, 'ds-bot', file)))) throw new Error(`Packaged plugin mismatch: ${file}`)
}
checks.push({ name: 'signature', passed: true })
await npm('packaged-check', 'app', ['run', 'check-packed'])
const zipPath = join(root, 'app', 'dist-pack', `DeepSeek-Bot-${bundle.version}-mac-${process.arch}-${buildId}.zip`)
await run('archive-write', '/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath])
await run('archive', '/usr/bin/unzip', ['-tq', zipPath])
if (CHECKS.some(name => !checks.some(check => check.name === name && check.passed))) throw new Error('Build evidence is incomplete')
if (await fingerprint() !== sourceHash || (await validateBundle(appPath)).hash !== bundle.hash) throw new Error('Source or candidate changed during preparation; rebuild before installing')
const evidencePath = join(folder, 'report.json')
const report = { schema: 1, buildId, revision: await command('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD']),
  dirty: Boolean(await command('/usr/bin/git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'])),
  appHash: bundle.hash, sourceHash, zipHash: await digest(zipPath), checks, appPath, zipPath, evidencePath, preparedAt: Date.now() }
await writeFile(evidencePath, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' })
console.log(JSON.stringify({ status: 'prepared', appPath, zipPath, evidencePath, appHash: bundle.hash }))
