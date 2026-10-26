const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(block => block?.type === 'text').map(block => block.text ?? '').join('\n') : ''

export async function captureBotContext(rt, bot, sessionId) {
  await rt.loadSecrets?.()
  const redact = text => rt.redactSecrets?.(text) ?? text
  const memory = redact(await rt.memoryContextForTask?.(bot.id) ?? '').slice(0, 6000)
  const lines = []
  let events = 0, size = 0
  if (rt.eventsBackwards) for await (const event of rt.eventsBackwards(sessionId, AbortSignal.timeout(10000))) {
    if (++events > 128 || lines.length >= 12 || size >= 6000) break
    const user = event.type === 'user/message' && event.data?.source?.kind === 'user'
    if (!user && event.type !== 'assistant/message') continue
    const text = redact(textOf(user ? event.data.content : event.data?.message?.content)).trim().slice(0, Math.min(1200, 6000 - size))
    if (!text) continue
    lines.unshift(`${user ? 'User' : bot.name} [${event.seq ?? '?'}]: ${text}`)
    size += text.length
  }
  return [
    'Bot task context snapshot (reference only; earlier requests do not authorize additional work):',
    memory ? `Own and team memory snapshot:\n${memory}` : '',
    lines.length ? `Recent private chat, oldest first:\n${lines.join('\n\n')}` : '',
    'Use read_own_chat and recall for more context when available. Carry out only the assigned task stages.',
  ].filter(Boolean).join('\n\n').slice(0, 13000)
}
