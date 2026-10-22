import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

const plugin = fileURLToPath(new URL('..', import.meta.url))
const requireHarness = createRequire(join(process.env.DSH_HARNESS, 'package.json'))
const { JSDOM } = requireHarness('jsdom')
const React = requireHarness('react')
const { createRoot } = requireHarness('react-dom/client')
const { outputFiles } = await build({
  stdin: { contents: "export { ActivityIndicator } from './src/client/activity-row.js'", resolveDir: plugin },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

test('a CLI without a shell running slot shows progress and a ticking clock, then disappears on completion', async () => {
  const dom = new JSDOM('<div id="root"></div><div data-conversation-scroll><div data-chat-flow></div></div>', { pretendToBeVisual: true })
  const { window } = dom
  const old = {}
  for (const key of ['window', 'document', 'MutationObserver']) { old[key] = globalThis[key]; globalThis[key] = window[key] }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const module = { exports: {} }
  const frame = fn => window.requestAnimationFrame(fn)
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, window, document: window.document, MutationObserver: window.MutationObserver,
    requestAnimationFrame: frame, cancelAnimationFrame: id => window.cancelAnimationFrame(id),
    setTimeout, clearTimeout, Date, console,
    require: name => name === '@deepseek-ai/dsh-client-ui-primitives' ? { MarkdownText: () => null } : requireHarness(name),
  })
  let cli = { id: 'r1', provider: 'local-antigravity', phase: 'waiting', active: true, startedAt: Date.now() - 10_000 }
  const props = {
    sessionId: 'a', useRoster: pick => pick({ byId: { a: { id: 'a', name: 'Chief' } }, roomsById: {} }),
    useSessionStatus: pick => pick(new Map()), useLive: pick => pick({}),
    useSession: pick => pick({}), useWork: pick => pick({ cli: { a: cli } }), actions: { clearLive: () => {} },
  }
  const root = createRoot(window.document.getElementById('root'))
  const render = async () => { await React.act(async () => { root.render(React.createElement(module.exports.ActivityIndicator, props)); await new Promise(resolve => setTimeout(resolve, 30)) }) }
  try {
    await render()
    const flow = window.document.querySelector('[data-chat-flow]')
    assert.match(flow.textContent, /Antigravity CLI is waiting for a response/)
    assert.match(flow.textContent, /10s|11s/)
    assert.equal(flow.querySelectorAll('.bt-typing').length, 1)
    assert.ok(flow.querySelector('[data-bt-running-host]'))
    const beforeTick = flow.textContent
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)) })
    assert.notEqual(flow.textContent, beforeTick)
    const input = window.document.createElement('div')
    input.textContent = 'A newly submitted message'
    await React.act(async () => { flow.append(input); await new Promise(resolve => setTimeout(resolve, 30)) })
    assert.ok(flow.lastElementChild.hasAttribute('data-bt-running-host'))
    // A shell slot arriving later replaces the fallback without two indicators.
    const native = window.document.createElement('div')
    native.dataset.chatRunning = ''
    await React.act(async () => { flow.append(native); await new Promise(resolve => setTimeout(resolve, 30)) })
    assert.equal(flow.querySelectorAll('.bt-typing').length, 1)
    assert.equal(flow.querySelector('[data-bt-running-host]'), null)
    cli = { ...cli, phase: 'done', active: false, elapsedMs: 20_000 }
    await render()
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 160)) })
    assert.equal(flow.querySelector('.bt-typing'), null)
    assert.doesNotMatch(flow.textContent, /completed|20s/)
    cli = undefined
    await render()
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 160)) })
    assert.equal(flow.querySelector('.bt-typing'), null)
  } finally {
    await React.act(async () => root.unmount())
    for (const key of Object.keys(old)) { if (old[key] === undefined) delete globalThis[key]; else globalThis[key] = old[key] }
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
    window.close()
  }
})
