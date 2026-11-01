import { createElement as h, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ReplyIcon } from './icons.js'
import { t } from './i18n.js'
import { useLinger, viewBottom } from './motion.js'
import { selectedQuote } from './quote.js'

const viewport = () => ({ left: window.visualViewport?.offsetLeft ?? 0, top: window.visualViewport?.offsetTop ?? 0,
  right: (window.visualViewport?.offsetLeft ?? 0) + (window.visualViewport?.width ?? window.innerWidth), bottom: viewBottom() })
const sameRange = (a, b) => a?.root === b?.root && a?.text === b?.text
  && a?.range.startContainer === b?.range.startContainer && a?.range.startOffset === b?.range.startOffset
  && a?.range.endContainer === b?.range.endContainer && a?.range.endOffset === b?.range.endOffset

export function quoteAnchor(quote, selection, bounds) {
  const scroll = quote.root.closest('[data-conversation-scroll]')?.getBoundingClientRect()
  const top = Math.max(bounds.top, scroll?.top ?? bounds.top)
  const bottom = Math.min(bounds.bottom, scroll?.bottom ?? bounds.bottom)
  const rects = [...quote.range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0 && rect.bottom > top && rect.top < bottom && rect.right > bounds.left && rect.left < bounds.right)
  if (!rects.length) return null
  const backward = selection.focusNode === quote.range.startContainer && selection.focusOffset === quote.range.startOffset
  const rect = backward ? rects[0] : rects.at(-1)
  return { left: Math.max(bounds.left, rect.left), right: Math.min(bounds.right, rect.right), top: Math.max(top, rect.top), bottom: Math.min(bottom, rect.bottom) }
}

export function quotePosition(rect, size, bounds) {
  const gap = 8
  const high = Math.max(bounds.left + gap, bounds.right - size.width - gap)
  const above = rect.top - size.height - gap
  return {
    left: Math.max(bounds.left + gap, Math.min((rect.left + rect.right - size.width) / 2, high)),
    top: Math.max(bounds.top + gap, Math.min(above >= bounds.top + gap ? above : rect.bottom + gap, bounds.bottom - size.height - gap)),
  }
}

// One observer for the visible chat, rather than a document listener per message.
export function SelectionReply({ sessionId, disabled, actions }) {
  const [quote, setQuote] = useState(null)
  const [shown, leaving] = useLinger(quote, 120)
  const pop = useRef(null)
  const [place, setPlace] = useState({ left: -10000, top: 0 })
  useEffect(() => {
    setQuote(null)
    if (!sessionId || disabled) return undefined
    let frame = 0
    let dragging = false
    let dismissed = null
    const refresh = () => {
      frame = 0
      if (dragging) return
      if (document.querySelector('[aria-modal=true]')) { setQuote(null); return }
      const selection = window.getSelection()
      const next = selectedQuote(selection, sessionId)
      if (!next && pop.current?.contains(document.activeElement)) return
      if (dismissed && !sameRange(next, dismissed)) dismissed = null
      const rect = next && !sameRange(next, dismissed) ? quoteAnchor(next, selection, viewport()) : null
      setQuote(rect ? { ...next, rect } : null)
    }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(refresh) }
    const down = event => {
      if (pop.current?.contains(event.target)) return
      dragging = true
      dismissed = null
      setQuote(null)
    }
    const up = () => { dragging = false; schedule() }
    const blur = () => { cancelAnimationFrame(frame); dragging = false; setQuote(null) }
    const key = event => {
      if (event.key !== 'Escape') { schedule(); return }
      dismissed = selectedQuote(window.getSelection(), sessionId)
      setQuote(null)
    }
    document.addEventListener('selectionchange', schedule)
    document.addEventListener('pointerdown', down)
    document.addEventListener('pointerup', up)
    document.addEventListener('pointercancel', up)
    document.addEventListener('keyup', key)
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    window.addEventListener('blur', blur)
    window.visualViewport?.addEventListener('scroll', schedule)
    window.visualViewport?.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', schedule)
      document.removeEventListener('pointerdown', down)
      document.removeEventListener('pointerup', up)
      document.removeEventListener('pointercancel', up)
      document.removeEventListener('keyup', key)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('blur', blur)
      window.visualViewport?.removeEventListener('scroll', schedule)
      window.visualViewport?.removeEventListener('resize', schedule)
    }
  }, [sessionId, disabled])
  useLayoutEffect(() => {
    if (!shown || !pop.current) return
    // The entrance spring transforms the menu; its layout size keeps the anchor steady.
    const next = quotePosition(shown.rect, { width: pop.current.offsetWidth, height: pop.current.offsetHeight }, viewport())
    setPlace(previous => previous.left === next.left && previous.top === next.top ? previous : next)
  }, [shown])
  if (!shown || disabled || shown.sessionId !== sessionId) return null
  const reply = () => {
    if (leaving || !shown.root.isConnected) return
    setQuote(null)
    window.getSelection()?.removeAllRanges()
    actions.quote(shown.sessionId, shown.text, { selection: true })
  }
  return createPortal(h('div', { ref: pop, className: 'bt-menu bt-selection-reply', role: 'toolbar', 'aria-label': t('Selected text actions'), 'data-leaving': leaving || undefined, style: place },
    h('button', { type: 'button', disabled: leaving, onPointerDown: event => event.preventDefault(), onMouseDown: event => event.preventDefault(), onClick: reply }, h(ReplyIcon), t('Quote selection'))), document.body)
}
