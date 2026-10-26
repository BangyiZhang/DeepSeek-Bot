import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { build } from 'esbuild'

const requireHarness = createRequire(join(process.env.DSH_HARNESS, 'package.json'))
const { JSDOM } = requireHarness('jsdom')
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/focus-scope.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, external: ['react'],
})

function setup(markup) {
  const dom = new JSDOM(`<button id="trigger">Open</button>${markup}`)
  const { window } = dom
  window.HTMLElement.prototype.getClientRects = function () { return this.closest('[hidden]') ? [] : [{}] }
  const module = { exports: {} }
  const frames = []
  runInNewContext(outputFiles[0].text, { module, exports: module.exports, document: window.document, performance, require: requireHarness, requestAnimationFrame: fn => frames.push(fn) })
  const get = id => window.document.getElementById(id)
  get('trigger').focus()
  return {
    get, window, document: window.document, attach: module.exports.attachFocusScope, useFocusScope: module.exports.useFocusScope,
    flushFrames: () => frames.splice(0).forEach(fn => fn()),
    key(key, options = {}) {
      const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
      window.document.activeElement.dispatchEvent(event)
      return event
    },
    close: () => window.close(),
  }
}

test('dialog focus wraps in both directions, skips unavailable controls and returns to its trigger', () => {
  const s = setup('<div id="dialog" tabindex="-1"><button id="first">First</button><button disabled>Disabled</button><div hidden><button>Hidden</button></div><button id="last">Last</button></div>')
  const detach = s.attach(s.get('dialog'), { modal: true })
  try {
    assert.equal(s.document.activeElement, s.get('first'))
    assert.ok(s.key('Tab', { shiftKey: true }).defaultPrevented)
    assert.equal(s.document.activeElement, s.get('last'))
    assert.ok(s.key('Tab').defaultPrevented)
    assert.equal(s.document.activeElement, s.get('first'))
  } finally { detach() }
  assert.equal(s.document.activeElement, s.get('trigger'))
  s.close()
})

test('a portaled menu owns keyboard navigation without the underlying modal taking focus', () => {
  const s = setup('<div id="dialog"><button id="model">Model</button></div><div id="menu"><button id="alpha">Alpha</button><button disabled>Beta</button><button id="alpine">Alpine</button><button id="gamma">Gamma</button></div>')
  const dialog = s.attach(s.get('dialog'), { modal: true })
  let closed = false
  const menu = s.attach(s.get('menu'), { menu: true, close: () => { closed = true } })
  try {
    s.key('ArrowUp')
    assert.equal(s.document.activeElement, s.get('gamma'))
    s.key('Home')
    assert.equal(s.document.activeElement, s.get('alpha'))
    s.key('a')
    assert.equal(s.document.activeElement, s.get('alpine'))
    s.key('a')
    assert.equal(s.document.activeElement, s.get('alpha'))
    s.key('End')
    assert.equal(s.document.activeElement, s.get('gamma'))
    assert.ok(s.key('Tab').defaultPrevented)
    assert.equal(closed, true)
  } finally { menu() }
  assert.equal(s.document.activeElement, s.get('model'))
  assert.ok(s.key('Tab').defaultPrevented)
  dialog()
  assert.equal(s.document.activeElement, s.get('trigger'))
  s.close()
})

test('closing a layer never steals focus from a newly opened dialog or composer', () => {
  const s = setup('<div id="dialog"><button>Close</button></div><input id="composer">')
  const detach = s.attach(s.get('dialog'), { modal: true })
  s.get('composer').focus()
  detach()
  assert.equal(s.document.activeElement, s.get('composer'))
  s.close()
})

test('empty dialogs keep Tab local, and text fields keep their editing and IME keys', () => {
  const s = setup('<div id="empty" tabindex="-1"></div><div id="menu"><input id="search"><button>Alpha</button></div>')
  const empty = s.attach(s.get('empty'), { modal: true })
  assert.equal(s.document.activeElement, s.get('empty'))
  assert.ok(s.key('Tab').defaultPrevented)
  empty()
  const menu = s.attach(s.get('menu'), { menu: true })
  try {
    assert.equal(s.document.activeElement, s.get('search'))
    assert.equal(s.key('Home').defaultPrevented, false)
    assert.equal(s.key('a', { isComposing: true }).defaultPrevented, false)
    assert.equal(s.document.activeElement, s.get('search'))
  } finally { menu(); s.close() }
})

test('closing a dialog opened by a dismissed palette returns to the composer when the trigger is gone', () => {
  const s = setup('<div id="dialog"><button>Close</button></div><div id="composer" contenteditable="true" role="textbox" tabindex="0"></div>')
  const detach = s.attach(s.get('dialog'), { modal: true })
  s.get('trigger').remove()
  detach()
  assert.equal(s.document.activeElement, s.get('composer'))
  s.document.body.tabIndex = -1
  s.document.body.focus()
  s.flushFrames()
  assert.equal(s.document.activeElement, s.get('composer'))
  s.close()
})
