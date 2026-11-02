// Keep the macOS team window and its Host alive until an application quit is requested.
export function windowLifecycle({ app, platform, focusWindow, hideWindow = window => window.hide(), retainWithoutWindows = false, allowClose = () => false }) {
  let quitting = false
  // Register before the main process's asynchronous Host shutdown listener.
  app.on('before-quit', () => { quitting = true })
  app.on('activate', () => { if (!quitting) focusWindow() })
  if (!retainWithoutWindows) app.on('window-all-closed', () => { app.quit() })
  return {
    cancelQuit() { quitting = false },
    bind(window) {
      if (platform !== 'darwin') return
      window.on('close', event => {
        if (quitting || allowClose()) return
        event.preventDefault()
        hideWindow(window)
      })
    },
  }
}
