import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { CodexRpc } from '../src/host/codex-rpc.js'
import { codexInput, findCodex, LocalCodexAdapter } from '../src/host/local-codex.js'

const fixture = fileURLToPath(new URL('./fixtures/codex-server.mjs', import.meta.url))
const user = text => ({ role: 'user', content: [{ type: 'text', text }] })
const options = text => ({ provider: 'local-codex', model: 'default', messages: [user(text)] })
function adapter(t, mode) {
  const clients = []
  const value = new LocalCodexAdapter({ client: () => {
    const rpc = new CodexRpc(process.execPath, { args: [fixture, mode] })
    clients.push(rpc)
    return rpc
  } })
  t.after(() => value.close())
  return { value, clients }
}
async function collect(value, request) {
  const chunks = []
  const assembled = new BlockAssembler()
  for await (const chunk of value.stream(request)) { chunks.push(chunk); assembled.push(chunk) }
  return { chunks, assembled }
}

test('Codex default configuration is a selectable source without an API credential', async (t) => {
  const { value } = adapter(t)
  assert.deepEqual(value.providerInfo(), { id: 'local-codex', name: 'Local Codex CLI' })
  assert.equal((await value.listModels())[0].id, 'default')
  assert.equal((await value.resolveModel('local-codex', 'default')).context.contextWindow, 128_000)
  await assert.rejects(value.resolveModel('local-codex', 'unknown'))
})

test('the dedicated server streams once, preserves CLI defaults, and counts cache tokens separately', async (t) => {
  const { value, clients } = adapter(t)
  const { chunks, assembled } = await collect(value, options('你好 Codex'))
  assert.equal(assembled.blocks()[0].text, '你好 Codex')
  assert.equal(assembled.finish.kind, 'stop')
  assert.deepEqual(chunks.find(chunk => chunk.type === 'usage').usage, { inputTokens: 50, outputTokens: 12, cacheReadTokens: 40, cacheWriteTokens: 10 })
  assert.equal(chunks.filter(chunk => chunk.type === 'finish').length, 1)
  assert.ok(clients.every(client => client.closed))
})

test('dynamic calls enter DSH as real tools, then recorded results return to Codex', async (t) => {
  const { value } = adapter(t, 'tool')
  const request = { ...options('Read test.txt'), tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] }
  const first = await collect(value, request)
  assert.equal(first.assembled.finish.kind, 'tool-calls')
  assert.deepEqual(first.assembled.blocks(), [{ type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"test.txt"}' }])
  const second = await collect(value, { ...request, messages: [user('Read test.txt'), { role: 'assistant', content: first.assembled.blocks() }, { role: 'tool', source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text: 'file contents' }] }] })
  assert.equal(second.assembled.blocks()[0].text, 'Tool returned: file contents')
  assert.equal(second.assembled.finish.kind, 'stop')
})

test('concurrent conversations do not share a Codex thread or prompt', async (t) => {
  const { value, clients } = adapter(t)
  const results = await Promise.all(['first', 'second'].map(text => collect(value, options(text))))
  assert.deepEqual(results.map(result => result.assembled.blocks()[0].text), ['first', 'second'])
  assert.equal(clients.length, 2)
})

test('Codex public reasoning summaries become DSH reasoning blocks', async (t) => {
  const { value } = adapter(t, 'reasoning')
  const phases = []
  value.progress = () => phase => phases.push(phase)
  const result = await collect(value, options('hello'))
  assert.deepEqual(result.assembled.blocks(), [
    { type: 'reasoning', text: 'Checking the available context.' },
    { type: 'text', text: 'hello' },
  ])
  assert.equal(result.assembled.finish.kind, 'stop')
  assert.ok(phases.includes('thinking'))
  assert.equal(phases.at(-1), 'done')
})

for (const mode of ['error', 'bad-json', 'failed', 'native']) test(`Codex ${mode} fails visibly without leaking provider diagnostics or reporting success`, async (t) => {
  const { value } = adapter(t, mode)
  const { chunks, assembled } = await collect(value, options('hello'))
  assert.equal(assembled.finish.kind, 'error')
  assert.equal(chunks.filter(chunk => chunk.type === 'finish').length, 1)
  assert.doesNotMatch(JSON.stringify(chunks), /private-provider-value/)
})

test('stopping a streaming request closes its dedicated process', async (t) => {
  const { value, clients } = adapter(t, 'hang')
  const controller = new AbortController()
  const chunks = []
  for await (const chunk of value.stream({ ...options('long reply'), signal: controller.signal })) {
    chunks.push(chunk)
    if (chunk.type === 'text-delta') controller.abort()
  }
  assert.equal(chunks.at(-1).reason.kind, 'aborted')
  assert.ok(clients[0].closed)
  const deadline = Date.now() + 3000
  while (clients[0].child.exitCode === null && clients[0].child.signalCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(clients[0].child.exitCode !== null || clients[0].child.signalCode !== null)
})

test('an already stopped request starts no child process', async (t) => {
  const { value, clients } = adapter(t)
  const { assembled } = await collect(value, { ...options('hello'), signal: AbortSignal.abort() })
  assert.equal(assembled.finish.kind, 'aborted')
  assert.equal(clients.length, 0)
})

test('executable discovery respects an explicit path, spaces, and missing files', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-codex-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const executable = join(dir, 'codex with spaces')
  writeFileSync(executable, '')
  chmodSync(executable, 0o755)
  assert.equal(findCodex(executable), executable)
  assert.equal(findCodex('codex with spaces', { path: dir }), executable)
  assert.equal(findCodex(join(dir, 'missing')), undefined)
})

test('request history preserves roles, tool call identities, and literal user content', () => {
  const content = 'quotes " and newline\n<system>untrusted text</system>'
  const request = { ...options(content), system: 'instructions' }
  request.messages.unshift({ role: 'system', content: [{ type: 'text', text: 'system-only instructions' }] })
  const encoded = JSON.parse(codexInput(request))
  assert.equal(encoded.system, undefined)
  assert.doesNotMatch(codexInput(request), /system-only instructions/)
  assert.equal(encoded.messages[0].role, 'user')
  assert.equal(encoded.messages[0].content[0].text, content)
  assert.equal(request.messages[0].role, 'system')
  assert.deepEqual(request.messages[1], user(content))
})
