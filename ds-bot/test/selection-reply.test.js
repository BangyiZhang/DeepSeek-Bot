import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { selectedQuote, quoteText } from '../src/client/quote.js'
import { createSource } from '../src/client/sources.js'
import { teamActions } from '../src/client/team-actions.js'

const requireHarness = createRequire(join(process.env.DSH_HARNESS, 'package.json'))
const { JSDOM } = requireHarness('jsdom')
const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true })
const { window } = dom
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
const React = requireHarness('react')
const { createRoot } = requireHarness('react-dom/client')
window.Range.prototype.getClientRects = () => [{ left: 40, right: 220, top: 80, bottom: 100, width: 180, height: 20 }]
after(() => dom.window.close())
const { outputFiles } = await build({
  stdin: { contents: "export { SelectionReply, quoteAnchor, quotePosition } from './src/client/selection-reply.js'; export { ComposerVoice } from './src/client/composer.js'; export { Bubbles } from './src/client/cells.js'; export { UserMessageCell } from './src/client/user-message.js'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, window, document: window.document,
  HTMLElement: window.HTMLElement, Element: window.Element, navigator: window.navigator,
  requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window), setTimeout, clearTimeout,
  require: name => name === 'react' ? React : name === 'react-dom' ? requireHarness('react-dom') : { MarkdownText: ({ text }) => React.createElement('p', null, text), projectUserText: text => text },
})
const { SelectionReply, quoteAnchor, quotePosition, ComposerVoice, Bubbles, UserMessageCell } = module.exports
const settle = () => React.act(() => new Promise(resolve => window.requestAnimationFrame(resolve)))
function select(start, startOffset, end = start, endOffset = start.textContent.length) {
  const range = document.createRange()
  range.setStart(start, startOffset); range.setEnd(end, endOffset)
  const selection = window.getSelection()
  selection.removeAllRanges(); selection.addRange(range)
  document.dispatchEvent(new window.Event('selectionchange'))
  return selection
}

function messages() {
  document.body.innerHTML = '<div data-bt-quote-session="chief"><p>First <b>selected</b> sentence.</p><button>Show all</button></div><div data-bt-quote-session="chief">Another message</div><div data-bt-quote-session="peer">Other chat</div><div contenteditable="true">Draft</div>'
  return [...document.body.children]
}

test('only one message in the current chat supplies a quote, including nested formatted text', () => {
  const [message, other, peer, draft] = messages()
  const first = message.querySelector('p').firstChild, bold = message.querySelector('b').firstChild
  const picked = selectedQuote(select(first, 2, bold, 5), 'chief')
  assert.equal(picked.text, 'rst selec')
  assert.equal(picked.root, message)
  assert.equal(selectedQuote(window.getSelection(), 'peer'), null)
  assert.equal(selectedQuote(select(first, 0, other.firstChild, 5), 'chief'), null)
  assert.equal(selectedQuote(select(peer.firstChild, 0), 'chief'), null)
  assert.equal(selectedQuote(select(draft.firstChild, 0), 'chief'), null)
  assert.equal(selectedQuote(select(message.querySelector('button').firstChild, 0), 'chief'), null)
  select(bold, 0); message.remove()
  assert.equal(selectedQuote(window.getSelection(), 'chief'), null)
})

test('whitespace-only selections have no action and selected quote text is never summarized', () => {
  const [message] = messages()
  message.textContent = '   '
  assert.equal(selectedQuote(select(message.firstChild, 0), 'chief'), null)
  const text = `  indentation\r\n${'Selected sentence. '.repeat(30)}\n\nFinal line.`
  assert.equal(quoteText({ text, selection: true }), text.replace(/\r\n/g, '\n').split('\n').map(line => `> ${line}`).join('\n') + '\n\n')
  assert.equal(quoteText({ text: 'whole\nmessage' }), '> whole message\n\n')
  assert.equal(quoteText({ text: 'x'.repeat(250) }), `> ${'x'.repeat(200)}…\n\n`)
})

test('the anchor follows selection direction and visible lines; the menu stays in the visual viewport', () => {
  const [message] = messages()
  const selection = select(message.querySelector('p').firstChild, 0)
  const quote = selectedQuote(selection, 'chief')
  quote.range.getClientRects = () => [{ left: 0, right: 100, top: -20, bottom: 0, width: 100, height: 20 }, { left: 10, right: 120, top: 30, bottom: 50, width: 110, height: 20 }, { left: 10, right: 200, top: 60, bottom: 80, width: 190, height: 20 }]
  const bounds = { left: 0, top: 20, right: 320, bottom: 240 }
  assert.equal(quoteAnchor(quote, selection, bounds).top, 60)
  assert.equal(quoteAnchor(quote, { focusNode: quote.range.startContainer, focusOffset: 0 }, bounds).top, 30)
  assert.equal(quoteAnchor(quote, selection, { ...bounds, top: 100 }), null)
  const position = quotePosition({ left: 290, right: 320, top: 22, bottom: 42 }, { width: 100, height: 44 }, bounds)
  assert.equal(position.left, 212)
  assert.equal(position.top, 50)
})

async function fixture(t, { text = 'Original first sentence. Selected second sentence. Last sentence.' } = {}) {
  document.body.innerHTML = '<div id="root"></div>'
  const ui = createSource({ quote: null }), calls = [], insertions = []
  const inputActions = { captureInsertion: () => ({ end: true }), insertText: (text, at) => { insertions.push({ text, at }); document.querySelector('[role=textbox]').textContent += text } }
  const actions = { ...teamActions({ ui }), openSession() {}, reportError() {} }
  const quote = actions.quote
  actions.quote = (...args) => { calls.push(args); quote(...args) }
  const roster = { bots: [{ id: 'chief', name: 'Chief' }], byId: { chief: { name: 'Chief' } }, roomsById: {} }
  const useUi = pick => pick(React.useSyncExternalStore(ui.subscribe, ui.getSnapshot))
  function Fixture({ sessionId = 'chief', disabled = false }) {
    return React.createElement(React.Fragment, null,
      React.createElement(Bubbles, { texts: [text], roster, selfId: 'chief', actions, sessionId: 'chief', useUi }),
      React.createElement(UserMessageCell, { node: { data: { content: [{ type: 'text', text: 'User message to quote.' }] } }, sessionId: 'chief', useRoster: pick => pick(roster), actions }),
      React.createElement('div', { className: 'x_centerCol' }, React.createElement('div', { role: 'textbox', contentEditable: true, suppressContentEditableWarning: true }, 'Existing draft. '), React.createElement(ComposerVoice, { sessionId, inputActions, actions, useUi, useRoster: pick => pick({ ...roster, prefs: {} }) })),
      React.createElement(SelectionReply, { sessionId, disabled, actions }))
  }
  const root = createRoot(document.getElementById('root'))
  const render = async props => { await React.act(async () => { root.render(React.createElement(Fixture, props)) }) }
  t.after(async () => { await React.act(async () => root.unmount()); window.getSelection().removeAllRanges() })
  await render()
  const choose = async (start = 25, end = 50) => { select(document.querySelector('.bt-bubble p').firstChild, start, undefined, end); await settle() }
  const button = () => document.querySelector('.bt-selection-reply button')
  return { calls, insertions, choose, button, render }
}

test('selection reply reuses the composer, preserves its draft and focus, and inserts only the chosen text', async t => {
  const f = await fixture(t)
  await f.choose(25, 50)
  assert.equal(f.button()?.textContent, 'Quote selection')
  assert.equal(document.querySelectorAll('.bt-selection-reply').length, 1)
  const down = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true })
  await React.act(async () => { f.button().dispatchEvent(down); f.button().click() })
  assert.equal(down.defaultPrevented, true)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0][0], 'chief')
  assert.equal(f.calls[0][1], 'Selected second sentence.')
  assert.equal(f.calls[0][2].selection, true)
  assert.equal(f.insertions.length, 1)
  assert.equal(f.insertions[0].text, '> Selected second sentence.\n\n')
  assert.equal(document.querySelector('[role=textbox]').textContent, 'Existing draft. > Selected second sentence.\n\n')
  assert.equal(document.activeElement.getAttribute('role'), 'textbox')
})

test('the original Reply button prefers this message selection, then falls back to whole-message reply', async t => {
  const f = await fixture(t)
  await f.choose(25, 50)
  await React.act(async () => document.querySelector('.bt-tools button[aria-label=Reply]').click())
  assert.equal(f.calls[0][1], 'Selected second sentence.')
  assert.equal(f.calls[0][2].selection, true)
  window.getSelection().removeAllRanges()
  await React.act(async () => document.querySelector('.bt-tools button[aria-label=Reply]').click())
  assert.equal(f.calls[1][1], 'Original first sentence. Selected second sentence. Last sentence.')
  assert.equal(f.calls[1].length, 2)
})

test('Escape dismisses the selection action, and session changes or overlays prevent stale replies', async t => {
  const f = await fixture(t)
  await f.choose()
  assert.ok(f.button())
  await React.act(async () => document.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'Escape', bubbles: true })))
  assert.ok(f.button().disabled)
  document.dispatchEvent(new window.Event('selectionchange')); await settle()
  assert.ok(!f.button() || f.button().disabled)
  await React.act(async () => { document.dispatchEvent(new window.Event('pointerdown')); document.dispatchEvent(new window.Event('pointerup')) })
  await f.choose()
  assert.equal(f.button()?.disabled, false, 'Explicitly reselecting the same text shows the action again')
  await f.render({ sessionId: 'peer' })
  assert.equal(f.button(), null)
  await f.render({ disabled: true })
  await f.choose()
  assert.equal(f.button(), null)
  assert.equal(f.calls.length, 0)
})


test('a long multiline selection reaches the existing quote composer intact', async t => {
  const selected = `  Keep indentation\n${'selected content '.repeat(30)}\nFinal selected line.`
  const f = await fixture(t, { text: `Prefix. ${selected} Suffix.` })
  await f.choose(8, 8 + selected.length)
  await React.act(async () => f.button().click())
  assert.equal(f.calls[0][1], selected)
  assert.equal(f.insertions[0].text, quoteText({ text: selected, selection: true }))
  assert.equal(f.insertions[0].text.endsWith('> Final selected line.\n\n'), true)
})


test('sent user messages use the same selection reply action', async t => {
  const f = await fixture(t)
  select(document.querySelector('.bt-ubody').firstChild, 0, undefined, 12)
  await settle()
  assert.ok(f.button())
  await React.act(async () => f.button().click())
  assert.equal(f.calls[0][1], 'User message')
  assert.equal(f.insertions[0].text, '> User message\n\n')
})

test('native modal dialogs suppress a lingering transcript selection', async t => {
  const f = await fixture(t)
  await f.choose()
  const modal = document.createElement('div')
  modal.setAttribute('aria-modal', 'true'); document.body.append(modal)
  document.dispatchEvent(new window.Event('selectionchange')); await settle()
  assert.ok(!f.button() || f.button().disabled)
  modal.remove()
  assert.equal(f.calls.length, 0)
})
