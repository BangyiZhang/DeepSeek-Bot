import assert from 'node:assert/strict'
import { test } from 'node:test'
import { desktopCaller, desktopReadiness, reportDesktopUpdate, install } from '../src/host/desktop-updates.js'
import { TEAM_TOOLS } from '../src/host/constants.js'

function runtime() {
  const bot = { id: 'dev' }
  return { load: async () => {}, readOnly: () => undefined, botOf: id => id === 'dev' ? bot : undefined,
    selfOf: id => id === 'private' ? 'dev' : undefined, chatOf: () => 'private', groupOwners: new Map(), live: new Map(),
    workView: () => ({}), roomProgress: new Map(), roomInbox: new Map(), durableEndpoint: async () => ({ jobs: [] }),
    async *eventsBackwards() {}, deliver: async () => {} }
}
test('installation tools stay unavailable to durable workers and DSH Agents', () => {
  assert.ok(TEAM_TOOLS.includes('request_desktop_update'))
  assert.ok(TEAM_TOOLS.includes('get_desktop_update'))
})
test('only the Bot private chat may install; background receipts need a fresh user request', async () => {
  const rt = runtime(), exec = { agent: { id: 'private' } }
  assert.deepEqual(await desktopCaller(rt, exec, true), { botId: 'dev', sessionId: 'private' })
  await assert.rejects(desktopCaller(rt, { agent: { id: 'worker' } }, true), /own chat/u)
  rt.groupOwners.set('private', 'group')
  await assert.rejects(desktopCaller(rt, exec, true), /own chat/u)
  rt.groupOwners.clear(); rt.live.set('private', { info: { role: 'desktop-update' } })
  await assert.rejects(desktopCaller(rt, exec, true), /direct user/u)
  rt.eventsBackwards = async function* () { yield { type: 'user/message', data: { source: { kind: 'user' } } }; yield { type: 'turn/start' } }
  await desktopCaller(rt, exec, true)
  rt.eventsBackwards = async function* () { yield { type: 'turn/start' }; yield { type: 'user/message', data: { source: { kind: 'user' } } } }
  await assert.rejects(desktopCaller(rt, exec, true), /direct user/u)
})
test('saved paused tasks allow update, admitted or uncertain tasks and queued rooms block it', async () => {
  const rt = runtime()
  rt.live.set('idle-chat', { texts: [], shown: 0, turn: undefined })
  assert.equal((await desktopReadiness(rt)).idle, true)
  rt.workView = () => ({ dev: { switching: true } })
  assert.equal((await desktopReadiness(rt)).idle, false)
  rt.workView = () => ({})
  rt.durableEndpoint = async () => ({ jobs: [{ state: { status: 'waiting', checkpoint: { paused: true } }, paused: true }] })
  assert.equal((await desktopReadiness(rt)).idle, true)
  rt.durableEndpoint = async () => ({ jobs: [{ state: { status: 'waiting' }, pauseRequested: true }] })
  assert.equal((await desktopReadiness(rt)).idle, false)
  rt.durableEndpoint = async () => ({ jobs: [], error: 'cannot inspect' })
  assert.equal((await desktopReadiness(rt)).idle, false)
  rt.durableEndpoint = async () => ({ jobs: [] }); rt.roomInbox.set('group', ['queued'])
  assert.equal((await desktopReadiness(rt)).idle, false)
})
test('a claimed receipt goes only to the original Bot private chat, never resends after uncertain admission', async () => {
  const rt = runtime(), calls = [], record = { id: 'job', origin: { botId: 'dev', sessionId: 'private' }, phase: 'completed', hash: 'expected', message: 'Host and UI ready' }
  let claimed = false
  const request = async op => { calls.push(op); if (op === 'claimReport' && !claimed) { claimed = true; return record } return null }
  rt.deliver = async body => { assert.equal(body.toId, 'dev'); assert.equal(body.role, 'desktop-update'); throw new Error('interrupted') }
  await assert.rejects(reportDesktopUpdate(rt, request), /interrupted/u)
  await reportDesktopUpdate(rt, request)
  assert.deepEqual(calls, ['claimReport', 'claimReport'])
  claimed = false; calls.length = 0
  rt.botOf = () => undefined
  await reportDesktopUpdate(rt, request)
  assert.deepEqual(calls, ['claimReport'])
})

test('packaged-only tool registration uses the shell bridge and stable request identity', async () => {
  const rt = runtime(), registered = new Map(), services = {}, effects = [], requests = []
  rt.ctx = { provide: (name, value) => { services[name] = value }, get: name => services[name],
    tools: { register: tool => registered.set(tool.name, tool) }, effect: effect => effects.push(effect) }
  install(rt, {})
  assert.equal(registered.size, 0)
  install(rt, { DS_BOT_APP: '1', DS_BOT_LOCAL_UPDATES: '1' })
  assert.deepEqual([...registered.keys()], ['request_desktop_update', 'get_desktop_update'])
  services.dsBotDesktopUpdateBridge = { request: async (op, body) => { requests.push({ op, body }); return { phase: 'queued' } } }
  const exec = { agent: { id: 'private' }, callId: 'same-call' }, tool = registered.get('request_desktop_update')
  await tool.execute({ appPath: '/candidate.app', evidencePath: '/report.json' }, exec)
  await tool.execute({ appPath: '/candidate.app', evidencePath: '/report.json' }, exec)
  assert.equal(requests[0].body.requestKey, requests[1].body.requestKey)
  assert.equal(requests[0].op, 'queue')
  assert.equal((await services.dsBotDesktopUpdates.readiness()).idle, true)
  await assert.rejects(tool.execute({ appPath: '/candidate.app', evidencePath: '/report.json' }, { agent: { id: 'worker' }, callId: 'worker-call' }), /own chat/u)
})
