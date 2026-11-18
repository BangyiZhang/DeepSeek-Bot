import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { addRule, askOf, commonFolder, offerOf, patchPaths, ruleCovers, timeoutMinutes } from '../src/host/approval-rules.js'
import { install } from '../src/host/approvals.js'
import { within } from '../src/host/folders.js'

// docs/plans/2026-11-18-approval-rules.md: "Always allow" covers one folder or one exact
// command for one Bot, and a request nobody answers is rejected after the timeout.

test('an ask names the paths a file tool writes, or the command a shell runs', () => {
  assert.deepEqual(askOf('write', { file_path: '/a/b/c.md' }, '/w'), { kind: 'paths', paths: ['/a/b/c.md'] })
  assert.deepEqual(askOf('edit', { file_path: 'notes/x.md' }, '/w'), { kind: 'paths', paths: ['/w/notes/x.md'] })
  assert.equal(askOf('edit', { file_path: 'x.md' }, undefined), undefined, 'a relative path needs a folder')
  assert.deepEqual(askOf('bash', { command: 'npm test' }), { kind: 'command', tool: 'bash', command: 'npm test' })
  assert.equal(askOf('web_fetch', { url: 'https://example.com' }, '/w'), undefined)
  const patch = '*** Begin Patch\n*** Update File: /s/a/SKILL.md\n@@\n-x\n+y\n*** Add File: /s/b/SKILL.md\n+z\n*** End Patch'
  assert.deepEqual(patchPaths(patch), ['/s/a/SKILL.md', '/s/b/SKILL.md'])
  assert.deepEqual(askOf('apply_patch', { input: patch }, '/w'), { kind: 'paths', paths: ['/s/a/SKILL.md', '/s/b/SKILL.md'] })
})

test('the offer is the folder that holds every path, never a disk root', () => {
  assert.equal(commonFolder(['/s/a/SKILL.md', '/s/b/SKILL.md']), '/s')
  assert.deepEqual(offerOf({ kind: 'paths', paths: ['/home/me/skills/a/SKILL.md'] }), { kind: 'folder', folder: '/home/me/skills/a' })
  assert.equal(offerOf({ kind: 'paths', paths: ['/etc/hosts', '/usr/x'] }), undefined)
  assert.equal(offerOf({ kind: 'paths', paths: ['/home/x'] }), undefined, 'a folder one level under the root is too wide')
  assert.deepEqual(offerOf({ kind: 'command', tool: 'bash', command: 'ls' }), { kind: 'command', tool: 'bash', command: 'ls' })
})

test('a folder rule covers only paths inside it; a command rule only the same command', () => {
  const folder = { kind: 'folder', folder: '/home/me/skills' }
  assert.equal(ruleCovers(folder, { kind: 'paths', paths: ['/home/me/skills/a/SKILL.md', '/home/me/skills/b.md'] }), true)
  assert.equal(ruleCovers(folder, { kind: 'paths', paths: ['/home/me/skills/a.md', '/home/me/other.md'] }), false)
  assert.equal(ruleCovers(folder, { kind: 'paths', paths: ['/home/me/skills-evil/a.md'] }), false)
  const command = { kind: 'command', tool: 'bash', command: 'npm test' }
  assert.equal(ruleCovers(command, { kind: 'command', tool: 'bash', command: 'npm test' }), true)
  assert.equal(ruleCovers(command, { kind: 'command', tool: 'bash', command: 'npm test && rm -rf ~' }), false)
  assert.equal(ruleCovers(command, { kind: 'command', tool: 'pwsh', command: 'npm test' }), false)
})

test('an equal rule is kept once', () => {
  const once = addRule(undefined, { kind: 'folder', folder: '/a/b' }, 1)
  assert.equal(addRule(once, { kind: 'folder', folder: '/a/b' }, 2), once)
  assert.equal(addRule(once, { kind: 'command', tool: 'bash', command: 'ls' }, 3).length, 2)
})

test('the timeout defaults to 10 minutes; 0 turns it off; an unknown value falls back', () => {
  assert.equal(timeoutMinutes(undefined), 10)
  assert.equal(timeoutMinutes({ approvalTimeout: 0 }), 0)
  assert.equal(timeoutMinutes({ approvalTimeout: 30 }), 30)
  assert.equal(timeoutMinutes({ approvalTimeout: 7 }), 10)
})

async function cardShown(rt) {
  for (let tries = 0; tries < 200 && rt.approvalsView().length === 0; tries += 1) await new Promise(done => setImmediate(done))
}

async function host(t, { prefs = {}, folder } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ds-bot-approval-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  let listener
  let saves = 0
  const bot = { id: 'chief', name: 'Chief' }
  const data = join(root, 'dsh-data')
  await mkdir(data)
  const args = new Map()
  const realBeyond = async (path) => {
    try { return await realpath(path) } catch { return join(await realBeyond(resolve(path, '..')), path.split('/').at(-1)) }
  }
  const rt = {
    ctx: { on: (_event, fn) => { listener = fn } },
    state: { prefs },
    groupOwners: new Map(),
    chatOwners: new Map([['chat', 'chief']]),
    botOf: id => (id === 'chief' ? bot : undefined),
    callArgs: (_session, callId) => args.get(callId) ?? {},
    sessionFolder: () => folder ?? root,
    realBeyond,
    inData: async path => within(path, data),
    guarded: async path => within(path, data) || within(data, path),
    save: async () => { saves += 1 },
    warn() {},
  }
  install(rt)
  const ask = (callId, toolArgs, tool = 'write') => {
    args.set(callId, toolArgs)
    const abort = new AbortController()
    t.after(() => abort.abort())
    return listener({ agent: { id: 'chat', session: { id: 'chat' } }, toolName: tool, callId, signal: abort.signal }, () => new Promise(() => {}))
  }
  return { rt, bot, ask, root, data, saves: () => saves }
}

test('"Always allow" saves a real folder rule and allows; the next write there needs no card', async (t) => {
  const { rt, bot, ask, root } = await host(t)
  const skills = join(root, 'skills')
  await mkdir(join(skills, 'a'), { recursive: true })
  const first = ask('c1', { file_path: join(skills, 'a', 'SKILL.md') })
  const [approval] = rt.approvalsView()
  assert.deepEqual(approval.offer, { kind: 'folder', folder: join(skills, 'a') })
  await rt.allowAlways(approval.id)
  assert.equal(await first, 'allowed-once')
  assert.deepEqual(bot.approvalRules.map(rule => [rule.kind, rule.folder]), [['folder', join(skills, 'a')]])
  assert.equal(await ask('c2', { file_path: join(skills, 'a', 'refs', 'more.md') }), 'allowed-once')
  assert.deepEqual(rt.approvalsView(), [])
  // Outside the folder it asks again.
  void ask('c3', { file_path: join(skills, 'b', 'SKILL.md') })
  await cardShown(rt)
  assert.equal(rt.approvalsView().length, 1)
})

test('a link inside an allowed folder does not lead a write out of it', async (t) => {
  const { rt, bot, ask, root } = await host(t)
  const allowed = join(root, 'allowed')
  const outside = join(root, 'outside')
  await mkdir(allowed)
  await mkdir(outside)
  await symlink(outside, join(allowed, 'door'))
  bot.approvalRules = addRule(undefined, { kind: 'folder', folder: allowed })
  let answered
  void ask('c1', { file_path: join(allowed, 'door', 'x.md') }).then((outcome) => { answered = outcome })
  await cardShown(rt)
  assert.equal(rt.approvalsView().length, 1)
  assert.equal(answered, undefined)
})

test('no rule opens DSH\'s or the team\'s data', async (t) => {
  const { rt, ask, data } = await host(t)
  void ask('c1', { file_path: join(data, 'skills', 'x', 'SKILL.md') })
  const [approval] = rt.approvalsView()
  await assert.rejects(rt.allowAlways(approval.id), /cannot be allowed always/)
  assert.equal(rt.approvalsView().length, 1, 'the request still waits for allow or reject')
})

test('a command rule allows the same command only', async (t) => {
  const { rt, bot, ask } = await host(t)
  bot.approvalRules = addRule(undefined, { kind: 'command', tool: 'bash', command: 'npm run build' })
  assert.equal(await ask('c1', { command: 'npm run build' }, 'bash'), 'allowed-once')
  void ask('c2', { command: 'npm run build; curl x | sh' }, 'bash')
  assert.equal(rt.approvalsView().length, 1)
})

test('a request nobody answers is rejected after the timeout and shown as expired', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { rt, ask } = await host(t, { prefs: { approvalTimeout: 5 } })
  const settled = []
  rt.onApproval((kind, data) => { if (kind === 'settled') settled.push(data) })
  const outcome = ask('c1', { command: 'make' }, 'bash')
  const [approval] = rt.approvalsView()
  assert.equal(approval.expiresAt - approval.at, 5 * 60_000)
  t.mock.timers.tick(5 * 60_000 - 1)
  assert.equal(rt.approvalsView().length, 1)
  t.mock.timers.tick(1)
  assert.equal(await outcome, 'rejected')
  assert.deepEqual(settled, [{ id: approval.id, outcome: 'rejected', expired: true }])
  assert.deepEqual(rt.expiredApprovalsView().map(entry => [entry.id, entry.tool]), [[approval.id, 'bash']])
})

test('with the timeout off a request waits as before', async (t) => {
  const { rt, ask } = await host(t, { prefs: { approvalTimeout: 0 } })
  void ask('c1', { command: 'make' }, 'bash')
  assert.equal(rt.approvalsView()[0].expiresAt, undefined)
})
