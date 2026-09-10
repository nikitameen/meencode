// Minimal electron mock for main-process unit tests (no Electron runtime).
const os = require('node:os')
const path = require('node:path')

const userData = path.join(os.tmpdir(), 'meencode-test-userdata')

module.exports = {
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => userData,
    whenReady: () => Promise.resolve()
  },
  BrowserWindow: class { webContents = { send() {} } },
  ipcMain: { handle() {} },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openExternal: async () => {}, showItemInFolder() {} },
  clipboard: { readText: () => '' },
  net: {}
}