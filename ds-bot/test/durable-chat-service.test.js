import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { install } from '../src/host/durable/index.js'

async function bench(t, { permission = 'workspace-write', capabilities = [], behavior = 'complete', enabled = true, workerRestrictFails = false, ptc = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsb-durable-chat-'))
  const effects = []
  const listeners = new Map()
  const calls = { allocated: [], selected: [], prompts: [], presets: [], tools: new Map(), modelFails: false, cancelled: [],
    sourceTools: ['read', 'bash', 'subagent', 'list_bots', 'create_durable_task'],
    globalTools: ['read', 'bash', 'list_bots', 'create_durable_task', 'create_goal', 'update_goal', 'get_goal', 'ask_user_question'],
    workerTools: new Map(), guards: new Map() }
  const records = new Map()
  const sessions = new Map()
  const bots = { chief: { id: 'chief', name: 'Chief', instructions: 'Keep the original user scope. OWNER_CONTEXT', model: 'other/default', capabilities },
    peer: { id: 'peer', name: 'Peer', model: 'other/default' } }
  const agents = { raw: { id: 'raw', sessions: [] } }
  const append = (id, event) => { const agent = sessions.get(id); records.get(id).push({ event: { ...event, seq: agent.session.seq++ } }) }
  const makeSession = (id, cwd = '/task-workspace') => {
    const agent = { id, session: { id, seq: 0, header: { cwd } }, status: 'idle', inbox: { nextStep: [], nextTurn: [] } }
    agent.cancel = () => {
      calls.cancelled.push(id)
      agent.inbox.nextStep = []; agent.inbox.nextTurn = []
      if (agent.status === 'running') append(id, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
      agent.status = 'idle'
    }
    agent.whenIdle = async () => {}
    if (id.startsWith('worker-')) {
      calls.workerTools.set(id, [...calls.globalTools, 'subagent'])
      agent.ctx = { tools: { restrict(filter) {
        if (workerRestrictFails) return () => {}
        assert.equal([...(filter.allow ?? []), ...(filter.deny ?? [])].every(name => calls.globalTools.includes(name)), true, 'Only global registrations may be masked')
        calls.workerTools.set(id, calls.workerTools.get(id).filter(name => !calls.globalTools.includes(name) || ((!filter.allow || filter.allow.includes(name)) && !filter.deny?.includes(name))))
        return () => {}
      }, guard(check) { calls.guards.set(id, check); return () => {} } } }
    }
    sessions.set(id, agent); records.set(id, []); return agent
  }
  const source = makeSession('chief')
  const peer = makeSession('peer')
  const permissions = new Map([['chief', permission], ['peer', permission]])
  let bundle = { sandbox: 'workspace-write', approval: 'ask' }
  const presets = { current: session => permissions.get(session.id) ?? 'workspace-write', resolve: () => ({ ...bundle }),
    set: (session, selected) => { calls.presets.push({ sessionId: session.id, selected }); permissions.set(session.id, selected) } }
  const ctx = {
    on(name, listener) { listeners.set(name, listener) },
    tools: {
      register: tool => calls.tools.set(tool.name, tool),
      schemas(agent) {
        const available = agent === undefined ? calls.globalTools : calls.workerTools.get(agent.id) ?? calls.sourceTools
        return (agent !== undefined && ptc ? ['run_code', ...available.filter(name => ['subagent', 'list_bots', 'create_durable_task'].includes(name))] : available).map(name => ({ name }))
      },
      get: (name, agent) => (calls.workerTools.get(agent?.id) ?? calls.sourceTools).includes(name) ? { name } : undefined,
    },
    effect(execute) { effects.push(execute()) },
    get: name => name === 'permissionPresets' ? presets : name === 'sessionProjections' ? ctx.sessionProjections : undefined,
    sessionProjections: { snapshot: () => ({ values: { modelSelection: { lastUsed: { provider: 'mock', model: 'actual', reasoningEffort: 'high' } } } }) },
    sessionController: {
      async resolveAgent(id) { return sessions.has(id) ? { agent: sessions.get(id) } : { error: { message: 'Unavailable session' } } },
      async create(options) { const sessionId = `worker-${calls.allocated.length + 1}`; calls.allocated.push(options); makeSession(sessionId, options.cwd); return { sessionId } },
      async page({ address, throughSeq }) { return { records: records.get(address.sessionId).filter(record => record.event.seq <= throughSeq), hasMore: false } },
      async prompt(request) {
        calls.prompts.push(request)
        const agent = sessions.get(request.sessionId); agent.status = 'running'
        append(agent.id, { type: 'turn/start', data: { turn: 1 } })
        append(agent.id, { type: 'user/message', data: { content: request.content } })
        if (behavior === 'complete') complete(agent.id)
      },
    },
    sessions: { async flush() {} },
  }
  function complete(id) {
    append(id, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Saved worker result.' }] } } })
    append(id, { type: 'turn/end', data: { reason: { kind: 'completed' } } }); sessions.get(id).status = 'idle'
  }
  const rt = {
    ctx, home, config: { durableTasks: enabled }, state: { bots, agents, prefs: {} }, live: new Map(), groupOwners: new Map([['group-chief', { botId: 'chief', roomId: 'room' }]]),
    load: async () => {}, readOnly: () => undefined, botOf: id => bots[id], selfOf: id => ['chief', 'peer', 'old-chief'].includes(id) ? id === 'old-chief' ? 'chief' : id : id === 'group-chief' ? 'chief' : undefined,
    chatOf: id => id, agentOf: id => Object.values(agents).find(agent => agent.sessions.includes(id)),
    resolveAgent: async id => sessions.get(id), sessionFolder: session => session.header.cwd, isFolder: async () => true,
    catalog: async () => [{ ref: 'mock/actual', provider: 'mock', id: 'actual' }, { ref: 'other/default', provider: 'other', id: 'default' }],
    adoptAgentSession: async (id, sessionId) => { agents[id].sessions.push(sessionId) },
    selectSessionModel: async (sessionId, route) => { calls.selected.push({ sessionId, ...route }); return calls.modelFails ? { error: true } : { selected: route } },
    renameAgentSession: async () => {}, warn() {},
  }
  install(rt)
  t.after(async () => { for (const cleanup of effects.splice(0).reverse()) await cleanup?.(); await rm(home, { recursive: true, force: true }) })
  const execute = (name, args = {}, agent = source, callId = 'call-one') => calls.tools.get(name).execute(args, { agent, callId })
  const recreate = id => {
    const previous = sessions.get(id)
    const history = records.get(id)
    const agent = makeSession(id, previous.session.header.cwd)
    agent.session = previous.session
    agent.status = previous.status
    agent.inbox = previous.inbox
    records.set(id, history)
    calls.guards.delete(id)
    return agent
  }
  const beforeStep = agent => listeners.get('agent/pre-step')({ agent, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
  return { rt, ctx, calls, bots, source, peer, execute, home, complete, recreate, beforeStep, changeBundle: value => { bundle = value } }
}
async function until(check) {
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(10) }
  throw new Error('Chat task did not reach its expected state')
}
const request = { title: 'Inspect and summarize', steps: ['Inspect a fixture.', 'Summarize the saved inspection.'] }
const state = async (b, key) => (await b.rt.durableStateForBot({ key }, { agent: b.source })).jobs[0]

test('a plain stop cancels the single task without cancelling the Bot chat', async t => {
  const b = await bench(t, { behavior: 'wait' })
  const admitted = JSON.parse(await b.execute('create_durable_task', request))
  await until(() => b.calls.prompts.length === 1)
  const response = JSON.parse(await b.execute('cancel_durable_task'))
  assert.equal(['cancelling', 'cancelled'].includes(response.status), true)
  const job = await until(async () => { const job = await state(b, admitted.key); return job.state.status === 'terminal' && job })
  assert.equal(job.state.outcome.status, 'aborted')
  assert.deepEqual(b.calls.cancelled, ['worker-1'])
  assert.equal(b.calls.prompts.length, 1)
  assert.match(b.calls.guards.get('worker-1')({ name: 'read' }), /stopping or cancelled/)
  assert.equal((await b.beforeStep(b.recreate('worker-1'))).kind, 'reject')
  assert.equal(JSON.parse(await b.execute('cancel_durable_task', { key: admitted.key })).status, 'cancelled')
})

test('ambiguous stop asks which task and another Bot cannot cancel either one', async t => {
  const b = await bench(t, { behavior: 'wait' })
  const first = JSON.parse(await b.execute('create_durable_task', request))
  const second = JSON.parse(await b.execute('create_durable_task', { ...request, title: 'Other work' }, b.source, 'other-call'))
  await until(() => b.calls.prompts.length === 2)
  assert.equal(JSON.parse(await b.execute('cancel_durable_task')).status, 'choose_task')
  assert.deepEqual(b.calls.cancelled, [])
  await assert.rejects(b.execute('cancel_durable_task', { key: first.key }, b.peer), /belongs to this Bot/)
  await b.execute('cancel_durable_task', { key: first.key })
  await until(async () => (await state(b, first.key)).state.outcome?.status === 'aborted')
  assert.notEqual((await state(b, second.key)).state.status, 'terminal')
  assert.deepEqual(b.calls.cancelled, ['worker-1'])
})

test('a stopped preparation cannot be restarted from the saved key', async t => {
  const b = await bench(t)
  b.calls.modelFails = true
  let key
  await assert.rejects(b.execute('create_durable_task', request), error => { key = /Durable task (chat-[a-f0-9]+)/.exec(error.message)?.[1]; return Boolean(key) })
  assert.equal(JSON.parse(await b.execute('cancel_durable_task', { key })).status, 'cancelled')
  b.calls.modelFails = false
  await assert.rejects(b.execute('create_durable_task', { key }), /cancelled/)
  assert.equal(b.calls.prompts.length, 0)
})
test('the owner can confirm a stop after scope reconciliation failed, without reopening execution', async t => {
  const b = await bench(t, { behavior: 'wait' })
  const admitted = JSON.parse(await b.execute('create_durable_task', request))
  await until(() => b.calls.prompts.length === 1)
  b.changeBundle({ sandbox: 'changed', approval: 'ask' })
  await until(async () => (await state(b, admitted.key)).state.status === 'terminal')
  assert.equal(JSON.parse(await b.execute('cancel_durable_task', { key: admitted.key })).status, 'cancelled')
  assert.equal((await state(b, admitted.key)).cancellation.status, 'stopped')
  await b.execute('cancel_durable_task', { key: admitted.key })
  assert.deepEqual(b.calls.cancelled, ['worker-1'])
})
test('an actual user stop joined to a report is accepted, while the report alone cannot cancel work', async t => {
  const b = await bench(t, { behavior: 'wait' })
  const admitted = JSON.parse(await b.execute('create_durable_task', request))
  b.rt.live.set('chief', { info: { role: 'durable' } })
  await assert.rejects(b.execute('cancel_durable_task', { key: admitted.key }), /direct user request/)
  b.rt.eventsBackwards = async function* () { yield { type: 'user/message', data: { source: { kind: 'user' } } }; yield { type: 'turn/start' } }
  await b.execute('cancel_durable_task', { key: admitted.key })
  await until(async () => (await state(b, admitted.key)).state.outcome?.status === 'aborted')
})

test('chat tools create real Pi work under the actual model, folder and permission', async t => {
  const b = await bench(t)
  const admitted = JSON.parse(await b.execute('create_durable_task', request))
  assert.equal(admitted.status, 'started')
  const job = await until(async () => { const job = await state(b, admitted.key); return job.state.status === 'terminal' && job })
  assert.equal(job.state.outcome.status, 'completed')
  assert.deepEqual(job.origin, { botId: 'chief', sessionId: 'chief' })
  assert.equal(b.calls.allocated.length, 2)
  assert.equal(b.calls.allocated.every(options => options.cwd === '/task-workspace' && options.agentPreset === 'standard'), true)
  assert.equal(b.calls.selected.every(route => route.provider === 'mock' && route.model === 'actual' && route.reasoningEffort === 'high'), true)
  assert.equal(b.calls.presets.every(call => call.selected === 'workspace-write'), true)
  assert.deepEqual([...b.calls.workerTools.values()], [['read', 'bash', 'subagent'], ['read', 'bash', 'subagent']])
  assert.equal(b.calls.guards.get('worker-1')({ name: 'read' }), undefined)
  assert.match(b.calls.guards.get('worker-1')({ name: 'new-scoped-tool' }), /not delegated/)
  assert.equal(b.calls.prompts.every(call => call.content[0].text.includes('OWNER_CONTEXT')), true)
  assert.match(b.calls.prompts[1].content[0].text, /Earlier phase outputs[\s\S]*Saved worker result/)
  assert.equal(JSON.parse(await b.execute('get_durable_task', { key: admitted.key })).key, admitted.key)
})

test('an already-admitted worker restores its tool boundary before a recovered step', async t => {
  const b = await bench(t, { behavior: 'wait', ptc: true })
  const admission = JSON.parse(await b.execute('create_durable_task', request))
  await until(() => b.calls.prompts.length === 1)
  const worker = b.recreate('worker-1')
  assert.equal(b.calls.workerTools.get(worker.id).includes('create_goal'), true)
  const decision = await b.beforeStep(worker)
  assert.equal(decision.kind, 'enter')
  assert.deepEqual(b.calls.workerTools.get(worker.id), ['read', 'bash', 'subagent'])
  assert.equal(b.calls.guards.get(worker.id)({ name: 'read' }), undefined)
  assert.match(b.calls.guards.get(worker.id)({ name: 'create_durable_task' }), /not delegated/)
  assert.equal((await state(b, admission.key)).state.status === 'terminal', false)
  assert.equal(b.calls.prompts.length, 1)
})

test('retries reuse a stable admission and saved setup cannot be rewritten', async t => {
  const b = await bench(t)
  const first = JSON.parse(await b.execute('create_durable_task', request))
  assert.deepEqual(JSON.parse(await b.execute('create_durable_task', request)), first)
  assert.deepEqual(JSON.parse(await b.execute('create_durable_task', { key: first.key }, b.source, 'new-call')), first)
  assert.equal(b.calls.allocated.length, 2)
  await assert.rejects(b.execute('create_durable_task', { ...request, title: 'Changed' }), /saved but could not start|cannot be changed/)
  await assert.rejects(b.execute('create_durable_task', { key: first.key, steps: ['Changed'] }), /cannot be changed/)
  await assert.rejects(b.execute('create_durable_task', { key: 'invented' }), /belongs to this Bot/)
})

test('task reads are private to the originating Bot own chat', async t => {
  const b = await bench(t)
  const first = JSON.parse(await b.execute('create_durable_task', request))
  assert.equal(JSON.parse(await b.execute('list_durable_tasks', {}, b.peer)).jobs.length, 0)
  await assert.rejects(b.execute('get_durable_task', { key: first.key }, b.peer), /belongs to this Bot/)
  for (const id of ['group-chief', 'old-chief', 'plain-agent', 'external']) {
    await assert.rejects(b.execute('create_durable_task', request, { id, session: { id } }), /own chat/)
    await assert.rejects(b.execute('list_durable_tasks', {}, { id, session: { id } }), /own chat/)
  }
})

test('background callbacks and restart recovery cannot create another task', async t => {
  const b = await bench(t)
  const first = JSON.parse(await b.execute('create_durable_task', request))
  for (const role of ['durable', 'resume', 'request', 'kickoff']) {
    b.rt.live.set('chief', { info: { role } })
    await assert.rejects(b.execute('create_durable_task', request, b.source, `call-${role}`), /cannot create a new durable task/)
    assert.equal(JSON.parse(await b.execute('create_durable_task', { key: first.key })).key, first.key)
  }
  assert.equal(b.calls.allocated.length, 2)
})

test('unsupported permissions and attached capabilities fail before allocating work', async t => {
  for (const options of [{ permission: 'auto' }, { permission: 'custom' }, { capabilities: ['private-mcp'] }]) {
    const b = await bench(t, options)
    await assert.rejects(b.execute('create_durable_task', request), /configured permission preset|capability scope/)
    assert.equal(b.calls.allocated.length, 0)
    assert.equal(b.calls.prompts.length, 0)
  }
})

test('setup failure keeps its immutable key and resumes the same allocated sessions', async t => {
  const b = await bench(t)
  b.calls.modelFails = true
  let key
  await assert.rejects(b.execute('create_durable_task', request), error => { key = /Durable task (chat-[a-f0-9]+)/.exec(error.message)?.[1]; return !!key })
  assert.equal(b.calls.allocated.length, 1)
  b.calls.modelFails = false
  await b.execute('create_durable_task', { key }, b.source, 'retry-call')
  await until(async () => (await state(b, key)).state.status === 'terminal')
  assert.equal(b.calls.allocated.length, 2)
  assert.equal(b.calls.prompts.length, 2)
})

test('a changed preset definition prevents later stages from gaining new permissions', async t => {
  const b = await bench(t, { behavior: 'wait' })
  const admitted = JSON.parse(await b.execute('create_durable_task', request))
  await until(() => b.calls.prompts.length === 1)
  b.changeBundle({ sandbox: 'danger-full-access', approval: 'never' })
  b.complete('worker-1')
  const job = await until(async () => { const job = await state(b, admitted.key); return job.state.status === 'terminal' && job })
  assert.equal(job.state.outcome.status, 'failed')
  assert.equal(b.calls.prompts.length, 1)
})

test('disabled chat tools create no task storage', async t => {
  const b = await bench(t, { enabled: false })
  await assert.rejects(b.execute('create_durable_task', request), /disabled/)
  assert.deepEqual(JSON.parse(await b.execute('list_durable_tasks')), { enabled: false, jobs: [], total: 0 })
  assert.deepEqual(await readdir(b.home), [])
})


test('a worker that retains team or goal tools never starts a model turn', async t => {
  const b = await bench(t, { workerRestrictFails: true })
  await assert.rejects(b.execute('create_durable_task', request), /Team tools could not be removed/)
  assert.equal(b.calls.prompts.length, 0)
})

test('new Bot capabilities stop subsequent stages instead of changing worker access', async t => {
  const b = await bench(t, { behavior: 'wait' })
  const admitted = JSON.parse(await b.execute('create_durable_task', request))
  await until(() => b.calls.prompts.length === 1)
  b.bots.chief.capabilities = ['new-private-mcp']
  b.complete('worker-1')
  const job = await until(async () => { const job = await state(b, admitted.key); return job.state.status === 'terminal' && job })
  assert.equal(job.state.outcome.status, 'failed')
  assert.equal(job.state.outcome.error.completed, 1)
  assert.equal(b.calls.prompts.length, 1)
})


test('PTC transport presentation preserves the originating Bot actual file and command tools', async t => {
  const b = await bench(t, { ptc: true })
  assert.deepEqual(b.ctx.tools.schemas(b.source).map(tool => tool.name), ['run_code', 'subagent', 'list_bots', 'create_durable_task'])
  const admitted = JSON.parse(await b.execute('create_durable_task', request))
  const job = await until(async () => { const job = await state(b, admitted.key); return job.state.status === 'terminal' && job })
  assert.equal(job.state.outcome.status, 'completed')
  assert.deepEqual(b.calls.workerTools.get('worker-1'), ['read', 'bash', 'subagent'])
  assert.equal(b.calls.guards.get('worker-1')({ name: 'run_code' }), undefined)
  assert.equal(b.calls.guards.get('worker-1')({ name: 'read' }), undefined)
  assert.match(b.calls.guards.get('worker-1')({ name: 'create_goal' }), /not delegated/)
})

test('tool execution facades resolve to the public Agent before capturing scoped tools', async t => {
  const b = await bench(t)
  const facade = { id: b.source.id, session: b.source.session }
  const schemas = b.ctx.tools.schemas
  const get = b.ctx.tools.get
  b.ctx.tools.schemas = agent => agent === facade ? [{ name: 'create_durable_task' }] : schemas(agent)
  b.ctx.tools.get = (name, agent) => agent === facade ? name === 'create_durable_task' ? { name } : undefined : get(name, agent)
  const admitted = JSON.parse(await b.execute('create_durable_task', request, facade))
  const job = await until(async () => { const job = await state(b, admitted.key); return job.state.status === 'terminal' && job })
  assert.equal(job.state.outcome.status, 'completed')
  assert.deepEqual(b.calls.workerTools.get('worker-1'), ['read', 'bash', 'subagent'])
})

test('chat pause preserves an admitted step, blocks later workers, and continue reuses the task and saved results', async t => {
  const b = await bench(t, { behavior: 'running' })
  const admitted = JSON.parse(await b.execute('create_durable_task', request))
  await until(() => b.calls.prompts.length === 1)
  assert.equal(JSON.parse(await b.execute('pause_durable_task')).status, 'pausing')
  assert.equal((await b.beforeStep(b.recreate('worker-1'))).kind, 'enter', 'Current step may finish')
  assert.equal((await b.beforeStep(b.recreate('worker-2'))).kind, 'reject')
  b.complete('worker-1')
  const paused = await until(async () => { const job = await state(b, admitted.key); return job.paused && job })
  assert.deepEqual(paused.state.checkpoint.results, ['Saved worker result.'])
  assert.equal(b.calls.prompts.length, 1)
  assert.deepEqual(b.calls.cancelled, [])
  assert.equal((await b.beforeStep(b.recreate('worker-1'))).kind, 'reject', 'No late worker step while parked')
  assert.equal(JSON.parse(await b.execute('resume_durable_task')).status, 'running')
  await until(() => b.calls.prompts.length === 2)
  assert.match(JSON.stringify(b.calls.prompts[1].content), /Saved worker result/)
  assert.equal((await b.beforeStep(b.recreate('worker-2'))).kind, 'enter')
  b.complete('worker-2')
  await until(async () => (await state(b, admitted.key)).state.status === 'terminal')
  assert.equal((await b.rt.durableStateForBot({}, { agent: b.source })).jobs.length, 1)
  await assert.rejects(b.execute('resume_durable_task', { key: admitted.key }), /unfinished/)
})
test('pause and continue select only one matching task and reject foreign or background control', async t => {
  const b = await bench(t, { behavior: 'running' })
  const first = JSON.parse(await b.execute('create_durable_task', request))
  const second = JSON.parse(await b.execute('create_durable_task', { ...request, title: 'Other' }, b.source, 'call-two'))
  assert.equal(JSON.parse(await b.execute('pause_durable_task')).status, 'choose_task')
  await assert.rejects(b.execute('pause_durable_task', { key: first.key }, b.peer), /belongs to this Bot/)
  await assert.rejects(b.execute('resume_durable_task', { key: first.key }, b.peer), /belongs to this Bot/)
  await b.execute('pause_durable_task', { key: first.key })
  assert.equal(JSON.parse(await b.execute('resume_durable_task')).key, first.key)
  await b.execute('pause_durable_task', { key: first.key })
  await b.execute('pause_durable_task', { key: second.key })
  assert.equal(JSON.parse(await b.execute('resume_durable_task')).status, 'choose_task')
  b.rt.live.set('chief', { info: { durableKey: first.key } })
  await assert.rejects(b.execute('resume_durable_task', { key: first.key }), /direct user request/)
  b.rt.eventsBackwards = async function* () { yield { type: 'user/message', data: { source: { kind: 'user' } } }; yield { type: 'turn/start' } }
  await b.execute('resume_durable_task', { key: first.key })
  b.rt.live.delete('chief')
  await b.execute('cancel_durable_task', { key: second.key })
  await until(async () => (await state(b, second.key)).state.status === 'terminal')
  await assert.rejects(b.execute('resume_durable_task', { key: second.key }), /unfinished/)
})
test('chat pauses failed setup until an explicit continue finishes the original allocation', async t => {
  const b = await bench(t)
  b.calls.modelFails = true
  await assert.rejects(b.execute('create_durable_task', request), /saved but could not start/)
  const key = (await b.rt.durableStateForBot({}, { agent: b.source })).jobs[0].key
  assert.equal(JSON.parse(await b.execute('pause_durable_task')).status, 'paused')
  await assert.rejects(b.execute('create_durable_task', { key }), /paused/)
  b.calls.modelFails = false
  assert.equal(JSON.parse(await b.execute('resume_durable_task')).key, key)
  await until(async () => (await state(b, key)).state.status === 'terminal')
  assert.equal(b.calls.allocated.length, 2)
  assert.equal(b.calls.prompts.length, 2)
})

test('continue rechecks the original execution scope instead of granting changed capabilities', async t => {
  const b = await bench(t, { behavior: 'running' })
  const admitted = JSON.parse(await b.execute('create_durable_task', request))
  await until(() => b.calls.prompts.length === 1)
  await b.execute('pause_durable_task')
  b.complete('worker-1')
  await until(async () => (await state(b, admitted.key)).paused)
  b.bots.chief.capabilities = ['new-capability']
  await b.execute('resume_durable_task')
  const failed = await until(async () => { const job = await state(b, admitted.key); return job.state.status === 'terminal' && job })
  assert.equal(failed.state.outcome.error.code, 'NEEDS_RECONCILIATION')
  assert.equal(failed.state.outcome.error.completed, 1)
  assert.equal(b.calls.prompts.length, 1)
})

test('Bot owns new execution sessions and captures bounded redacted chat and memory once', async t => {
  const b = await bench(t)
  b.rt.state.mainBotIds = ['chief']
  b.rt.redactSecrets = text => text.replaceAll('FIXTURE_PRIVATE_VALUE', '<hidden>')
  b.rt.memoryContextForTask = async id => { assert.equal(id, 'chief'); return 'MEMORY_OWNER_FACT: use the checked fixture. FIXTURE_PRIVATE_VALUE' }
  b.rt.eventsBackwards = async function* () {
    yield { type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'text', text: 'Recent Bot explanation.' }] } } }
    yield { type: 'user/message', seq: 3, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'CHAT_OWNER_FACT: preserve the archive. FIXTURE_PRIVATE_VALUE' }] } }
    yield { type: 'tool/result', seq: 2, data: { output: 'DO_NOT_COPY_TOOL_OUTPUT' } }
  }
  const admitted = JSON.parse(await b.execute('create_durable_task', request))
  const job = await until(async () => { const job = await state(b, admitted.key); return job.state.status === 'terminal' && job })
  assert.equal(job.botManaged, true)
  assert.equal(job.ownerName, 'Chief')
  assert.deepEqual(b.rt.state.agents.raw.sessions, [])
  assert.deepEqual(b.rt.durableOwnerOf('worker-1'), { botId: 'chief', sessionId: 'chief' })
  assert.equal(b.rt.selfOf('worker-1'), undefined, 'Task sessions never masquerade as private-chat segments')
  assert.match(b.calls.prompts[0].content[0].text, /CHAT_OWNER_FACT[\s\S]*preserve the archive/)
  assert.match(b.calls.prompts[0].content[0].text, /MEMORY_OWNER_FACT/)
  assert.doesNotMatch(b.calls.prompts[0].content[0].text, /FIXTURE_PRIVATE_VALUE|DO_NOT_COPY_TOOL_OUTPUT/)
  b.rt.memoryContextForTask = async () => 'NEW_MEMORY_MUST_NOT_REWRITE_SAVED_CONTEXT'
  await b.execute('create_durable_task', request)
  assert.equal(b.calls.allocated.length, 2)
  assert.equal(b.calls.prompts.length, 2)
})

test('attached capabilities mount into Bot work sessions and definition drift blocks new tools', async t => {
  const b = await bench(t, { capabilities: ['fixture-pack'], behavior: 'wait' })
  let revision = 'a'
  b.rt.capabilityFingerprint = bot => ({ names: [...bot.capabilities], digest: revision.repeat(64) })
  b.calls.sourceTools.push('mcp__fixture__echo', 'recall', 'read_own_chat')
  b.rt.requireCapabilities = async id => {
    if (id.startsWith('worker-')) b.calls.workerTools.set(id, [...b.calls.workerTools.get(id), 'mcp__fixture__echo', 'recall', 'read_own_chat'])
  }
  const admitted = JSON.parse(await b.execute('create_durable_task', request))
  await until(() => b.calls.prompts.length === 1)
  assert.equal(b.rt.durableCapabilityBot('worker-1').id, 'chief')
  assert.equal(b.calls.guards.get('worker-1')({ name: 'mcp__fixture__echo' }), undefined)
  assert.equal(b.calls.guards.get('worker-1')({ name: 'recall' }), undefined)
  assert.match(b.calls.guards.get('worker-1')({ name: 'request_desktop_update' }), /not delegated/)
  await assert.rejects(b.rt.assertBotDurableAvailable('chief'), /unfinished/)
  await b.rt.assertBotDurableAvailable('peer')
  revision = 'b'
  assert.equal(b.rt.durableCapabilityBot('worker-1'), undefined)
  assert.match(b.calls.guards.get('worker-1')({ name: 'mcp__fixture__echo' }), /scope changed/)
  const failed = await until(async () => { const job = await state(b, admitted.key); return job.state.status === 'terminal' && job })
  assert.equal(failed.state.outcome.status, 'failed')
  assert.equal(b.calls.prompts.length, 1)
})

test('Settings tasks use the same Bot owner, context and execution path as chat', async t => {
  const b = await bench(t)
  b.rt.state.mainBotIds = ['chief']
  const admitted = await b.rt.durableEndpoint('durable-create', { key: 'settings-owned', title: request.title, prompts: request.steps, model: 'mock/actual', botId: 'chief' })
  const job = await until(async () => { const job = (await b.rt.durableEndpoint('durable-state', { key: admitted.key })).jobs[0]; return job.state.status === 'terminal' && job })
  assert.equal(job.origin.botId, 'chief')
  assert.equal(job.botManaged, true)
  assert.deepEqual(b.rt.state.agents.raw.sessions, [])
  await assert.rejects(b.rt.durableEndpoint('durable-create', { key: 'settings-owned', botId: 'peer' }), /different Bot/)
})
