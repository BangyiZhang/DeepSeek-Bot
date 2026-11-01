const MESSAGE = '[data-bt-quote-session]'
const CONTROL = 'button,input,textarea,select,[contenteditable=true],[aria-hidden=true]'
const elementOf = node => node?.nodeType === 1 ? node : node?.parentElement

// Endpoints must belong to one message; transcript-wide selections are not replies.
export function selectedQuote(selection, sessionId) {
  if (!sessionId || !selection || selection.isCollapsed || selection.rangeCount !== 1) return null
  const range = selection.getRangeAt(0)
  const start = elementOf(range.startContainer)
  const end = elementOf(range.endContainer)
  const root = start?.closest(MESSAGE)
  if (!root?.isConnected || root.dataset.btQuoteSession !== sessionId || end?.closest(MESSAGE) !== root
    || start.closest(CONTROL) || end.closest(CONTROL)) return null
  const text = selection.toString()
  if (!text.trim()) return null
  return { sessionId, text, root, range: range.cloneRange() }
}

export function quoteText({ text, selection }) {
  if (selection) return `${text.replace(/\r\n?/g, '\n').split('\n').map(line => `> ${line}`).join('\n')}\n\n`
  const excerpt = text.replace(/\s+/g, ' ').trim()
  return `> ${excerpt.length > 200 ? `${excerpt.slice(0, 200)}…` : excerpt}\n\n`
}
