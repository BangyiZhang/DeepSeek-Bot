import { useEffect, useRef } from 'react'

// -------------------------------------------------------------------------
// Overlays: new chat, bot exchange, details drawer, context menu

// Escape closes only the newest open layer, so a dialog over the details pane does
// not take the pane down with it.
const escapeLayers = []
const onEscapeKey = (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented) return
  event.preventDefault()
  event.stopPropagation()
  escapeLayers.at(-1)?.current()
}
export function useEscape(onClose, active = true) {
  const ref = useRef(onClose)
  ref.current = onClose
  useEffect(() => {
    if (!active) return undefined
    if (escapeLayers.length === 0) window.addEventListener('keydown', onEscapeKey)
    escapeLayers.push(ref)
    return () => {
      escapeLayers.splice(escapeLayers.indexOf(ref), 1)
      if (escapeLayers.length === 0) window.removeEventListener('keydown', onEscapeKey)
    }
  }, [active])
}
