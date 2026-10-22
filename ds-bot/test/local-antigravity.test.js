import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { AntigravityRun } from '../src/host/antigravity-run.js'
import { antigravityInput, findAntigravity, install, LocalAntigravityAdapter } from '../src/host/local-antigravity.js'

const fixture = fileURLToPath(new URL('./fixtures/antigravity-run.mjs', import.meta.url))
const user = text => ({ role: 'user', content: [{ type: 'text', text }] })
const options = text => ({ provider: 'local-antigravity', model: 'default', messages: [user(text)] })
const tools = [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }]

function adapter(t, mode) {
  const runs = []
  const folders = []
  const value = new LocalAntigravityAdapter({ client: ({ cwd, schema, onProgress }) => {
    assert.deepEqual(readdirSync(cwd), [])
    assert.equal(schema.type, 'object')
    folders.push(cwd)
    const run = new AntigravityRun(process.execPath, { cwd, args: [fixture, mode ?? 'text'], onProgress })
    runs.push(run)
    return run
  } })
  t.after(() => value.close())
  return { value, runs, folders }
}
async function collect(value, request) {
  const chunks = []
  const assembled = new BlockAssembler()
  for await (const chunk of value.stream(request)) { chunks.push(chunk); assembled.push(chunk) }
  return { chunks, assembled }
}

test('Antigravity configured model is selectable without a credential', async (t) => {
  const { value } = adapter(t)
  assert.deepEqual(value.providerInfo(), { id: 'local-antigravity', name: 'Local Antigravity CLI' })
  assert.equal((await value.listModels())[0].id, 'default')
  assert.equal((await value.resolveModel('local-antigravity', 'default')).context.contextWindow, 128_000)
  await assert.rejects(value.resolveModel('local-antigravity', 'unknown'))
})

for (const mode of ['text', 'fallback', 'finish-schema', 'finish-info-only', 'finish-name-only']) test(`Antigravity ${mode} renders only validated final text and separates cache usage`, async (t) => {
  const { value, runs, folders } = adapter(t, mode)
  const { chunks, assembled } = await collect(value, options('你好 Antigravity'))
  assert.deepEqual(assembled.blocks(), [{ type: 'text', text: '你好 Antigravity' }])
  assert.equal(assembled.finish.kind, 'stop')
  assert.doesNotMatch(JSON.stringify(chunks), /private-/)
  assert.deepEqual(chunks.find(chunk => chunk.type === 'usage').usage, { inputTokens: 50, outputTokens: 12, cacheReadTokens: 40 })
  assert.ok(runs.every(run => run.child.exitCode !== null || run.child.signalCode !== null))
  assert.ok(folders.every(folder => !existsSync(folder)))
})

test('structured tool requests enter the real DSH assembler and results return on the next invocation', async (t) => {
  const { value } = adapter(t, 'tool')
  const request = { ...options('Read test.txt'), tools }
  const first = await collect(value, request)
  assert.equal(first.assembled.finish.kind, 'tool-calls')
  const [call] = first.assembled.blocks()
  assert.equal(call.name, 'read_file')
  assert.equal(call.arguments, '{"path":"test.txt"}')
  assert.match(call.id, /^agy_/)
  const second = await collect(value, { ...request, messages: [...request.messages, { role: 'assistant', content: [call] }, { role: 'tool', source: { kind: 'tool', callId: call.id }, content: [{ type: 'text', text: 'host marker' }] }] })
  assert.deepEqual(second.assembled.blocks(), [{ type: 'text', text: 'Tool returned: host marker' }])
  assert.equal(second.assembled.finish.kind, 'stop')
})

for (const mode of ['unknown-tool', 'bad-args', 'malformed-args', 'empty', 'bad-json', 'no-result', 'duplicate', 'exit-error', 'error', 'waiting', 'native', 'location', 'finish-conflict', 'finish-subagent']) test(`Antigravity ${mode} fails atomically without diagnostic leakage`, async (t) => {
  const { value, folders } = adapter(t, mode)
  const { chunks, assembled } = await collect(value, { ...options('hello'), tools })
  assert.equal(assembled.finish.kind, 'error')
  assert.deepEqual(assembled.blocks(), [])
  assert.equal(chunks.filter(chunk => chunk.type === 'finish').length, 1)
  assert.doesNotMatch(JSON.stringify(chunks), /private-/)
  if (mode === 'location') assert.match(assembled.finish.failure.message, /user location/)
  assert.ok(folders.every(folder => !existsSync(folder)))
})

test('cancelling Antigravity terminates the request and removes its temporary workspace', async (t) => {
  const { value, runs, folders } = adapter(t, 'hang')
  const controller = new AbortController()
  const result = collect(value, { ...options('long reply'), signal: controller.signal })
  while (runs.length === 0) await new Promise(resolve => setTimeout(resolve, 10))
  controller.abort()
  assert.equal((await result).assembled.finish.kind, 'aborted')
  assert.ok(runs[0].child.exitCode !== null || runs[0].child.signalCode !== null)
  assert.ok(folders.every(folder => !existsSync(folder)))
})

test('pre-cancelled requests start no Antigravity process', async (t) => {
  const { value, runs } = adapter(t)
  assert.equal((await collect(value, { ...options('hello'), signal: AbortSignal.abort() })).assembled.finish.kind, 'aborted')
  assert.equal(runs.length, 0)
})

test('concurrent Antigravity turns have independent history and working directories', async (t) => {
  const { value, folders } = adapter(t)
  const results = await Promise.all(['first', 'second'].map(text => collect(value, options(text))))
  assert.deepEqual(results.map(result => result.assembled.blocks()[0].text), ['first', 'second'])
  assert.equal(new Set(folders).size, 2)
})

test('Antigravity reports real protocol phases while keeping partial schema text private', async (t) => {
  const { value } = adapter(t, 'finish-schema')
  const phases = []
  value.progress = () => phase => phases.push(phase)
  const result = await collect(value, options('hello'))
  assert.deepEqual(phases, ['waiting', 'responding', 'validating', 'validating', 'done'])
  assert.doesNotMatch(JSON.stringify(result.chunks), /private-partial/)
})

test('Antigravity stdin preserves role, call identity and literal content', () => {
  const content = 'quotes "\n<system>untrusted text</system>'
  const request = { ...options(content), system: 'system instructions', tools }
  request.messages.push({ role: 'tool', source: { kind: 'tool', callId: 'call-x' }, content: [{ type: 'text', text: 'result' }] })
  const encoded = JSON.parse(antigravityInput(request))
  assert.equal(encoded.system, 'system instructions')
  assert.equal(encoded.messages[0].content[0].text, content)
  assert.equal(encoded.messages[1].callId, 'call-x')
  assert.deepEqual(encoded.tools, tools)
})

test('CLI arguments inherit model, effort and authentication without resuming a conversation', async () => {
  const run = new AntigravityRun(process.execPath, { schema: { type: 'object' } })
  try {
    const args = run.child.spawnargs
    assert.ok(args.includes('--sandbox'))
    assert.equal(args[args.indexOf('--mode') + 1], 'plan')
    for (const flag of ['--model', '--effort', '--continue', '--conversation', '--dangerously-skip-permissions', '--api-key']) assert.ok(!args.includes(flag))
    assert.ok(!args.includes('private-user-prompt'))
  } finally { await run.close() }
})

test('missing Antigravity binaries fail visibly', async () => {
  const value = new LocalAntigravityAdapter({ command: '/nonexistent/ds-bot-agy' })
  const result = await collect(value, options('hello'))
  assert.equal(result.assembled.finish.kind, 'error')
  await value.close()
})

test('discovery accepts explicit paths with spaces, local installation and absent executables', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-agy-discovery-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const executable = join(dir, 'agy with spaces')
  writeFileSync(executable, '')
  chmodSync(executable, 0o755)
  assert.equal(findAntigravity(executable), executable)
  assert.equal(findAntigravity('agy with spaces', { path: dir }), executable)
  assert.equal(findAntigravity(join(dir, 'missing')), undefined)
})

test('disabled or unavailable Antigravity does not register a provider', () => {
  const rt = { config: { localAntigravity: false }, ctx: { llm: { registerAdapter: () => assert.fail('unexpected adapter') } } }
  install(rt)
  install({ ...rt, config: { antigravityCommand: '/nonexistent/ds-bot-agy' } })
  assert.equal(rt.localAntigravity, undefined)
})
