// Test children only: use Electron's main-process inspector, never renderer IPC in the app.
import { createServer } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'

export async function inspectorPort() {
  const server = createServer()
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const port = server.address().port
  await new Promise(done => server.close(done))
  return port
}

export async function appControl(port) {
  let target
  const deadline = Date.now() + 30_000
  while (!target && Date.now() < deadline) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())[0] } catch {}
    if (!target) await sleep(100)
  }
  if (!target) throw new Error('the test application main inspector did not appear')
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map()
  let sequence = 0
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data)), entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id); clearTimeout(entry.timer)
    if (message.error || message.result?.exceptionDetails) entry.reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)))
    else entry.resolve(message.result?.result?.value)
  })
  socket.addEventListener('close', () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('test application inspector closed')) }
    pending.clear()
  })
  await new Promise((done, reject) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  const evaluate = expression => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('test application inspector timeout')) }, 10_000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
  })
  const electron = "process.getBuiltinModule('module').createRequire(process.execPath)('electron')"
  // The inspector listens during Node bootstrap, before Electron installs its module loader.
  let ready = false
  while (!ready && Date.now() < deadline) {
    ready = await evaluate(`Boolean(${electron}.app?.isReady())`).catch(() => false)
    if (!ready) await sleep(100)
  }
  if (!ready) { socket.close(); throw new Error('the test application did not become ready') }
  return {
    evaluate: expression => evaluate(`(() => { const { app, BrowserWindow, Menu } = ${electron}; ${expression} })()`),
    // Disconnect before quit: Node's inspector otherwise holds process exit awaiting detach.
    async quit() {
      await evaluate(`setTimeout(() => ${electron}.app.quit(), 100); true`)
      socket.close()
    },
    close: () => socket.close(),
  }
}
