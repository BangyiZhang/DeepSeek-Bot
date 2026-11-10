// macOS keeps application Quit and Command+Q alongside the tray controls.
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { app, state } from './helpers/fake-electron.mjs'
import { startApp, waitFor } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

// The menu of macOS is the menu of the app on macOS.
Object.defineProperty(process, 'platform', { value: 'darwin' })

before(async () => { await startApp({ packaged: false }) })

test('the application menu of macOS retains Quit and Command+Q', async () => {
  await waitFor(() => state.menus.length > 0, 'set the menu')
  await waitFor(() => state.tray !== undefined, 'build the tray')
  const menu = state.menus.at(-1).template
  const items = menu[0].submenu
  assert.equal(menu[0].label, 'DS Bot', 'the menu of the app')
  const quit = items.find(item => item.accelerator === 'Command+Q')
  assert.equal(typeof quit?.click, 'function', 'application Quit remains available')
  // The menu keeps the rest of macOS: about, services and the hiding of the app.
  const roles = items.map(item => item.role).filter(Boolean)
  for (const role of ['about', 'services', 'hide', 'hideOthers', 'unhide']) assert.ok(roles.includes(role), `the menu keeps ${role}`)
})

test('the app ends', async () => {
  app.quit()
  await waitFor(() => state.tray.destroyed === true, 'take the tray away')
})
