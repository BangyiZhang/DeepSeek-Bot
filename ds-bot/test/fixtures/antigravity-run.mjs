import assert from 'node:assert/strict'
import { createInterface } from 'node:readline'

const mode = process.argv[2]
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`)
for await (const line of createInterface({ input: process.stdin })) {
  const event = JSON.parse(line)
  assert.equal(event.event, 'user')
  const request = JSON.parse(event.message.content)
  const toolResult = request.messages.findLast(message => message.role === 'tool')
  const text = toolResult ? `Tool returned: ${toolResult.content[0].text}` : request.messages.at(-1).content[0].text
  send({ event: 'init', init: {} })
  send({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: 'private-partial-schema-must-not-leak' } })
  if (mode === 'hang') { setInterval(() => {}, 1000); continue }
  if (mode === 'bad-json') { process.stdout.write('private-invalid-response\n'); continue }
  if (mode === 'no-result') continue
  if (mode === 'native') {
    send({ event: 'step_update', step_update: { step_type: 'tool', tool_info: { name: 'run_command', output: 'private-native-result' } } })
    continue
  }
  if (mode?.startsWith('finish-')) {
    send({ event: 'step_update', step_update: {
      step_type: 'tool', state: 'ACTIVE',
      ...(mode !== 'finish-info-only' ? { tool_name: 'finish' } : {}),
      ...(mode !== 'finish-name-only' ? { tool_info: { name: mode === 'finish-conflict' ? 'run_command' : 'finish' } } : {}),
      ...(mode === 'finish-subagent' ? { subagent_info: { subagents: [] } } : {}),
    } })
    send({ event: 'step_update', step_update: { step_type: 'finish', state: 'DONE' } })
  }
  const reply = mode === 'tool' && !toolResult
    ? { text: '', tool_calls: [{ name: 'read_file', arguments: '{"path":"test.txt"}' }] }
    : { text, tool_calls: [] }
  if (mode === 'unknown-tool') reply.tool_calls = [{ name: 'read_file', arguments: '{}' }, { name: 'private-unlisted-tool', arguments: '{}' }]
  if (mode === 'bad-args') reply.tool_calls = [{ name: 'read_file', arguments: '[1]' }]
  if (mode === 'malformed-args') reply.tool_calls = [{ name: 'read_file', arguments: 'private-malformed-args' }]
  if (mode === 'empty') reply.text = ''
  const result = {
    status: mode === 'error' || mode === 'location' ? 'ERROR' : mode === 'waiting' ? 'WAITING' : 'SUCCESS',
    error: mode === 'location' ? 'User location is not supported for the API use. private-provider-value' : 'private-provider-value',
    response: JSON.stringify(reply),
    ...(mode !== 'fallback' ? { structured_output: reply } : {}),
    usage: { input_tokens: 50, output_tokens: 12, thinking_tokens: 8, cache_read_tokens: 40 },
  }
  send({ event: 'result', result })
  if (mode === 'duplicate') send({ event: 'result', result })
  if (mode === 'exit-error') process.exitCode = 3
}
