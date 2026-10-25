// Isolated DSH executor for the Pi Durable integration bench. Public profile-boot,
// Session Controller, session events and paging are the entire bridge surface.
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDshExecutor } from '../src/host/durable/dsh.js'

const root = resolve(import.meta.dirname, '../..')
const home = process.env.DSH_HOME && resolve(process.env.DSH_HOME)
if (process.env.DURABLE_DSH_TEST !== '1' || !home || !basename(home).startsWith('.dsh-test-durable-')) {
  throw new Error('The durable DSH worker requires DURABLE_DSH_TEST=1 and a dedicated .dsh-test-durable-* home')
}
const modelUrl = new URL(process.env.DEEPSEEK_BASE_URL ?? 'http://invalid')
if (modelUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(modelUrl.hostname)
  || process.env.DEEPSEEK_API_KEY !== 'mock-key') {
  throw new Error('The durable DSH worker requires a loopback mock model and mock-key')
}

const profileDir = resolve(home, 'profiles/ds-bot')
await mkdir(profileDir, { recursive: true })
const patch = resolve(profileDir, 'cordis.patch.yml')
if (!existsSync(patch)) {
  await writeFile(patch, `- id: bot\n  config:\n    localCodex: false\n    localAntigravity: false\n    diagnosticsFile: false\n    updateCheck: false\n    durableTasks: ${process.env.DURABLE_PROJECT_TEST === '1'}\n`)
}

const appRequire = createRequire(resolve(root, 'app/package.json'))
const publicImport = name => import(pathToFileURL(appRequire.resolve(name)).href)
const [{ runProfile }, { loadLayeredEnv }, { loadAppProfile, PROFILE, INSTALL_ANCHOR }] = await Promise.all([
  publicImport('@deepseek-ai/dsh/profile-boot'),
  publicImport('@deepseek-ai/dsh-app-boot'),
  import('../../app/src/profile.mjs'),
])

const send = value => new Promise((done, reject) => {
  if (!process.connected) { done(); return }
  process.send(value, error => error ? reject(error) : done())
})
const application = await runProfile({
  environment: loadLayeredEnv('dsh'),
  profile: PROFILE,
  resolvedProfile: { profile: loadAppProfile(), installAnchor: INSTALL_ANCHOR },
  patchFiles: [],
  args: ['--no-open', '--port', '0'],
})
const { ctx } = application
const listeners = new Map()
let stopping = false

async function agentOf(sessionId) {
  const result = await ctx.sessionController.resolveAgent(sessionId)
  if ('error' in result) throw new Error(result.error?.message ?? 'Session unavailable')
  return result.agent
}

const executor = createDshExecutor({ ctx })
let apiCookie

async function api(endpoint, payload) {
  if (typeof endpoint !== 'string' || !/^[a-z][a-z-]{0,80}$/.test(endpoint)) throw new Error('Invalid bench API endpoint')
  const server = ctx.get('webServer')
  const connection = ctx.get('connection')
  if (!server || !connection) throw new Error('The isolated Host does not serve its authenticated API')
  const base = `http://127.0.0.1:${server.port}`
  if (!apiCookie) {
    const login = await fetch(connection.authenticatedUrl(`${base}/`), { redirect: 'manual', signal: AbortSignal.timeout(15_000) })
    apiCookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    if (!apiCookie) throw new Error('Isolated Host authentication did not return a cookie')
  }
  const response = await fetch(`${base}/api/bot`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: apiCookie },
    body: JSON.stringify({ endpoint, payload: payload ?? {} }), signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`The isolated Host API returned HTTP ${response.status}`)
  return response.json()
}

async function createSession() {
  const cwd = resolve(home, 'workspace')
  await mkdir(cwd, { recursive: true })
  const { sessionId } = await ctx.sessionController.create({ cwd, agentPreset: 'standard' })
  const deadline = Date.now() + 30_000
  let candidates = []
  let selectionError
  let catalog = []
  const agent = await agentOf(sessionId)
  while (Date.now() < deadline) {
    candidates = []
    catalog = []
    for (const [scope, llm] of [['agent', agent.ctx?.llm], ['root', ctx.llm]]) {
      if (!llm) continue
      const providers = []
      for (const provider of llm.listProviders()) {
        const models = await llm.listModels(provider.id).catch(() => [])
        providers.push({ id: provider.id, models: models.map(model => model.id) })
        // Only DeepSeek API routes use the mock base URL in this isolated profile.
        if (!/deepseek/i.test(provider.id) || /account/i.test(provider.id)) continue
        for (const model of models) {
          if (!candidates.some(candidate => candidate.provider === provider.id && candidate.model === model.id)) candidates.push({ provider: provider.id, model: model.id })
        }
      }
      catalog.push({ scope, providers })
    }
    candidates.sort((a, b) => Number(/flash/.test(b.model)) - Number(/flash/.test(a.model)))
    for (const candidate of candidates) {
      const result = await ctx.sessionController.selectModel({ sessionId, ...candidate })
      if (result?.selected && !result.error) return sessionId
      selectionError = result?.error?.message ?? 'DSH did not confirm the model selection'
    }
    await new Promise(done => setTimeout(done, 200))
  }
  throw new Error(`No mock-backed DSH model could be selected; catalog=${JSON.stringify(catalog)}; ${selectionError ?? 'no DeepSeek API models were listed'}`)
}

async function sessionSnapshot(sessionId, includeSchemas = false) {
  const agent = await agentOf(sessionId)
  const throughSeq = Number(agent.session.seq) - 1
  const events = []
  let beforeSeq
  if (throughSeq >= 0) for (let count = 0; count < 128; count += 1) {
    const page = await ctx.sessionController.page({
      address: { kind: 'session', sessionId }, throughSeq,
      ...(beforeSeq === undefined ? {} : { beforeSeq }), maxMessages: 256,
    }, AbortSignal.timeout(15_000))
    if (!Array.isArray(page?.records)) throw new Error('Incomplete isolated session snapshot')
    events.unshift(...page.records.map(record => record.event))
    if (page.hasMore === false) break
    if (page.hasMore !== true || page.records.length === 0 || count === 127) throw new Error('Incomplete isolated session snapshot')
    beforeSeq = page.records[0].event?.seq
  }
  const schemas = ctx.tools.schemas(agent)
  const names = new Set([...ctx.tools.schemas(), ...schemas].map(schema => schema.name))
  return {
    sessionId, status: agent.status, cwd: agent.session.header.cwd,
    toolNames: schemas.map(schema => schema.name),
    callableToolNames: [...names].filter(name => ctx.tools.get(name, agent) !== undefined),
    ...(includeSchemas ? { toolSchemas: schemas } : {}), events,
    inbox: [...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])],
  }
}

async function checkListener(key) {
  const entry = listeners.get(key)
  if (!entry || entry.checking || stopping) return
  entry.checking = true
  try {
    const inspection = await executor.inspect({ sessionId: entry.sessionId, requestId: entry.requestId })
    if (inspection.reason === 'history_changed') {
      setTimeout(() => void checkListener(key).catch(error => send({ type: 'error', id: entry.id, message: error.message })), 50)
      return
    }
    if (['completed', 'interrupted', 'uncertain'].includes(inspection.status)) {
      listeners.delete(key)
      await send({ type: 'done', id: entry.id, ...inspection })
    }
  } finally { entry.checking = false }
}

ctx.on('session/event', (session, event) => {
  if (event.type !== 'turn/end') return
  for (const [key, entry] of listeners) if (entry.sessionId === session?.id) {
    setImmediate(() => void checkListener(key).catch(error => send({ type: 'error', id: entry.id, message: error.message })))
  }
})

async function stop() {
  if (stopping) return
  stopping = true
  await application.shutdown.shutdown(0)
  await send({ type: 'stopped' })
  if (process.connected) process.disconnect()
}

async function command(message) {
  const { type, id } = message ?? {}
  if (type === 'shutdown') return stop()
  if (stopping) throw new Error('Worker is stopping')
  if (type === 'api') return send({ type: 'api-result', id, result: await api(message.endpoint, message.payload) })
  if (type === 'create') return send({ type: 'created', id, sessionId: await createSession() })
  if (type === 'snapshot') return send({ type: 'snapshot', id, ...await sessionSnapshot(message.sessionId, message.includeSchemas === true) })
  const { requestId } = message
  if (type === 'inspect') return send({ type: 'inspection', id, ...await executor.inspect(message) })
  if (type !== 'run') throw new Error('Unknown command')
  const sessionId = message.sessionId ?? await createSession()
  const input = { sessionId, requestId, prompt: message.prompt }
  const key = `${sessionId}:${requestId}`
  listeners.set(key, { id, sessionId, requestId })
  try {
    const receipt = await executor.dispatch(input)
    await send({ type: 'ack', id, ...receipt })
    await checkListener(key)
  } catch (error) {
    listeners.delete(key)
    throw error
  }
}

process.on('message', message => {
  void command(message).catch(error => send({ type: 'error', id: message?.id, message: error.message }))
})
process.once('disconnect', () => { void stop() })
process.once('SIGTERM', () => { void stop() })
await send({ type: 'ready' })
