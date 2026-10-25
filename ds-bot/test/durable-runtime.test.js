import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDurableRuntime} from '../src/host/durable/runtime.js'
async function bench(t,executor,options={}){const home=await mkdtemp(join(tmpdir(),'dsb-durable-'));const config={database:join(home,'tasks.sqlite'),executor,pollMs:5,...options};let runtime=await openDurableRuntime(config);t.after(async()=>{await runtime.close();await rm(home,{recursive:true,force:true})});return{get runtime(){return runtime},async reopen(){await runtime.close();runtime=await openDurableRuntime(config)}}}
const job=(key='job',sessionId='session')=>({key,steps:[{sessionId,prompt:'read the test fixture'}]})
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
