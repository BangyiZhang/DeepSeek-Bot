import { mkdir, rm, writeFile } from './fs.mjs'
import { dirname, join } from 'node:path'
import { installJob } from './install.mjs'
import { alive, json } from './files.mjs'

const file = process.argv[2]
const lock = join(dirname(file), 'worker.lock')
let owned = false
try {
  try { await mkdir(lock, { mode: 0o700 }) }
  catch {
    const owner = await json(join(lock, 'owner.json')).catch(() => null)
    if (!owner || alive(owner.pid)) throw new Error('An installer already owns this job')
    await rm(lock, { recursive: true })
    await mkdir(lock, { mode: 0o700 })
  }
  owned = true
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 })
  await installJob(file)
} finally { if (owned) await rm(lock, { recursive: true, force: true }) }
