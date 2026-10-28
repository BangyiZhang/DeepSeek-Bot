// Exercise Bot chat tools, real Pi SQLite, DSH execution and chat result delivery in an isolated mock team.
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { TEAM_TOOLS } from '../src/host/constants.js'

const root = resolve(import.meta.dirname, '../..')
const home = resolve(root, `.dsh-test-durable-chat-${Date.now()}`)
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
    DS_BOT_WORKSPACE: resolve(home, 'workspace'),
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
    if (record?.state.status === 'preparing' && rows().some(row => hasOutput(row, /^Durable chat creation refused:/))) {
      const current = await snapshot(record.origin.sessionId)
      const failure = current.events.filter(event => JSON.stringify(event).includes('could not start')).at(-1)
      throw new Error(`Durable task preparation failed: ${JSON.stringify(failure)}`)
    }
    if (record?.state.status === 'terminal') return record
    await delay(100)
  }
  throw new Error('Project durable job did not finish')
}

async function until(check, description, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await delay(40)
  }
  throw new Error(`Timed out: ${description}`)
}
const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text ?? '').join('\n') : ''
const rows = () => {
  try { return readFileSync(resolve(home, 'mock.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}
const hasOutput = (row, pattern) => row.out?.some(block => block.type === 'text' && pattern.test(block.text))
const botOf = async botId => (await api('state')).bots.find(bot => bot.id === botId)
const chatOf = async botId => { const bot = await botOf(botId); return bot.sessionId ?? bot.id }
const sendChat = (botId, text) => api('send', { sessionId: botId, text })
const snapshot = async sessionId => rpc('snapshot', { sessionId }, 'snapshot')
async function createFromChat(botId, tag) {
  const before = rows().length
  await sendChat(botId, `Durable chat fixture ${tag}`)
  return until(async () => {
    const refused = rows().slice(before).flatMap(row => row.out ?? []).find(block => block.type === 'text' && block.text.startsWith('Durable chat creation refused:'))
    if (refused) throw new Error(refused.text)
    return (await api('durable-state')).jobs.find(job => job.title === `Durable chat ${tag}` && job.taskId !== null)
  }, `chat-created ${tag} task`)
}
const notificationInputs = (state, key) => state.events.filter(event => event.type === 'user/message'
  && event.data?.source?.role === 'durable' && textOf(event.data.content).includes(`Task key: ${key}\n`))
async function waitForReport(botId, key) {
  return until(async () => {
    const current = await snapshot(await chatOf(botId))
    const delivered = notificationInputs(current, key)
    const reported = current.events.some(event => event.type === 'assistant/message'
      && textOf(event.data?.message?.content).startsWith(`Durable chat report ${key}:`))
    return delivered.length > 0 && reported && current.status === 'idle' ? current : undefined
  }, `result report for ${key}`)
}
async function waitForIdle(botId) {
  return until(async () => {
    const current = await snapshot(await chatOf(botId))
    return current.status === 'idle' && current.inbox.length === 0 ? current : undefined
  }, 'Bot idle')
}
async function verifyStages(job, tag, expectedCwd, { historicalBeforeStage = 0 } = {}) {
  assert.equal(job.state.outcome.status, 'completed', JSON.stringify(job.state.outcome.error))
  assert.equal(job.stepCount, 2)
  assert.equal(job.sessionIds.length, 2)
  assert.equal(new Set(job.sessionIds).size, 2)
  const result = job.state.outcome.result
  assert.equal(result.length, 2)
  for (let stage = 0; stage < 2; stage += 1) {
    assert.match(result[stage], new RegExp(`Durable chat stage ${stage + 1} ${tag} finished`))
    assert.match(result[stage], /owner context present/)
    assert.match(result[stage], /team tools absent/)
    const inspection = await rpc('inspect', { sessionId: job.sessionIds[stage], requestId: `${job.key}:${stage}` }, 'inspection')
    assert.equal(inspection.status, 'completed')
    assert.equal(inspection.inputs, 1)
    const current = await snapshot(job.sessionIds[stage])
    assert.equal(current.cwd, expectedCwd)
    const forbidden = [...TEAM_TOOLS.filter(name => !['recall', 'read_own_chat', 'read_browser', 'list_capabilities', 'ask_user'].includes(name)), 'create_goal', 'get_goal', 'update_goal', 'ask_user_question']
    const requests = rows().filter(row => row.session === job.sessionIds[stage])
    assert.ok(requests.length > 0, 'Each phase must have actual model request evidence')
    for (const request of requests) {
      assert.ok(Array.isArray(request.toolNames))
      assert.deepEqual(request.toolNames.filter(name => forbidden.includes(name)), [], 'Actual model requests must not receive team or goal tools')
    }
    // An idle historical phase has no new step to restore its scoped guard yet.
    // Its original execution above must still have used the restricted surface.
    const hiddenNow = stage < historicalBeforeStage ? TEAM_TOOLS : forbidden
    assert.deepEqual(current.toolNames.filter(name => hiddenNow.includes(name)), [])
    assert.deepEqual(current.callableToolNames.filter(name => hiddenNow.includes(name)), [])
    assert.equal(current.callableToolNames.includes('read'), true)
  }
  assert.match(result[1], /earlier result present/)
  assert.match(result[0], /fixture read/)
}

try {
  port = await newPort()
  const mock = launch('ds-bot/dev/mock-llm.mjs', {
    MOCK_PORT: String(port), MOCK_DELAY_MS: '700', MOCK_LOG: resolve(home, 'mock.jsonl'),
    MOCK_LOG_CHARS: '1000', MOCK_LOG_TOOLS: '1',
  }, 'mock')
  await waitPort(port, mock)
  await startDsh()
  const initial = await api('state')
  const main = initial.bots[0]
  assert.ok(main)
  await api('set-prefs', { durableTasks: true })
  const model = await until(async () => (await api('state')).models.find(entry => /deepseek/i.test(entry.provider)
    && !/account/i.test(entry.provider) && !entry.needsKey), 'loopback model catalog')
  const fixtureFolder = resolve(home, 'workspace/chat-fixtures')
  mkdirSync(fixtureFolder, { recursive: true })
  writeFileSync(resolve(fixtureFolder, 'chat-facts.txt'), 'DURABLE_CHAT_FIXTURE_FACT: the named fixture contains three checked facts.\n')
  await api('update-bot', { id: main.id, model: model.ref, instructions: 'DURABLE_CHAT_OWNER_CONTEXT: work only on the named fixture and report the saved result.', workDir: fixtureFolder })
  await waitForIdle(main.id)
  if (!process.argv.includes('--hitl-only')) {
  const initialJobs = (await api('durable-state')).jobs.length
  const beforeSimple = rows().length
  await sendChat(main.id, 'Hello from the durable smoke bench')
  await until(() => rows().slice(beforeSimple).some(row => hasOutput(row, /收到：Hello from the durable smoke bench/)), 'ordinary short answer')
  await waitForIdle(main.id)
  assert.equal((await api('durable-state')).jobs.length, initialJobs)
  console.log('PASS: ordinary short Bot chat replies directly without creating a durable workflow')

  await sendChat(main.id, '记住 BOT_MEMORY_PROBE: preserve the checked fixtures.')
  await waitForIdle(main.id)
  await sendChat(main.id, 'BOT_CHAT_PROBE: keep the original archive intact.')
  await waitForIdle(main.id)
  await api('capability-save', { name: 'taskcap', kind: 'mcp', description: 'Bot task echo fixture', transport: 'stdio', command: process.execPath, args: [resolve(root, 'ds-bot/dev/mcp-echo-server.mjs')], env: {} })
  await api('capability-save', { name: 'taskskill', kind: 'skill', description: 'BOT_TASK_SKILL_PROBE', content: 'Use only the assigned fixture and preserve the original archive.' })
  await api('bot-capability', { botId: main.id, name: 'taskcap', attached: true })
  await api('bot-capability', { botId: main.id, name: 'taskskill', attached: true })
  const contextual = await createFromChat(main.id, 'context')
  const contextualDone = await finished(contextual.key)
  await verifyStages(contextualDone, 'context', fixtureFolder)
  assert.equal(contextualDone.botManaged, true)
  assert.equal(contextualDone.origin.botId, main.id)
  const rosterAfter = await api('state')
  assert.equal(rosterAfter.agents.some(agent => agent.sessions.some(id => contextualDone.sessionIds.includes(id))), false)
  const phase = await snapshot(contextualDone.sessionIds[0])
  const output = phase.events.filter(event => event.type === 'tool/result' || event.type === 'tool/ptc-dispatch').map(event => JSON.stringify(event.data)).join('\n')
  assert.match(output, /BOT_MCP_PROBE/)
  assert.match(output, /BOT_MEMORY_PROBE/)
  assert.match(output, /BOT_CHAT_PROBE/)
  assert.ok(phase.events.some(event => event.type === 'user/message' && JSON.stringify(event.data).includes('taskskill')), 'Worker receives its Bot skill catalog')
  const firstInput = phase.events.find(event => event.type === 'user/message' && textOf(event.data.content).includes(`[DS Bot durable request ${contextual.key}:0]`))
  assert.match(textOf(firstInput.data.content), /BOT_CHAT_PROBE/)
  assert.match(textOf(firstInput.data.content), /BOT_MEMORY_PROBE/)
  await waitForReport(main.id, contextual.key)
  console.log('PASS: Bot-owned sessions inherit chat/memory, execute the attached MCP, read owner context through tools, and receive the attached skill catalog without joining DSH Agent')

  const alpha = await createFromChat(main.id, 'alpha')
  assert.match(alpha.key, /^chat-/)
  const alphaDone = await finished(alpha.key)
  await verifyStages(alphaDone, 'alpha', fixtureFolder)
  assert.ok(rows().some(row => row.out?.some(block => block.type === 'tool_use' && block.name === 'create_durable_task')))
  const alphaReport = await waitForReport(main.id, alpha.key)
  assert.equal(notificationInputs(alphaReport, alpha.key).length, 1)
  assert.ok(rows().some(row => hasOutput(row, new RegExp(`^Durable chat report ${alpha.key}: completed; owner context present; saved results received`))))
  console.log('PASS: direct Bot chat calls create_durable_task, real Pi executes two DSH stages with inherited context/folder and returns the saved results to that Bot')
  console.log('PASS: dedicated worker sessions hide all durable/team tools and each phase receives exactly one durable input')

  const queryAt = rows().length
  await sendChat(main.id, 'Durable chat list')
  await until(() => rows().slice(queryAt).some(row => hasOutput(row, /Durable chat query:/)), 'list task tool')
  await waitForIdle(main.id)
  const getAt = rows().length
  await sendChat(main.id, `Durable chat get ${alpha.key}`)
  await until(() => rows().slice(getAt).some(row => hasOutput(row, /Durable chat query:/)), 'get task tool')
  await waitForIdle(main.id)
  assert.ok(rows().slice(getAt).some(row => row.out?.some(block => block.type === 'tool_use' && block.name === 'get_durable_task' && block.input.key === alpha.key)))
  console.log('PASS: the Bot can list and query its saved workflows through model tools')
  const resumeAt = rows().length
  await sendChat(main.id, `Durable chat resume ${alpha.key}`)
  await until(() => rows().slice(resumeAt).some(row => hasOutput(row, /^Durable chat task accepted:/)), 'resume saved key without duplicate work')
  await waitForIdle(main.id)
  assert.equal((await api('durable-state')).jobs.length, initialJobs + 2)
  assert.equal((await finished(alpha.key)).taskId, alphaDone.taskId)
  const afterResume = await snapshot(await chatOf(main.id))
  assert.equal(notificationInputs(afterResume, alpha.key).length, 1)
  console.log('PASS: resuming the same saved key through a new model call reuses its task and does not repeat its result callback')

  const other = await api('create-bot', { name: 'Other fixture', role: 'Fixture', instructions: 'Reply only about your own mock work.', model: model.ref })
  await waitForIdle(other.id)
  const foreignAt = rows().length
  await sendChat(other.id, `Durable chat get ${alpha.key}`)
  await until(() => rows().slice(foreignAt).some(row => hasOutput(row, /Durable chat query:/)), 'cross-Bot task query refusal')
  await waitForIdle(other.id)
  const foreignReply = rows().slice(foreignAt).flatMap(row => row.out ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
  assert.doesNotMatch(foreignReply, /Durable chat stage [12] alpha finished/)
  assert.match(foreignReply, /No durable task with that key belongs to this Bot chat/)
  const otherSnapshot = await snapshot(await chatOf(other.id))
  assert.equal(notificationInputs(otherSnapshot, alpha.key).length, 0)
  console.log('PASS: another Bot cannot read the private task result or receive its completion callback')

  const restarting = await createFromChat(main.id, 'restart')
  const boundary = await until(async () => {
    const job = (await api('durable-state', { key: restarting.key })).jobs[0]
    if (job?.state.status === 'terminal') throw new Error('Missed durable phase boundary before restart')
    return job?.state.status === 'sleeping' && job.state.checkpoint?.phase === 'check'
      && job.state.checkpoint.step === 1 && job.state.checkpoint.results?.length === 1 && !job.state.checkpoint.sent ? job : undefined
  }, 'first phase checkpoint')
  await stop(dsh, true)
  await startDsh()
  const recovered = await finished(restarting.key)
  assert.equal(recovered.taskId, boundary.taskId)
  assert.deepEqual(recovered.sessionIds, boundary.sessionIds)
  await verifyStages(recovered, 'restart', fixtureFolder, { historicalBeforeStage: 1 })
  const restartReport = await waitForReport(main.id, restarting.key)
  assert.equal(notificationInputs(restartReport, restarting.key).length, 1)
  const restoredAlpha = await waitForReport(main.id, alpha.key)
  assert.equal(notificationInputs(restoredAlpha, alpha.key).length, 1)
  console.log('PASS: SIGKILL at a saved phase restores the chat-created workflow and returns the result without repeating completed DSH input or prior chat notifications')

  const admitted = await createFromChat(main.id, 'admission')
  const admissionRequest = await until(() => rows().find(row => row.session === admitted.sessionIds[0]
    && row.out?.some(block => block.type === 'tool_use' && ['read', 'run_code'].includes(block.name))), 'first-stage model request before tool dispatch')
  assert.ok(admissionRequest)
  const beforeAdmissionRestart = (await api('durable-state', { key: admitted.key })).jobs[0]
  const firstWorkerId = beforeAdmissionRestart.sessionIds[0]
  assert.equal((await rpc('inspect', { sessionId: firstWorkerId, requestId: `${admitted.key}:0` }, 'inspection')).inputs, 1)
  await stop(dsh, true)
  await startDsh()
  const admissionRecovery = await finished(admitted.key)
  assert.equal(admissionRecovery.taskId, beforeAdmissionRestart.taskId)
  assert.deepEqual(admissionRecovery.sessionIds, beforeAdmissionRestart.sessionIds)
  const admittedInspection = await rpc('inspect', { sessionId: firstWorkerId, requestId: `${admitted.key}:0` }, 'inspection')
  assert.equal(admittedInspection.inputs, 1)
  const restoredWorker = await snapshot(firstWorkerId)
  assert.deepEqual(restoredWorker.callableToolNames.filter(name => [...TEAM_TOOLS.filter(tool => !['recall', 'read_own_chat', 'read_browser', 'list_capabilities', 'ask_user'].includes(tool)), 'create_goal', 'get_goal', 'update_goal', 'ask_user_question'].includes(name)), [])
  assert.equal(restoredWorker.callableToolNames.includes('read'), true)
  if (admissionRecovery.state.outcome.status === 'completed') await verifyStages(admissionRecovery, 'admission', fixtureFolder)
  else assert.equal(admissionRecovery.state.outcome.error.code, 'NEEDS_RECONCILIATION')
  const admissionReport = await waitForReport(main.id, admitted.key)
  assert.equal(notificationInputs(admissionReport, admitted.key).length, 1)
  console.log('PASS: SIGKILL after DSH admission restores the worker tool boundary and never resubmits an uncertain input')

  await stop(dsh)
  assert.notEqual(dsh.signalCode, 'SIGKILL', 'The clean restart must not require a forced shutdown')
  await startDsh()
  // Observe at least two notification sweeps before concluding a restart is quiet.
  await delay(2500)
  await waitForIdle(main.id)
  const afterRestart = await snapshot(await chatOf(main.id))
  assert.equal(notificationInputs(afterRestart, alpha.key).length, 1)
  assert.equal(notificationInputs(afterRestart, restarting.key).length, 1)
  assert.equal(notificationInputs(afterRestart, admitted.key).length, 1)
  assert.equal(afterRestart.inbox.some(message => message.source?.role === 'durable'), false)
  assert.equal((await api('durable-state')).jobs.length, initialJobs + 4)
  console.log('PASS: a second clean Host restart preserves task identities/results and acknowledged chat reports')
  const cancellable = await createFromChat(main.id, 'cancel')
  await until(() => existsSync(resolve(fixtureFolder, 'cancel-started.txt')), 'real cancellable shell process started')
  await waitForIdle(main.id)
  const foreignCancelAt = rows().length
  await sendChat(other.id, `Durable chat cancel ${cancellable.key}`)
  await until(() => rows().slice(foreignCancelAt).some(row => hasOutput(row, /Durable chat cancel:/)), 'foreign cancellation refusal')
  await waitForIdle(other.id)
  const refusal = rows().slice(foreignCancelAt).flatMap(row => row.out ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
  assert.match(refusal, /No durable task with that key belongs to this Bot chat/)
  assert.equal((await api('durable-state', { key: cancellable.key })).jobs[0].state.status === 'terminal', false)
  const cancelAt = rows().length
  await sendChat(main.id, '停止')
  await until(() => rows().slice(cancelAt).some(row => row.out?.some(block => block.type === 'tool_use' && block.name === 'cancel_durable_task')), 'natural stop calls cancellation tool')
  const cancelled = await finished(cancellable.key)
  assert.equal(cancelled.state.outcome.status, 'aborted', JSON.stringify(cancelled.state.outcome))
  assert.equal((await snapshot(cancelled.sessionIds[0])).status, 'idle')
  assert.equal((await rpc('inspect', { sessionId: cancelled.sessionIds[1], requestId: `${cancellable.key}:1` }, 'inspection')).inputs, 0)
  await waitForReport(main.id, cancellable.key)
  await delay(1000)
  assert.equal(existsSync(resolve(fixtureFolder, 'cancel-finished.txt')), false)
  await stop(dsh)
  await startDsh()
  assert.equal((await finished(cancellable.key)).state.outcome.status, 'aborted')
  await delay(1000)
  assert.equal(existsSync(resolve(fixtureFolder, 'cancel-finished.txt')), false)
  assert.equal((await rpc('inspect', { sessionId: cancelled.sessionIds[1], requestId: `${cancellable.key}:1` }, 'inspection')).inputs, 0)
  console.log('PASS: natural stop cancels the owned live shell, refuses another Bot, skips later stages, and stays cancelled after restart')
  const pausable = await createFromChat(main.id, 'pause')
  await until(() => existsSync(resolve(fixtureFolder, 'pause-started.txt')), 'admitted pause fixture started')
  await waitForIdle(main.id)
  const pauseAt = rows().length
  await sendChat(main.id, '先暂停')
  await until(() => rows().slice(pauseAt).some(row => row.out?.some(block => block.type === 'tool_use' && block.name === 'pause_durable_task')), 'natural pause tool')
  const parked = await until(async () => { const job = (await api('durable-state', { key: pausable.key })).jobs[0]; return job.paused && job }, 'saved step boundary pause')
  assert.equal(parked.state.checkpoint.step, 1)
  assert.equal(existsSync(resolve(fixtureFolder, 'pause-finished.txt')), true)
  assert.equal(readFileSync(resolve(fixtureFolder, 'pause-started.txt'), 'utf8'), 'started')
  assert.equal((await rpc('inspect', { sessionId: parked.sessionIds[1], requestId: `${pausable.key}:1` }, 'inspection')).inputs, 0)
  await stop(dsh)
  await startDsh()
  const afterPauseRestart = (await api('durable-state', { key: pausable.key })).jobs[0]
  assert.equal(afterPauseRestart.paused, true)
  assert.equal(afterPauseRestart.state.checkpoint.step, 1)
  await delay(1000)
  assert.equal((await rpc('inspect', { sessionId: parked.sessionIds[1], requestId: `${pausable.key}:1` }, 'inspection')).inputs, 0)
  await waitForIdle(main.id)
  const continueAt = rows().length
  await sendChat(main.id, '继续')
  await until(() => rows().slice(continueAt).some(row => row.out?.some(block => block.type === 'tool_use' && block.name === 'resume_durable_task')), 'natural continue tool')
  const resumed = await finished(pausable.key)
  assert.equal(resumed.state.outcome.status, 'completed', JSON.stringify(resumed.state.outcome))
  assert.equal(resumed.state.outcome.result.length, 2)
  assert.match(resumed.state.outcome.result[1], /earlier result present/)
  assert.equal(readFileSync(resolve(fixtureFolder, 'pause-started.txt'), 'utf8'), 'started', 'The first shell must never replay')
  await waitForReport(main.id, pausable.key)
  assert.equal((await rpc('inspect', { sessionId: parked.sessionIds[0], requestId: `${pausable.key}:0` }, 'inspection')).inputs, 1)
  assert.equal((await rpc('inspect', { sessionId: parked.sessionIds[1], requestId: `${pausable.key}:1` }, 'inspection')).inputs, 1)
  console.log('PASS: natural pause saves the live step, survives Host restart, and continue runs only the remaining stage with saved outputs')
  }
  for (const replyMode of ['card', 'chat']) {
    await waitForIdle(main.id)
    const count = (await api('durable-state')).jobs.length
    await sendChat(main.id, 'Durable HITL fixture')
    const held = await until(async () => { const jobs = (await api('durable-state')).jobs; return jobs.length > count && jobs.at(-1).state.status === 'waiting' && jobs.at(-1).question && jobs.at(-1) }, 'persisted human question')
    const questionId = held.question.id
    const originalTaskId = held.taskId
    const workerId = held.sessionIds[0]
    const asked = await until(async () => (await api('state')).questions[await chatOf(main.id)], 'question in Bot composer')
    assert.equal(asked.id, questionId)
    const before = await snapshot(workerId)
    assert.equal(before.events.filter(event => event.type === 'tool/call' && event.data.name === 'read').length, 1)
    await stop(dsh)
    await startDsh()
    await until(async () => (await api('state')).questions[await chatOf(main.id)]?.id === questionId, 'same question after restart')
    if (replyMode === 'card') await api('answer-question', { sessionId: main.id, questionId, answer: { selected: ['Continue'] } })
    else await sendChat(main.id, 'HITL answer: continue please')
    const resumed = await finished(held.key)
    assert.equal(resumed.taskId, originalTaskId)
    assert.equal(resumed.state.outcome.status, 'completed', JSON.stringify(resumed.state.outcome))
    assert.match(resumed.state.outcome.result[0], /HITL resumed in original session/)
    const after = await snapshot(workerId)
    assert.equal(after.events.filter(event => event.type === 'tool/call' && event.data.name === 'read').length, 1)
    assert.equal(after.events.filter(event => event.type === 'user/message' && textOf(event.data.content).startsWith('[DS Bot durable request')).length, 2)
    await assert.rejects(api('answer-question', { sessionId: main.id, questionId, answer: { selected: ['Continue'] } }), /no longer open/)
    await waitForReport(main.id, held.key)
    console.log(`PASS: ${replyMode} answer resumes the same persisted task/session after restart, without replaying its read`)
  }
  await waitForIdle(main.id)
  const beforeNotice = (await api('durable-state')).jobs.length
  await sendChat(main.id, 'Durable NOTICE fixture')
  const noticed = await until(async () => { const jobs = (await api('durable-state')).jobs; return jobs.length > beforeNotice && jobs.at(-1) }, 'engine notice fixture')
  const completedNotice = await finished(noticed.key)
  assert.equal(completedNotice.state.outcome.status, 'completed')
  const noticeHistory = await snapshot(completedNotice.sessionIds[0])
  const sources = noticeHistory.events.filter(event => event.type === 'user/message').map(event => `${event.data.source?.kind}:${event.data.source?.form}`)
  assert.ok(sources.includes('repeat-tool-reminder:notice'), 'The native repeated-tool reminder must actually have run')
  assert.ok(sources.includes('tool-jobs:notice'), 'The owned job completion must actually have reached the worker')
  console.log('PASS: real DSH repeated-tool and background-job notices no longer interrupt the durable task')
  console.log('Durable chat smoke passed')
} finally {
  for (const child of children.toReversed()) await stop(child)
}
