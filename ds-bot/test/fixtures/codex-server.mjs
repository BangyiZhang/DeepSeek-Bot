import { createInterface } from 'node:readline'

const mode = process.argv[2]
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
const notice = (method, params) => send({ method, params })
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line)
  if (method === 'initialize') { send({ id, result: {} }); continue }
  if (method === 'initialized') continue
  if (mode === 'bad-json') { process.stdout.write('invalid\n'); continue }
  if (method === 'config/read') {
    send({ id, result: { config: { model: 'configured-model', model_reasoning_effort: 'high', mcp_servers: { sample: { enabled: true } } } } })
    continue
  }
  if (method === 'thread/start') {
    if (params.model !== undefined || params.modelProvider !== undefined || params.config.model !== undefined || params.config['mcp_servers.sample.enabled'] !== false) {
      send({ id, error: { message: 'Defaults or MCP fencing were lost' } })
    } else send({ id, result: { thread: { id: 'test-thread' } } })
    continue
  }
  if (method !== 'turn/start') continue
  if (mode === 'error') { send({ id, error: { message: 'private-provider-value-must-not-leak' } }); continue }
  send({ id, result: { turn: { id: 'test-turn' } } })
  const request = JSON.parse(params.input[0].text)
  const result = request.messages.findLast(message => message.role === 'tool')
  if (mode === 'tool' && !result) {
    send({ id: 'tool-request', method: 'item/tool/call', params: { callId: 'call-1', tool: 'ds_bot_tool_0', arguments: { path: 'test.txt' } } })
    continue
  }
  if (mode === 'native') {
    send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: {} })
    continue
  }
  const text = result ? `Tool returned: ${result.content[0].text}` : request.messages.at(-1).content[0].text
  if (mode === 'reasoning') {
    notice('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: 'Checking the ' })
    notice('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: 'available context.' })
  }
  notice('item/agentMessage/delta', { itemId: 'a', delta: text.slice(0, 2) })
  if (mode === 'hang') continue
  notice('item/agentMessage/delta', { itemId: 'a', delta: text.slice(2) })
  notice('item/completed', { item: { id: 'a', type: 'agentMessage', text } })
  notice('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 100, outputTokens: 12, cachedInputTokens: 40, cacheWriteInputTokens: 10 } } })
  notice('turn/completed', { turn: { status: mode === 'failed' ? 'failed' : 'completed' } })
}
