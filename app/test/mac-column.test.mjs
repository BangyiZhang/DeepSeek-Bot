import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../src/preload.cjs', import.meta.url), 'utf8')
function fixture(columns = '56px minmax(0px, 1fr) minmax(0px, 320px)') {
  const properties = new Map(), observers = []
  const frame = { style: { gridTemplateColumns: columns, getPropertyValue: name => properties.get(name), setProperty: (name, value) => properties.set(name, value) } }
  const body = { getAttribute: () => null }, root = { dataset: {}, getAttribute: () => null }
  let own = null
  const document = { body, documentElement: root, readyState: 'complete',
    querySelector: selector => selector === '.bt-leftcol,.bt-title-toggle' ? own : frame }
  class MutationObserver {
    constructor(callback) { this.callback = callback }
    observe(target) { observers.push({ target, callback: this.callback }) }
  }
  runInNewContext(source, { document, MutationObserver, location: { origin: 'http://127.0.0.1:3096' },
    process: { argv: ['--ds-bot-origin=http://127.0.0.1:3096', '--ds-bot-mac-titlebar'] },
    require: () => ({ contextBridge: { exposeInMainWorld() {} }, ipcRenderer: { on() {}, send() {} } }) })
  const fire = (target, record = {}) => { for (const observer of observers.filter(item => item.target === target)) observer.callback([record]) }
  return { value: () => properties.get('--ds-bot-mac-columns'),
    columns(value) { frame.style.gridTemplateColumns = value; fire(frame) },
    column(selector) {
      const previous = own
      own = selector ? { nodeType: 1, matches: query => query.includes(selector) } : null
      fire(body, { addedNodes: own ? [own] : [], removedNodes: previous ? [previous] : [] })
    } }
}

test('Bot columns own the left track and preserve the native right sidebar width', () => {
  const f = fixture()
  assert.equal(f.value(), 'var(--ds-bot-mac-rail-width) minmax(0px, 1fr) minmax(0px, 320px)')
  f.column('.bt-leftcol')
  assert.equal(f.value(), '0px minmax(0px, 1fr) minmax(0px, 320px)')
  f.columns('56px minmax(0px, 1fr) minmax(0px, 480px)')
  assert.equal(f.value(), '0px minmax(0px, 1fr) minmax(0px, 480px)')
  f.column('.bt-title-toggle')
  assert.equal(f.value(), '0px minmax(0px, 1fr) minmax(0px, 480px)')
  f.column(null)
  assert.equal(f.value(), 'var(--ds-bot-mac-rail-width) minmax(0px, 1fr) minmax(0px, 480px)')
})

test('Agent mode retains the expanded shell column', () => {
  const f = fixture('280px minmax(0px, 1fr) minmax(0px, 0px)')
  assert.equal(f.value(), '280px minmax(0px, 1fr) minmax(0px, 0px)')
})
