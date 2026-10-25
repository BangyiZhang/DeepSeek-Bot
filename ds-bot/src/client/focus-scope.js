import { useLayoutEffect, useRef } from 'react'

const scopes = []
const controls = 'button,input,textarea,select,a[href],[tabindex],[contenteditable="true"]'
const available = node => node.tabIndex >= 0 && !node.matches(':disabled,[aria-disabled="true"]') && !node.closest('[hidden],[inert],[data-leaving="true"]') && node.getClientRects().length > 0

// Portaled menus participate in the same stack as dialogs, so the parent dialog
// does not take focus back while a model or folder menu is open.
export function attachFocusScope(node, { modal = false, menu = false, close, previous = document.activeElement } = {}) {
  const scope = { node }
  scopes.push(scope)
  const items = () => [...node.querySelectorAll(controls)].filter(available)
  const focus = item => item?.focus({ preventScroll: true })
  const first = () => {
    const list = items()
    return list.find(item => item.matches('[autofocus],button[aria-checked="true"],button[aria-current="page"]')) ?? list[0] ?? node
  }
  if (!node.contains(document.activeElement)) {
    const initial = first()
    focus(initial)
    if (menu) initial.scrollIntoView?.({ block: 'nearest' })
  }
  let typed = ''
  let lastType = 0
  const onKey = event => {
    if (scopes.at(-1) !== scope || event.defaultPrevented || event.isComposing) return
    const list = items()
    const current = document.activeElement
    if (event.key === 'Tab') {
      if (menu) { event.preventDefault(); close?.(); return }
      if (!modal) return
      const at = list.indexOf(current)
      if (list.length === 0 || !node.contains(current) || (event.shiftKey ? at <= 0 : at === list.length - 1)) {
        event.preventDefault()
        focus(event.shiftKey ? list.at(-1) ?? node : list[0] ?? node)
      }
      return
    }
    if (!menu || current?.matches('input,textarea,select,[contenteditable="true"]') || event.metaKey || event.ctrlKey || event.altKey) return
    const at = list.indexOf(current)
    let next
    if (event.key === 'ArrowDown') next = list[(at + 1) % list.length]
    else if (event.key === 'ArrowUp') next = list[(at - 1 + list.length) % list.length]
    else if (event.key === 'Home') next = list[0]
    else if (event.key === 'End') next = list.at(-1)
    else if (event.key.length === 1 && event.key !== ' ') {
      const now = performance.now()
      typed = now - lastType > 600 ? event.key : typed + event.key
      lastType = now
      const query = [...typed].every(char => char === typed[0]) ? typed[0] : typed
      next = [...list.slice(at + 1), ...list.slice(0, at + 1)].find(item => item.textContent.trim().toLocaleLowerCase().startsWith(query.toLocaleLowerCase()))
    } else return
    event.preventDefault()
    if (next) { focus(next); next.scrollIntoView?.({ block: 'nearest' }) }
  }
  document.addEventListener('keydown', onKey)
  const onPointer = event => {
    if (!menu || event.pointerType === 'touch' || scopes.at(-1) !== scope) return
    const item = event.target.closest?.('button')
    if (item && node.contains(item) && available(item)) focus(item)
  }
  node.addEventListener('pointermove', onPointer)
  return () => {
    scopes.splice(scopes.indexOf(scope), 1)
    document.removeEventListener('keydown', onKey)
    node.removeEventListener('pointermove', onPointer)
    // An action can open another dialog or focus the composer before this layer
    // exits. Restore only if focus still belongs to the closing layer.
    const restore = () => {
      if (!node.contains(document.activeElement) && document.activeElement !== document.body) return
      const parent = scopes.at(-1)?.node
      const fallback = parent ? [...parent.querySelectorAll(controls)].find(available) : document.querySelector('[contenteditable="true"][role="textbox"]')
      focus(previous?.isConnected && previous !== document.body ? previous : fallback)
    }
    restore()
    // React can remove the focused subtree later in the same commit. Retry after
    // that commit, only if nobody has taken focus in the meantime.
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore)
  }
}

export function useFocusScope(ref, active = true, options = {}) {
  const state = useRef({ active: false, previous: null })
  if (active && !state.current.active) state.current.previous = document.activeElement
  state.current.active = active
  const latest = useRef(options)
  latest.current = options
  useLayoutEffect(() => {
    if (!active || !ref.current) return undefined
    return attachFocusScope(ref.current, { ...latest.current, close: () => latest.current.close?.(), previous: state.current.previous })
  }, [active])
}
