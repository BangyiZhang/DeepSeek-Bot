import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { windowLifecycle } from '../src/window-lifecycle.mjs'

function fixture(platform = 'darwin', retainWithoutWindows = false) {
  const app = new EventEmitter(), window = new EventEmitter()
  let quits = 0, hides = 0, focuses = 0
  app.quit = () => { quits++; app.emit('before-quit', { preventDefault() {} }) }
  window.hide = () => { hides++ }
  window.minimize = () => { throw new Error('A close must hide, not minimize') }
  const lifecycle = windowLifecycle({ app, platform, focusWindow: () => { focuses++ }, retainWithoutWindows })
  lifecycle.bind(window)
  const close = () => {
    let prevented = false
    window.emit('close', { preventDefault() { prevented = true } })
    if (!prevented) { window.emit('closed'); app.emit('window-all-closed') }
    return prevented
  }
  return { app, window, close, lifecycle, counts: () => ({ quits, hides, focuses }) }
}

test('macOS ordinary closes preserve the same window and activation restores it', () => {
  const f = fixture()
  let destroyed = false
  f.window.on('closed', () => { destroyed = true })
  assert.equal(f.close(), true)
  assert.equal(f.close(), true)
  assert.equal(destroyed, false)
  f.app.emit('activate')
  assert.deepEqual(f.counts(), { quits: 0, hides: 2, focuses: 1 })
})

test('true quit bypasses hiding through asynchronous Host shutdown and reentry', () => {
  const f = fixture()
  let shutdowns = 0
  f.app.on('before-quit', event => { if (shutdowns++ === 0) event.preventDefault() })
  f.app.quit()
  f.app.emit('activate')
  assert.equal(f.close(), false)
  assert.deepEqual(f.counts(), { quits: 2, hides: 0, focuses: 0 })
})

for (const platform of ['win32', 'linux']) {
  test(`${platform} closes still destroy the window and quit`, () => {
    const f = fixture(platform)
    assert.equal(f.close(), false)
    assert.deepEqual(f.counts(), { quits: 1, hides: 0, focuses: 0 })
  })
}


test('the tray may retain a Mac app whose window is destroyed', () => {
  const f = fixture('darwin', true)
  f.app.emit('window-all-closed')
  assert.equal(f.counts().quits, 0)
  f.app.emit('activate')
  assert.equal(f.counts().focuses, 1)
})

test('cancelled application quit restores ordinary hiding', () => {
  const f = fixture()
  f.app.emit('before-quit')
  f.lifecycle.cancelQuit()
  assert.equal(f.close(), true)
  assert.equal(f.counts().hides, 1)
})


test('system shutdown and updater quit bypass Mac hiding', () => {
  const app = new EventEmitter(), window = new EventEmitter()
  let ending = true, hidden = 0
  window.hide = () => { hidden++ }
  windowLifecycle({ app, platform: 'darwin', focusWindow() {}, retainWithoutWindows: true, allowClose: () => ending }).bind(window)
  const close = () => {
    let prevented = false
    window.emit('close', { preventDefault() { prevented = true } })
    return prevented
  }
  assert.equal(close(), false)
  assert.equal(hidden, 0)
  ending = false
  assert.equal(close(), true)
  assert.equal(hidden, 1)
})
