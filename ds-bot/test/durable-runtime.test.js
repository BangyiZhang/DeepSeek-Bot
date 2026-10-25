import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDurableRuntime} from '../src/host/durable/runtime.js'
async function bench(t,executor,options={}){const home=await mkdtemp(join(tmpdir(),'dsb-durable-'));const config={database:join(home,'tasks.sqlite'),executor,pollMs:5,...options};let runtime=await openDurableRuntime(config);t.after(async()=>{await runtime.close();await rm(home,{recursive:true,force:true})});return{database:config.database,get runtime(){return runtime},async reopen(){await runtime.close();runtime=await openDurableRuntime(config)}}}
const job=(key='job',sessionId='session')=>({key,steps:[{sessionId,prompt:'read the test fixture'}]})
test('native Pi abort stops DSH once, preserves cancellation across reopen, and never runs the next stage', async t => {
  let sends = 0
  let stops = 0
  const b = await bench(t, { inspect: async () => ({ status: sends ? 'running' : 'absent' }), dispatch: async () => { sends += 1 }, stop: async () => { stops += 1; return { status: 'stopped' } } })
  await b.runtime.submit({ key: 'cancel', steps: [{ sessionId: 'first', prompt: 'first' }, { sessionId: 'second', prompt: 'second' }] })
  while (!sends) await new Promise(resolve => setTimeout(resolve, 5))
  await b.runtime.cancel('cancel')
  assert.equal((await b.runtime.wait('cancel')).state.outcome.status, 'aborted')
  await b.reopen()
  assert.equal((await b.runtime.get('cancel')).state.outcome.status, 'aborted')
  assert.equal(sends, 1)
  assert.equal(stops, 1)
  assert.equal((await b.runtime.blockingSessions()).size, 0)
})
test('unconfirmed cancellation stays reviewable with saved phase results', async t => {
  const b = await bench(t, { inspect: async i => ({ status: i.sessionId === 'first' ? 'completed' : 'running', result: 'saved first' }), dispatch: async () => {}, stop: async () => ({ status: 'uncertain' }) })
  await b.runtime.submit({ key: 'cancel', steps: [{ sessionId: 'first', prompt: 'first' }, { sessionId: 'second', prompt: 'second' }] })
  while ((await b.runtime.get('cancel')).state.checkpoint?.step !== 1) await new Promise(resolve => setTimeout(resolve, 5))
  await b.runtime.cancel('cancel')
  const record = await b.runtime.wait('cancel')
  assert.equal(record.state.outcome.error.code, 'CANCEL_UNCONFIRMED')
  assert.deepEqual(record.state.outcome.error.results, ['saved first'])
  assert.equal((await b.runtime.blockingSessions()).has('second'), true)
})
test('cancelled preparation cannot resume after restart', async t => {
  const b = await bench(t, { inspect: async () => ({ status: 'absent' }), dispatch: async () => assert.fail('cancelled setup') })
  await b.runtime.prepareCreate({ key: 'draft', title: 'Draft', prompts: ['Do work'], model: 'test/model' })
  await b.runtime.cancel('draft')
  await b.reopen()
  assert.equal((await b.runtime.getCreate('draft')).cancelled, true)
  await assert.rejects(b.runtime.submit(job('draft')), /cancelled/)
})
test('cancellation waits for in-flight DSH admission before confirming the stop', async t => {
  let release
  let entered = false
  let admitted = false
  let stops = 0
  const b = await bench(t, { inspect: async () => ({ status: admitted ? 'running' : 'absent' }),
    dispatch: async () => { entered = true; await new Promise(resolve => { release = resolve }); admitted = true },
    stop: async () => { assert.equal(admitted, true); stops += 1; return { status: 'stopped' } } })
  await b.runtime.submit(job())
  while (!entered) await new Promise(resolve => setTimeout(resolve, 5))
  const cancelling = b.runtime.cancel('job')
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(stops, 0)
  release()
  await cancelling
  assert.equal((await b.runtime.wait('job')).state.outcome.status, 'aborted')
  assert.equal(stops, 1)
})
test('a persisted abort mark resumes cancellation after Host shutdown, never normal dispatch', async t => {
  let release
  let stops = 0
  let sends = 0
  const b = await bench(t, { inspect: async () => ({ status: 'running' }), dispatch: async () => { sends += 1 },
    stop: async () => { stops += 1; return stops === 1 ? new Promise(resolve => { release = resolve }) : { status: 'stopped' } } })
  await b.runtime.submit(job())
  await b.runtime.cancel('job')
  while (!release) await new Promise(resolve => setTimeout(resolve, 5))
  const closing = b.runtime.close()
  release({ status: 'uncertain' })
  await closing
  await b.reopen()
  assert.equal((await b.runtime.wait('job')).state.outcome.status, 'aborted')
  assert.equal(sends, 0)
  assert.equal(stops, 2)
})
test('real Pi SQLite preserves completed tasks and deduplicates admission after reopen',async t=>{let calls=0;const done=new Set();const b=await bench(t,{inspect:async i=>({status:done.has(i.requestId)?'completed':'absent',result:'done'}),dispatch:async i=>{calls++;done.add(i.requestId)}});const one=await b.runtime.submit(job());assert.equal((await b.runtime.wait('job')).state.outcome.status,'completed');await b.reopen();assert.deepEqual(await b.runtime.submit(job()),one);assert.equal(calls,1);await assert.rejects(b.runtime.submit({...job(),steps:[{sessionId:'session',prompt:'other'}]}),/different input/);await assert.rejects(b.runtime.submit(job('other')),/exclusive/)});
test('ambiguous and interrupted execution fail closed without redispatch',async t=>{for(const status of ['uncertain','interrupted']){let calls=0;const b=await bench(t,{inspect:async()=>({status}),dispatch:async()=>{calls++}});await b.runtime.submit(job());const result=await b.runtime.wait('job');assert.equal(result.state.outcome.error.code,'NEEDS_RECONCILIATION');assert.equal(calls,0)}});
test('a missing acknowledged request is not resent',async t=>{let sent=0;const b=await bench(t,{inspect:async()=>({status:'absent'}),dispatch:async()=>{sent++}});await b.runtime.submit(job());const result=await b.runtime.wait('job');assert.equal(result.state.outcome.status,'failed');assert.equal(sent,1)});
test('inherited object names are real keys; malformed input is refused',async t=>{const b=await bench(t,{inspect:async()=>({status:'completed',result:'safe'}),dispatch:async()=>assert.fail('unexpected dispatch')});await assert.rejects(b.runtime.submit({key:'bad',steps:[null]}),/Supply/);await b.runtime.submit(job('constructor'));assert.equal((await b.runtime.wait('constructor')).state.outcome.status,'completed');assert.equal(await b.runtime.get('toString'),undefined)});
test('observing an already committed checkpoint cannot fail the task',async t=>{const b=await bench(t,{inspect:async()=>({status:'completed',result:'done'}),dispatch:async()=>{}},{checkpoint:()=>{throw Error('observer')}});await b.runtime.submit(job());assert.equal((await b.runtime.wait('job')).state.outcome.status,'completed')});
test('exclusive session reservations survive reopen and reject duplicate steps',async t=>{const b=await bench(t,{inspect:async()=>({status:'completed',result:'done'}),dispatch:async()=>{}});await b.runtime.submit(job());await b.runtime.wait('job');await b.reopen();await assert.rejects(b.runtime.submit(job('again')),/exclusive/);await assert.rejects(b.runtime.submit({key:'same',steps:[{sessionId:'new',prompt:'a'},{sessionId:'new',prompt:'b'}]}),/exclusive/)});
test('two runtime owners cannot drive the same SQLite file', async t => {
  const executor = { inspect: async () => ({ status: 'completed', result: 'done' }), dispatch: async () => {} }
  const directory = await mkdtemp(join(tmpdir(), 'dsb-durable-writer-'))
  const options = { database: join(directory, 'tasks.sqlite'), executor }
  const runtime = await openDurableRuntime(options)
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }) })
  await assert.rejects(openDurableRuntime(options), /already has a writer/)
})
test('a changed pre-admission history is retried without recording a false receipt', async t => {
  let attempts = 0
  let sent = false
  const b = await bench(t, {
    inspect: async () => ({ status: sent ? 'completed' : 'absent', result: 'done' }),
    dispatch: async () => { attempts += 1; if (attempts === 1) return { status: 'uncertain', reason: 'history_changed', reused: true }; sent = true },
  })
  await b.runtime.submit(job())
  assert.equal((await b.runtime.wait('job')).state.outcome.status, 'completed')
  assert.equal(attempts, 2)
})
test('creation descriptors and allocations survive reopen without changing the original identity', async t => {
  const b = await bench(t, { inspect: async () => ({ status: 'completed', result: 'done' }), dispatch: async () => {} })
  const request = { key: 'create', title: 'Research', prompts: ['Find facts', 'Write report'], model: 'test/model' }
  await b.runtime.prepareCreate(request)
  await b.runtime.updateCreateAllocation('create', { agentId: 'agent', index: 0, sessionId: 'first' })
  await b.reopen()
  assert.equal((await b.runtime.prepareCreate(request)).agentId, 'agent')
  assert.deepEqual((await b.runtime.getCreate('create')).sessions, ['first'])
  assert.deepEqual(await b.runtime.list(), ['create'])
  assert.ok((await b.runtime.blockingSessions()).has('first'))
  await assert.rejects(b.runtime.prepareCreate({ ...request, model: 'test/other' }), /different task/)
  await assert.rejects(b.runtime.updateCreateAllocation('create', { index: 0, sessionId: 'replacement' }), /cannot be replaced/)
  await assert.rejects(b.runtime.submit({ key: 'foreign', steps: [{ sessionId: 'first', prompt: 'other' }] }), /exclusive/)
})
test('later phases receive saved results and failures preserve already completed work', async t => {
  const prompts = []
  const sent = new Set()
  const b = await bench(t, {
    inspect: async input => ({ status: input.sessionId === 'third' ? 'interrupted' : sent.has(input.requestId) ? 'completed' : 'absent', result: `saved ${input.sessionId}` }),
    dispatch: async input => { prompts.push(input.prompt); sent.add(input.requestId) },
  })
  await b.runtime.submit({ key: 'phases', steps: ['first', 'second', 'third'].map(sessionId => ({ sessionId, prompt: `Do ${sessionId}` })) })
  const record = await b.runtime.wait('phases')
  assert.match(prompts[1], /saved first/)
  assert.match(prompts[1], /^Do second/)
  assert.equal(record.state.outcome.error.completed, 2)
  assert.deepEqual(record.state.outcome.error.results, ['saved first', 'saved second'])
})
test('unmatched startup activity is observed without dispatch and has a bounded wait', async t => {
  let reads = 0
  let sent = false
  let sends = 0
  const ready = await bench(t, {
    inspect: async () => ++reads < 3 ? { status: 'uncertain', reason: 'unmatched_activity' } : { status: sent ? 'completed' : 'absent', result: 'done' },
    dispatch: async () => { sends += 1; sent = true },
  })
  await ready.runtime.submit(job())
  assert.equal((await ready.runtime.wait('job')).state.outcome.status, 'completed')
  assert.equal(sends, 1)
  const stuck = await bench(t, { inspect: async () => ({ status: 'uncertain', reason: 'unmatched_activity' }), dispatch: async () => assert.fail('must not dispatch unknown activity') }, { observeMs: 1 })
  await stuck.runtime.submit(job())
  assert.equal((await stuck.runtime.wait('job')).state.outcome.error.code, 'NEEDS_RECONCILIATION')
})

test('an execution-scope failure retains completed stages without leaking unexpected diagnostics', async t => {
  let sent = false
  const b = await bench(t, {
    inspect: async input => ({ status: input.sessionId === 'first' && sent ? 'completed' : 'absent', result: 'Saved first result' }),
    dispatch: async input => {
      if (input.sessionId === 'first') { sent = true; return }
      throw Object.assign(new Error('The original permission preset changed; review the task'), { code: 'DURABLE_SCOPE_CHANGED' })
    },
  })
  await b.runtime.submit({ key: 'scope-error', steps: ['first', 'second'].map(sessionId => ({ sessionId, prompt: 'Check fixture' })) })
  const record = await b.runtime.wait('scope-error')
  assert.equal(record.state.outcome.error.code, 'NEEDS_RECONCILIATION')
  assert.equal(record.state.outcome.error.completed, 1)
  assert.deepEqual(record.state.outcome.error.results, ['Saved first result'])
  assert.match(record.state.outcome.error.message, /permission preset changed/)
  const unknown = await bench(t, { inspect: async () => { throw new Error('Private adapter diagnostics') }, dispatch: async () => assert.fail('Unexpected dispatch') })
  await unknown.runtime.submit(job())
  const failed = await unknown.runtime.wait('job')
  assert.equal(failed.state.outcome.error.code, 'NEEDS_RECONCILIATION')
  assert.doesNotMatch(failed.state.outcome.error.message, /Private adapter diagnostics/)
})

async function untilTask(runtime, key, predicate) {
  const end = Date.now() + 5000
  while (Date.now() < end) {
    const task = await runtime.get(key)
    if (predicate(task)) return task
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('Expected durable task state')
}
test('pause saves the admitted step, parks durably without polling DSH, and resumes only remaining steps', async t => {
  let firstDone = false
  let inspections = 0
  const sent = new Set()
  const b = await bench(t, {
    inspect: async i => { inspections += 1; return { status: sent.has(i.requestId) ? i.sessionId === 'first' && !firstDone ? 'running' : 'completed' : 'absent', result: `Saved ${i.sessionId}` } },
    dispatch: async i => { sent.add(i.requestId) }, stop: async () => assert.fail('Pause must not cancel work'),
  })
  await b.runtime.submit({ key: 'pause', steps: ['first', 'second'].map(sessionId => ({ sessionId, prompt: 'Do work' })) })
  await untilTask(b.runtime, 'pause', () => sent.size === 1)
  await b.runtime.pause('pause')
  assert.notEqual((await b.runtime.get('pause')).state.status, 'waiting')
  firstDone = true
  const paused = await untilTask(b.runtime, 'pause', r => r.state.status === 'waiting')
  assert.deepEqual(paused.state.checkpoint.results, ['Saved first'])
  assert.equal(paused.state.checkpoint.step, 1)
  assert.equal(sent.size, 1)
  const reads = inspections
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(inspections, reads, 'A parked task must not poll or dispatch DSH')
  await b.reopen()
  assert.equal((await b.runtime.get('pause')).state.status, 'waiting')
  assert.equal((await b.runtime.blockingSessions()).has('second'), true)
  await b.runtime.resume('pause')
  await b.runtime.resume('pause')
  assert.deepEqual((await b.runtime.wait('pause')).state.outcome.result, ['Saved first', 'Saved second'])
  assert.equal(sent.size, 2)
})
test('a pause request during admission allows the in-flight step to settle without replay after reopen', async t => {
  let release
  let entered = false
  let sent = 0
  const b = await bench(t, { inspect: async i => ({ status: sent && i.sessionId === 'first' ? 'completed' : 'absent', result: 'saved' }),
    dispatch: async () => { entered = true; await new Promise(resolve => { release = resolve }); sent += 1 } })
  await b.runtime.submit({ key: 'pause', steps: ['first', 'second'].map(sessionId => ({ sessionId, prompt: 'Work' })) })
  await untilTask(b.runtime, 'pause', () => entered)
  await b.runtime.pause('pause')
  release()
  await untilTask(b.runtime, 'pause', r => r.state.status === 'waiting')
  await b.reopen()
  assert.equal((await b.runtime.get('pause')).state.checkpoint.step, 1)
  assert.equal(sent, 1)
})
test('pending pause can be withdrawn and cancelled paused work never resumes', async t => {
  let done = false
  const b = await bench(t, { inspect: async i => ({ status: i.sessionId === 'first' ? done ? 'completed' : 'running' : 'absent', result: 'saved' }), dispatch: async () => assert.fail('Not while paused'), stop: async () => ({ status: 'stopped' }) })
  await b.runtime.submit({ key: 'pause', steps: ['first', 'second'].map(sessionId => ({ sessionId, prompt: 'Work' })) })
  await b.runtime.pause('pause')
  await b.runtime.resume('pause')
  assert.equal((await b.runtime.get('pause')).pauseRequested, false)
  await b.runtime.pause('pause')
  done = true
  await untilTask(b.runtime, 'pause', r => r.state.status === 'waiting')
  await b.runtime.cancel('pause')
  assert.equal((await b.runtime.wait('pause')).state.outcome.status, 'aborted')
  await assert.rejects(b.runtime.resume('pause'), /unfinished/)
  await b.reopen()
  assert.equal((await b.runtime.get('pause')).state.outcome.status, 'aborted')
})
test('paused preparation survives restart and resumes the same saved definition', async t => {
  const b = await bench(t, { inspect: async () => ({ status: 'completed', result: 'done' }), dispatch: async () => assert.fail('Already done') })
  await b.runtime.prepareCreate({ key: 'draft', title: 'Draft', prompts: ['Work'], model: 'test/model' })
  await b.runtime.pause('draft')
  await b.reopen()
  assert.equal((await b.runtime.getCreate('draft')).pauseRequested, true)
  await b.runtime.resume('draft')
  assert.equal((await b.runtime.getCreate('draft')).pauseRequested, false)
  await b.runtime.submit(job('draft'))
  assert.equal((await b.runtime.wait('draft')).state.outcome.status, 'completed')
  await assert.rejects(b.runtime.pause('draft'), /unfinished/)
  await assert.rejects(b.runtime.pause('missing'), /Unknown/)
})

test('restart repairs a persisted continue whose gate release was interrupted', async t => {
  const b = await bench(t, { inspect: async () => ({ status: 'absent' }), dispatch: async () => assert.fail('Paused fixture must not execute') })
  await b.runtime.prepareCreate({ key: 'repair', title: 'Repair', prompts: ['Work'], model: 'test/model' })
  await b.runtime.pause('repair')
  await b.runtime.submit(job('repair'))
  await untilTask(b.runtime, 'repair', r => r.state.status === 'waiting')
  await b.runtime.close()
  const [{ Harness, createRegistry, defineDoc }, { createModels }, { openNodeSqliteStorage }, { BACKGROUND_CONTEXT: ctx }] = await Promise.all([
    import('@earendil-works/pi-durable'), import('@earendil-works/pi-ai/models'), import('@earendil-works/pi-durable/storage/sqlite/node'), import('@earendil-works/chord/context'),
  ])
  // Reproduce the committed half of continue with public document transactions:
  // its flag is cleared but the process dies before abortTask releases the gate.
  const h = await Harness.open(await openNodeSqliteStorage(b.database), { models: createModels(), registry: createRegistry() }, ctx)
  const root = await h.root(ctx)
  const Jobs = defineDoc({ kind: 'ds-bot.durable.jobs', version: 1, scope: 'session', history: 'latest', fork: 'initial', initial: () => ({ items: {} }), checkpointWhen: () => true })
  await root.commit(async tx => { (await tx.doc(Jobs)).items.repair.pauseRequested = false }, ctx)
  await h.close(ctx)
  await b.reopen()
  const released = await untilTask(b.runtime, 'repair', r => r.state.status !== 'waiting')
  assert.equal(released.pauseRequested, false)
})
