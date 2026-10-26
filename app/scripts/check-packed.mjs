// Check a packaged app: start it on throwaway folders with the ds-bot mock model, choose a model,
// send a message, wait for the reply, then close the window the way a user does and wait until
// the app has exited. Fails on a page error or a non-zero exit.
// Usage: node scripts/check-packed.mjs [app executable] [screenshot.png]
// The executable defaults to the one that `npm run pack` or `npm run dist` writes into dist-pack/.
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const [given, shotFile] = process.argv.slice(2)
const executable = given || packedExecutable()

function packedExecutable() {
  const out = join(root, 'dist-pack')
  if (process.platform === 'win32') return join(out, 'win-unpacked', 'DeepSeek Bot.exe')
  // executableName in electron-builder.yml.
  if (process.platform === 'linux') return join(out, 'linux-unpacked', 'deepseek-bot')
  const dir = ['mac-arm64', 'mac'].find(name => existsSync(join(out, name))) ?? 'mac'
  return join(out, dir, 'DeepSeek Bot.app', 'Contents', 'MacOS', 'DeepSeek Bot')
}

if (!existsSync(executable)) {
  console.error(`check-packed: no app at ${executable}. Run npm run pack first.`)
  process.exit(2)
}

const work = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), 'ds-bot-packed-')))
mkdirSync(join(work, 'home'))
mkdirSync(join(work, 'home', 'profiles', 'ds-bot'), { recursive: true })
writeFileSync(join(work, 'home', 'profiles', 'ds-bot', 'cordis.patch.yml'), '- id: bot\n  config:\n    localCodex: false\n    localAntigravity: false\n    updateCheck: false\n    diagnosticsFile: false\n')
mkdirSync(join(work, 'workspace'))
const children = []

function stopChildren() {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    // On Windows a plain kill ends only the main process; /T takes the Host and Electron's helpers along.
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill()
  }
}

// An app that hangs, for example behind its error box, must not hold up CI.
setTimeout(() => {
  console.error('check-packed: FAILED: gave up after 8 minutes')
  stopChildren()
  process.exit(1)
}, 8 * 60_000).unref()

// Run from inside this checkout, the app would find a module that the build left out in the
// checkout's own node_modules, so the check runs a copy of the app from the throwaway folder.
function outsideCheckout(file) {
  const fromCheckout = relative(resolve(root, '..'), file)
  if (fromCheckout.startsWith('..') || isAbsolute(fromCheckout)) return file
  const appDir = process.platform === 'darwin' ? resolve(file, '..', '..', '..') : dirname(file)
  const copy = join(work, basename(appDir))
  cpSync(appDir, copy, { recursive: true, verbatimSymlinks: true })
  console.log(`check-packed: runs a copy of ${appDir} in ${work}`)
  return join(copy, relative(appDir, file))
}

function startMock() {
  const mock = spawn(process.execPath, [join(root, '..', 'ds-bot', 'dev', 'mock-llm.mjs')], {
    env: { ...process.env, MOCK_PORT: '0', MOCK_LOG: join(work, 'mock.log') }, stdio: ['ignore', 'pipe', 'inherit'],
  })
  children.push(mock)
  return new Promise((done, reject) => {
    let text = ''
    mock.stdout.setEncoding('utf8')
    mock.stdout.on('data', (chunk) => {
      text += chunk
      const url = /http:\/\/127\.0\.0\.1:\d+\/v1/u.exec(text)?.[0]
      if (url) done(url)
    })
    mock.once('exit', (code) => { reject(new Error(`check-packed: the mock model stopped (exit ${String(code)})`)) })
  })
}

async function appPage(port, deadline) {
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()
      const page = targets.find(target => target.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//u.test(target.url))
      if (page) return page
    } catch {
      // The debugging port is not listening yet.
    }
    await sleep(500)
  }
  throw new Error('the app window did not appear')
}

function devtools(url, problems) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let next = 1
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.method === 'Runtime.exceptionThrown') problems.push(`exception: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`)
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') problems.push(`console.error: ${message.params.args.map(arg => arg.value ?? arg.description).join(' ')}`)
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') problems.push(`log: ${message.params.entry.text} ${message.params.entry.url ?? ''}`)
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  })
  const opened = new Promise((done, reject) => {
    socket.addEventListener('open', done, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const call = (method, params = {}) => new Promise((done, reject) => {
    const id = next++
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`the window did not answer ${method}`))
    }, 30_000)
    const settle = action => (value) => { clearTimeout(timer); action(value) }
    pending.set(id, { resolve: settle(done), reject: settle(reject) })
    socket.send(JSON.stringify({ id, method, params }))
  })
  return { opened, call }
}

// mica.css styles DSH's own page, which can change with a DSH upgrade; every rule must still
// find an element, on every platform, so the change shows here and not as a broken window.
function micaRules() {
  const css = readFileSync(join(root, 'src', 'mica.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
  return [...css.matchAll(/([^{}]+)\{/gu)].map(([, selectors]) => selectors.split(',')
    .map(selector => selector.trim().replace(/::(?:before|after)$/u, ''))
    .filter(selector => selector !== '' && selector !== 'body'))
    .filter(rule => rule.length > 0)
}

async function checkMessageSpacing(evaluate) {
  const messages = await evaluate(`(() => {
    return [...document.querySelectorAll('[data-chat-flow] .bt-bubble,[data-chat-flow] [class*="_userRow"] [class*="_bubble"]')].map(node => {
      const rect = node.getBoundingClientRect()
      return { kind: node.closest('[data-chat-flow-kind]')?.getAttribute('data-chat-flow-kind'), top: rect.top, bottom: rect.bottom, height: rect.height }
    }).filter(message => message.height > 0)
  })()`)
  const user = messages.findIndex(message => message.kind === 'user')
  const before = messages[user - 1], after = messages[user + 1]
  if (!before || !after || before.kind !== 'assistant-step' || after.kind !== 'assistant-step'
    || Math.abs(messages[user].top - before.bottom - 12) > 0.5 || Math.abs(after.top - messages[user].bottom - 12) > 0.5) {
    throw new Error(`message spacing must be balanced around the user reply: ${JSON.stringify(messages)}`)
  }
  if (messages.some((message, index) => index > 0 && message.kind === 'assistant-step' && messages[index - 1].kind === 'assistant-step'
    && Math.abs(message.top - messages[index - 1].bottom - 4) > 0.5)) {
    throw new Error(`continuous Bot bubbles lost their compact grouping: ${JSON.stringify(messages)}`)
  }
  console.log('check-packed: balanced message spacing passed (12px between speakers, 4px within a reply)')
}

async function checkHeaderPill(cdp, evaluate, until) {
  const originalDark = await evaluate("matchMedia('(prefers-color-scheme: dark)').matches")
  const collapsed = "document.querySelector('.bt-pill').closest('[class*=\"_frame\"]').hasAttribute('data-sidebar-collapsed')"
  const toggle = async () => {
    await evaluate(`(() => {
      const frame = document.querySelector('.bt-pill').closest('[class*="_frame"]')
      const button = frame.querySelector('.bt-side-collapse') ?? frame.querySelector('[data-slot="sidebar"] button[class*="_toggle"]')
      if (!button) throw new Error('missing left sidebar toggle')
      button.click()
    })()`)
  }
  const measure = async (isCollapsed, hover, detailsOpen = false) => {
    const deadline = Date.now() + 10_000
    let state
    do {
      const point = await evaluate(`(() => {
        const rect = document.querySelector('.bt-pill').getBoundingClientRect()
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      })()`)
      await evaluate('document.activeElement?.blur()')
      await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hover ? point.x : 1100, y: hover ? point.y : 800 })
      // The sidebar spring moves the pill after its collapsed attribute changes.
      // Re-target its current bounds and wait for actual hover and final geometry.
      await sleep(100)
      state = await evaluate(`(() => {
        const pill = document.querySelector('.bt-pill')
        const avatar = pill.querySelector('.bt-pill-avatar')
        const name = pill.querySelector('.bt-pill-name')
        const go = pill.querySelector('.bt-pill-go')
        const memory = pill.querySelector('.bt-pill-mem')
        const rect = name.getBoundingClientRect()
        const path = go.querySelector('path')
        const glyphLeft = new DOMPoint(path.getBBox().x, 0).matrixTransform(path.getScreenCTM()).x
        return {
          hovered: pill.matches(':hover'), focused: pill.matches(':focus-visible'), expanded: pill.getAttribute('aria-expanded'),
          avatar: getComputedStyle(avatar).display !== 'none',
          avatarSize: [avatar.offsetWidth, avatar.offsetHeight],
          name: name.textContent.trim(), nameWidth: rect.width,
          gap: rect.left - avatar.getBoundingClientRect().right,
          cssGap: getComputedStyle(pill).columnGap,
          memoryWidth: memory.getBoundingClientRect().width, memoryMargin: getComputedStyle(memory).marginLeft,
          goWidth: go.getBoundingClientRect().width, goMargin: getComputedStyle(go).marginLeft,
          goGap: go.getBoundingClientRect().left - rect.right, glyphGap: glyphLeft - rect.right,
        }
      })()`)
      const showChevron = hover && !detailsOpen
      const good = state.hovered === hover && !state.focused && state.expanded === String(detailsOpen)
        && state.avatar && state.name.length > 0 && state.nameWidth > 0
        && state.cssGap === '4px' && state.avatarSize.every(size => size === 24) && Math.abs(state.gap - 4) < 0.5
        && state.memoryWidth === 0 && state.memoryMargin === '-4px'
        && (showChevron ? state.goWidth === 10 && state.goMargin === '-2px' && Math.abs(state.goGap - 2) < 0.5 && state.glyphGap <= 6
          : state.goWidth === 0 && state.goMargin === '-4px')
      if (good) return
    } while (Date.now() < deadline)
    throw new Error(`header pill layout (collapsed=${isCollapsed}, hover=${hover}, details=${detailsOpen}): ${JSON.stringify(state)}`)
  }
  try {
    await cdp.call('Page.bringToFront')
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false })
    for (const dark of [false, true]) {
      await cdp.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] })
      await until(`document.body.hasAttribute('data-ds-dark-theme') === ${dark}`, 'the color scheme')
      if (await evaluate(collapsed)) await toggle()
      await until(`!(${collapsed})`, 'the expanded Chief selection')
      const selection = await evaluate(`(() => {
        const style = getComputedStyle(document.querySelector('.bt-tile[aria-current="page"]'))
        return { shadow: style.boxShadow, border: style.borderTopWidth, background: style.backgroundColor }
      })()`)
      if (selection.shadow !== 'none' || selection.border !== '0px' || selection.background === 'rgba(0, 0, 0, 0)') {
        throw new Error(`Chief selection must have a background without a ring: ${JSON.stringify(selection)}`)
      }
      for (const isCollapsed of [false, true]) {
        if (await evaluate(collapsed) !== isCollapsed) await toggle()
        await until(isCollapsed ? collapsed : `!(${collapsed})`, 'the sidebar state')
        for (const hover of [false, true]) await measure(isCollapsed, hover)
        await evaluate("document.querySelector('.bt-pill').click()")
        await until("document.querySelector('.bt-pill').getAttribute('aria-expanded') === 'true'", 'open conversation details')
        for (const hover of [false, true]) await measure(isCollapsed, hover, true)
        await evaluate("document.querySelector('.bt-pill').click()")
        await until("document.querySelector('.bt-pill').getAttribute('aria-expanded') === 'false'", 'close conversation details')
        await measure(isCollapsed, true)
        if (shotFile) {
          const { data } = await cdp.call('Page.captureScreenshot', { format: 'png' })
          const target = resolve(`${shotFile.replace(/\.png$/u, '')}-header-${dark ? 'dark' : 'light'}-${isCollapsed ? 'collapsed' : 'expanded'}.png`)
          writeFileSync(target, Buffer.from(data, 'base64'))
          console.log(`check-packed: saved ${target}`)
        }
      }
    }
    // Left navigation layout must not change the details cue or hide the avatar.
    await toggle()
    await until(`!(${collapsed})`, 'the expanded sidebar')
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false })
    await until(collapsed, 'responsive sidebar collapse')
    await measure(true, false)
    await toggle()
    await until(`!(${collapsed})`, 'manual narrow sidebar expansion')
    await measure(false, true)
    console.log('check-packed: details-only chevron, persistent avatar and borderless Chief selection passed in both themes and responsive sidebar states')
  } finally {
    await cdp.call('Emulation.clearDeviceMetricsOverride')
    await cdp.call('Emulation.setEmulatedMedia', { features: [] })
    await until(`document.body.hasAttribute('data-ds-dark-theme') === ${originalDark}`, 'the original color scheme')
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 })
  }
}

async function chat(cdp) {
  const evaluate = async expression => (await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value
  const until = async (expression, label, ms = 120_000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await evaluate(`Boolean(${expression})`)) return
      await sleep(250)
    }
    throw new Error(`timed out waiting for ${label}`)
  }
  // DSH shows a preview notice once per profile; it would keep the focus away from the composer.
  const dismissNotice = () => evaluate("[...document.querySelectorAll('[role=dialog] button')].find(node => /^(Continue|继续)$/u.test(node.textContent.trim()))?.click()")
  const text = needle => `document.body.innerText.includes(${JSON.stringify(needle)})`
  await cdp.call('Runtime.enable')
  await cdp.call('Log.enable')
  await until("document.querySelector('.bt-tile, .bt-row')", 'the team')
  const stale = await evaluate(`${JSON.stringify(micaRules())}.filter(rule => !rule.some(selector => document.querySelector(selector) !== null)).map(rule => rule.join(', '))`)
  if (stale.length > 0) throw new Error(`src/mica.css no longer matches DSH's page: ${stale.join(' | ')}`)
  await dismissNotice()
  const main = await evaluate("fetch('api/bot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'state', payload: {} }) }).then(r => r.json()).then(r => r.value.mainBotId)")
  await evaluate(`document.querySelector(${JSON.stringify(`[data-bot-id="${main}"]`)}).click()`)
  await until("document.querySelector('.bt-model-chip:not(.bt-model-chip-quiet)')", 'the model choice')
  await evaluate("document.querySelector('.bt-model-chip:not(.bt-model-chip-quiet)').click()")
  // The mock model's greeting for a new team.
  await until(text('先让团队帮你做哪块'), 'the greeting')
  await dismissNotice()
  // Click the composer through the input pipeline. A bare focus() is not enough where no window
  // manager gives the window focus (xvfb in CI): the text and the Enter would go nowhere.
  const box = "[...document.querySelectorAll('[role=textbox][contenteditable=true], textarea')].at(-1)"
  const focusCheck = "(document.activeElement?.isContentEditable ?? false) || document.activeElement?.tagName === 'TEXTAREA'"
  // A greeting that just arrived leaves the composer rebinding: for a moment the field is
  // not editable, so a click lands on it but does not focus it. The probe and the click are
  // separate round trips, so keep probing and click only where the field itself is on top
  // until the field holds focus.
  const probe = `(() => {
    const el = ${box}
    if (el === undefined) return null
    const rect = el.getBoundingClientRect()
    for (const part of [0.5, 0.25, 0.75, 0.1, 0.9]) {
      const point = { x: rect.x + rect.width * part, y: rect.y + rect.height / 2 }
      const hit = document.elementFromPoint(point.x, point.y)
      if (hit === el || (hit !== null && el.contains(hit))) return { x: point.x, y: point.y }
    }
    return null
  })()`
  let shot = null
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && !(await evaluate(`Boolean(${focusCheck})`))) {
    const point = await evaluate(probe)
    if (point !== null && point !== undefined) {
      shot = point
      await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      await sleep(300)
    } else await sleep(250)
  }
  if (!(await evaluate(`Boolean(${focusCheck})`))) {
    // Say what was under the cursor, what held the focus and how large the window was.
    const state = await evaluate(`(() => {
      const el = ${box}
      const rect = el === undefined ? null : el.getBoundingClientRect().toJSON()
      const point = rect === null ? null : { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      const hit = point === null ? null : document.elementFromPoint(point.x, point.y)
      const cover = hit?.closest?.('[role=dialog],[aria-modal=true],[data-slot]')
      const brief = node => (node === null || node === undefined ? null : { tag: node.tagName ?? null, class: String(node.getAttribute?.('class') ?? '').slice(0, 160) })
      return JSON.stringify({
        inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight], screen: [screen.width, screen.height], dpr: devicePixelRatio, focused: document.hasFocus(),
        click: ${JSON.stringify(shot)}, probe: point, box: rect,
        hit: brief(hit),
        cover: cover === null || cover === undefined ? null : { tag: cover.tagName, slot: cover.getAttribute('data-slot'), role: cover.getAttribute('role'), modal: cover.getAttribute('aria-modal') },
        active: brief(document.activeElement),
      })
    })()`)
    throw new Error(`timed out waiting for the focused composer; page state: ${state}`)
  }
  await cdp.call('Input.insertText', { text: 'packaged app check' })
  await until(text('packaged app check'), 'the typed message', 10_000)
  for (const type of ['keyDown', 'keyUp']) await cdp.call('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  // The mock model starts its reply with 收到： and the message.
  try {
    await until(text('收到：packaged app check'), 'the reply')
  } catch (error) {
    const state = await evaluate("JSON.stringify({ active: document.activeElement?.tagName ?? null, editable: document.activeElement?.isContentEditable ?? null, tail: document.body.innerText.slice(-300) })")
    throw new Error(`${error.message}; page state: ${state}`)
  }
  await sleep(1000)
  const selection = await evaluate(`(() => {
    const tile = document.querySelector('.bt-tile[aria-current="page"]')
    if (!tile) return null
    const style = getComputedStyle(tile)
    return { shadow: style.boxShadow, border: style.borderTopWidth, background: style.backgroundColor }
  })()`)
  if (!selection || selection.shadow !== 'none' || selection.border !== '0px' || selection.background === 'rgba(0, 0, 0, 0)') {
    throw new Error(`the selected Chief tile must use only a background highlight: ${JSON.stringify(selection)}`)
  }
  await checkMessageSpacing(evaluate)
  await checkHeaderPill(cdp, evaluate, until)
  console.log(`check-packed: chat ${JSON.stringify(await evaluate('document.body.innerText.slice(-200)'))}`)
}

let failed = false
const problems = []
try {
  const modelUrl = await startMock()
  const port = 9300 + Math.floor(Math.random() * 600)
  // A terminal inside an Electron-based editor may set ELECTRON_RUN_AS_NODE, which turns the app into plain Node.
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
  Object.assign(env, {
    DS_BOT_HOME: join(work, 'home'), DS_BOT_SHELL_DATA: join(work, 'shell'),
    DS_BOT_WORKSPACE: join(work, 'workspace'),
    DEEPSEEK_BASE_URL: modelUrl, DEEPSEEK_API_KEY: 'mock-key',
  })
  const app = spawn(outsideCheckout(resolve(executable)), [`--remote-debugging-port=${String(port)}`], { stdio: 'inherit', env })
  children.push(app)
  const exited = new Promise((done) => { app.once('exit', (code, signal) => { done({ code, signal }) }) })
  const cdp = devtools((await appPage(port, Date.now() + 120_000)).webSocketDebuggerUrl, problems)
  await cdp.opened
  const chatError = await chat(cdp).then(() => undefined, error => error)
  if (shotFile) {
    const { data } = await cdp.call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(resolve(shotFile), Buffer.from(data, 'base64'))
    console.log(`check-packed: saved ${resolve(shotFile)}`)
  }
  // Closed like a user closes it, also after a failure, so that the app stops its Host. The page
  // goes away with the window, so this call gets no answer.
  void cdp.call('Runtime.evaluate', { expression: 'window.close()' }).catch(() => undefined)
  const outcome = await Promise.race([exited, sleep(40_000).then(() => undefined)])
  if (chatError) throw chatError
  if (outcome === undefined) throw new Error('the app did not exit after its window closed')
  console.log(`check-packed: app exited (code ${String(outcome.code)}, signal ${String(outcome.signal)})`)
  if (outcome.code !== 0) throw new Error(`the app exited with code ${String(outcome.code)}`)
  if (problems.length > 0) throw new Error(`page problems:\n  ${problems.join('\n  ')}`)
  console.log('check-packed: passed')
} catch (error) {
  failed = true
  console.error(`check-packed: FAILED: ${error instanceof Error ? error.message : String(error)}`)
}
stopChildren()
await sleep(500)
rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
process.exit(failed ? 1 : 0)
