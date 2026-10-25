// Exercise the opt-in project service through its authenticated API and real DSH.
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const root = resolve(import.meta.dirname, '../..')
const home = resolve(root, `.dsh-test-durable-api-${Date.now()}`)
mkdirSync(home, { recursive: true })
const children = []
let dsh
let rpc
let port

function launch(file, env, label) {
  const out = openSync(resolve(home, `${label}.out`), 'a')
  const err = openSync(resolve(home, `${label}.err`), 'a')
  let child
  try { child = fork(resolve(root, file), [], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', out, err, 'ipc'] }) }
  finally { closeSync(out); closeSync(err) }
  children.push(child)
  return child
}

function requests(child) {
  let sequence = 0
  const pending = new Map()
  const fail = error => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error) }
    pending.clear()
  }
  child.on('error', fail)
  child.on('exit', () => fail(new Error('Isolated Host exited')))
  child.on('message', message => {
    const item = pending.get(message.id)
    if (!item) return
    if (message.type === 'error') {
      clearTimeout(item.timer); pending.delete(message.id); item.reject(new Error(message.message))
    } else if (message.type === item.expected) {
      clearTimeout(item.timer); pending.delete(message.id); item.resolve(message)
    }
  })
  return (type, payload = {}, expected = 'api-result') => new Promise((resolve, reject) => {
    if (!child.connected) { reject(new Error('Isolated Host disconnected')); return }
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${type} timed out`)) }, 60_000)
    pending.set(id, { timer, resolve, reject, expected })
    child.send({ type, id, ...payload }, error => {
      if (!error) return
      clearTimeout(timer); pending.delete(id); reject(error)
    })
  })
}

function ready(child) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exited); child.off('error', errored) }
    const message = value => { if (value.type === 'ready') { cleanup(); resolve() } }
    const exited = () => { cleanup(); reject(new Error('Isolated Host exited during startup')) }
    const errored = error => { cleanup(); reject(error) }
    const timer = setTimeout(() => { cleanup(); reject(new Error('Isolated Host startup timed out')) }, 60_000)
    child.on('message', message); child.once('exit', exited); child.once('error', errored)
  })
}
async function stop(child, hard = false) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise(resolve => {
    const ended = () => { clearTimeout(timer); child.off('exit', ended); resolve() }
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    child.once('exit', ended)
    if (hard) child.kill('SIGKILL')
    else if (child === dsh && child.connected) child.send({ type: 'shutdown', id: 999999 }, error => { if (error) child.kill('SIGKILL') })
    else child.kill('SIGTERM')
  })
}
const newPort = () => new Promise((resolve, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)) })
})
async function waitPort(port, child) {
  const until = Date.now() + 15_000
  while (Date.now() < until) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Mock model exited')
    if (await new Promise(resolve => {
      const socket = createConnection({ port, host: '127.0.0.1' })
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => { socket.destroy(); resolve(false) })
    })) return
    await delay(100)
  }
  throw new Error('Mock model startup timed out')
}
async function startDsh() {
  dsh = launch('ds-bot/dev/durable-dsh-worker.mjs', {
    DSH_HOME: home, DURABLE_DSH_TEST: '1', DURABLE_PROJECT_TEST: '0',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/v1`, DEEPSEEK_API_KEY: 'mock-key',
  }, 'dsh')
  rpc = requests(dsh)
  await ready(dsh)
}
async function api(endpoint, payload = {}) {
  const { result } = await rpc('api', { endpoint, payload })
  if (!result.ok) throw new Error(result.error?.message ?? `API ${endpoint} failed`)
  return result.value
}
async function finished(key) {
  const until = Date.now() + 60_000
  while (Date.now() < until) {
    const value = await api('durable-state', { key })
    assert.equal(value.enabled, true)
    assert.equal(value.error, undefined)
    const record = value.jobs.find(job => job.key === key)
    if (record?.state.status === 'terminal') return record
    await delay(100)
  }
  throw new Error('Project durable job did not finish')
}

try {
  port = await newPort()
  const mock = launch('ds-bot/dev/mock-llm.mjs', {
    MOCK_PORT: String(port), MOCK_DELAY_MS: '2500', MOCK_LOG: resolve(home, 'mock.jsonl'),
    MOCK_WATCH: 'Durable result experience-create:0:',
  }, 'mock')
  await waitPort(port, mock)
  await startDsh()
  const state = await api('state')
  assert.ok(state.bots.length > 0)
  assert.equal((await api('durable-state')).enabled, false)
  await api('set-prefs', { durableTasks: true })
  assert.equal((await api('durable-state')).enabled, true)
  assert.equal((await api('state')).prefs.durableTasks, true)
  console.log('PASS: experimental task service is disabled by default and explicitly enabled through saved preferences')
  const agent = await api('add-agent')
  const { sessionId } = await rpc('create', {}, 'created')
  await api('agent-adopt', { agentId: agent.id, sessionId })
  const input = { key: 'project-api', steps: [{ sessionId, prompt: 'Project durable API integration fixture' }] }
  const first = await api('durable-submit', input)
  assert.equal((await api('durable-submit', input)).taskId, first.taskId)
  await assert.rejects(api('durable-submit', { ...input, steps: [{ sessionId, prompt: 'changed' }] }), /different input/)
  await assert.rejects(api('agent-archive', { agentId: agent.id, sessionId }), /unfinished durable work|reconciliation/)
  await assert.rejects(api('durable-submit', {
    key: 'bot-chat-rejected', steps: [{ sessionId: state.bots[0].sessionId ?? state.bots[0].id, prompt: 'must not run' }],
  }), /dedicated DSH Agent sessions/)
  const completed = await finished(input.key)
  let completionDiagnostic
  if (completed.state.outcome.status !== 'completed') {
    const record = await rpc('inspect', { sessionId, requestId: 'project-api:0' }, 'inspection')
    completionDiagnostic = JSON.stringify({
      error: completed.state.outcome.error,
      observation: { status: record.status, reason: record.reason, inputs: record.inputs, foreignInputs: record.foreignInputs, endReason: record.endReason },
    })
  }
  assert.equal(completed.state.outcome.status, 'completed', completionDiagnostic)
  assert.equal(typeof completed.state.outcome.result[0], 'string')
  assert.match(completed.state.outcome.result[0], /Durable result project-api:0:/)
  const inspected = await rpc('inspect', { sessionId, requestId: 'project-api:0' }, 'inspection')
  assert.equal(inspected.status, 'completed')
  assert.equal(inspected.inputs, 1)
  assert.equal(inspected.result, completed.state.outcome.result[0])
  console.log('PASS: authenticated project API creates a Pi task, DSH Agent executes, result is persisted')
  console.log('PASS: duplicate key reuses task; changed input, Bot chat and archive while pending are rejected')
  const modelState = await api('state')
  const model = modelState.models.find(entry => /deepseek/i.test(entry.provider) && !/account/i.test(entry.provider) && !entry.needsKey)
  assert.ok(model, 'the loopback mock model must be available in the project catalog')
  const allocations = value => value.agents.flatMap(entry => entry.sessions).toSorted()
  const beforeInvalid = allocations(modelState)
  await assert.rejects(api('durable-create', {
    key: 'invalid-model', title: 'Must not allocate', model: 'missing/provider', prompts: ['Do not run'],
  }), /available model/)
  await assert.rejects(api('durable-create', {
    key: 'invalid-phase', title: 'Must not allocate', model: model.ref, prompts: ['Valid phase', '   '],
  }), /nonempty task stages/)
  assert.deepEqual(allocations(await api('state')), beforeInvalid)
  assert.equal((await api('durable-state')).jobs.some(job => ['invalid-model', 'invalid-phase'].includes(job.key)), false)

  const creation = {
    key: 'experience-create', title: 'Two-stage experience', model: model.ref,
    prompts: ['Collect the fixture facts.', 'Use the earlier phase output to write the fixture report.'],
  }
  const created = await api('durable-create', creation)
  const afterCreate = allocations(await api('state'))
  assert.equal((await api('durable-create', creation)).taskId, created.taskId)
  assert.deepEqual(allocations(await api('state')), afterCreate)
  await assert.rejects(api('durable-create', { ...creation, prompts: ['Changed request'] }), /different task/)
  const createdJob = await finished(creation.key)
  assert.equal(createdJob.state.outcome.status, 'completed')
  assert.equal(createdJob.title, creation.title)
  assert.equal(createdJob.stepCount, 2)
  assert.equal(createdJob.sessionIds.length, 2)
  assert.equal(new Set(createdJob.sessionIds).size, 2)
  assert.equal(createdJob.sessionIds.includes(sessionId), false)
  assert.equal(createdJob.state.outcome.result.length, 2)
  for (let index = 0; index < 2; index += 1) {
    assert.match(createdJob.state.outcome.result[index], new RegExp(`Durable result experience-create:${index}:`))
    const phase = await rpc('inspect', { sessionId: createdJob.sessionIds[index], requestId: `experience-create:${index}` }, 'inspection')
    assert.equal(phase.status, 'completed')
    assert.equal(phase.inputs, 1)
  }
  const rows = readFileSync(resolve(home, 'mock.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  const secondPhase = rows.find(row => row.out?.some(block => block.type === 'text' && block.text.startsWith('Durable result experience-create:1:')))
  assert.ok(secondPhase, 'the second phase must reach the real mock model')
  assert.equal(secondPhase.watchHit, true, 'the second phase must receive the first saved result')
  console.log('PASS: user-facing create validates before allocation, creates separate sessions, carries results forward, and deduplicates retries')

  const interruptedCreation = { ...creation, key: 'experience-boundary', title: 'Restart at the saved phase' }
  const interruptedAdmission = await api('durable-create', interruptedCreation)
  let phaseBoundary
  const boundaryDeadline = Date.now() + 60_000
  while (Date.now() < boundaryDeadline) {
    const value = await api('durable-state', { key: interruptedCreation.key })
    const job = value.jobs.find(entry => entry.key === interruptedCreation.key)
    if (job?.state.checkpoint?.step === 1 && job.state.checkpoint.results?.length === 1
      && ['sleeping', 'pending'].includes(job.state.status)) { phaseBoundary = job; break }
    if (job?.state.status === 'terminal') throw new Error('Missed the committed phase boundary before task completion')
    await delay(30)
  }
  assert.ok(phaseBoundary, 'the task must expose its committed first phase before the next one starts')
  await stop(dsh, true)
  await startDsh()
  const recoveredCreation = await finished(interruptedCreation.key)
  assert.equal(recoveredCreation.taskId, interruptedAdmission.taskId)
  assert.equal(recoveredCreation.state.outcome.status, 'completed', recoveredCreation.state.outcome.error?.message)
  assert.deepEqual(recoveredCreation.sessionIds, phaseBoundary.sessionIds)
  assert.equal(recoveredCreation.state.outcome.result.length, 2)
  assert.match(recoveredCreation.state.outcome.result[0], /Durable result experience-boundary:0:/)
  assert.match(recoveredCreation.state.outcome.result[1], /Durable result experience-boundary:1:/)
  for (let index = 0; index < 2; index += 1) {
    assert.equal((await rpc('inspect', { sessionId: recoveredCreation.sessionIds[index], requestId: `experience-boundary:${index}` }, 'inspection')).inputs, 1)
  }
  console.log('PASS: one Host SIGKILL at a committed phase restores Pi and DSH work through saved enablement without repeated inputs')
  const afterRecovery = allocations(await api('state'))
  assert.equal((await api('durable-state')).enabled, true)
  assert.equal((await api('state')).prefs.durableTasks, true)
  const restored = await finished(input.key)
  assert.equal(restored.taskId, first.taskId)
  assert.deepEqual(restored.state.outcome, completed.state.outcome)
  assert.equal((await rpc('inspect', { sessionId, requestId: 'project-api:0' }, 'inspection')).inputs, 1)
  const restoredCreation = await finished(creation.key)
  assert.equal(restoredCreation.taskId, created.taskId)
  assert.deepEqual(restoredCreation.sessionIds, createdJob.sessionIds)
  assert.deepEqual(restoredCreation.state.outcome, createdJob.state.outcome)
  assert.equal((await api('durable-create', { key: creation.key })).taskId, created.taskId)
  assert.equal((await api('durable-create', creation)).taskId, created.taskId)
  assert.deepEqual(allocations(await api('state')), afterRecovery)
  for (let index = 0; index < 2; index += 1) {
    assert.equal((await rpc('inspect', { sessionId: createdJob.sessionIds[index], requestId: `experience-create:${index}` }, 'inspection')).inputs, 1)
  }
  console.log('PASS: project Host restart retains enabled preference, tasks, sessions and results without repeating DSH input')
  console.log('Durable project API smoke passed')
} finally {
  for (const child of children.toReversed()) await stop(child)
}
