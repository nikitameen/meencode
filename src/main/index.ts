import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { registerIPC } from './ipc'
import { loadSettings, getSettings } from './settingsStore'
import { SessionManager } from './agentSessions'
import { disposeAllPty } from './ptyService'
import { initSessionDb, pruneSessions, getDb } from './sessionStore'
import { initSliceDb, flushSliceDb } from './sliceStore'
import { ensureKnowledge } from './knowledgeStore'
import { initLearning } from './learningStore'

process.on('uncaughtException', (e) => {
  console.error('MAIN UNCAUGHT EXCEPTION:', e)
})

function loadDotEnv(): void {
  // In dev, getAppPath() is the project root. In a packaged app it points
  // inside app.asar, so also check the exe folder and resources folder —
  // drop a .env next to Meencode.exe to configure keys in production.
  const candidates = [
    path.join(app.getAppPath(), '.env'),
    path.join(process.cwd(), '.env'),
    path.join(path.dirname(app.getPath('exe')), '.env'),
    path.join(process.resourcesPath ?? '', '.env')
  ]
  for (const envPath of candidates) {
    try {
      if (!fs.existsSync(envPath)) continue
      for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
        if (m && process.env[m[1]] === undefined) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
        }
      }
    } catch {
      // each candidate is optional
    }
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    frame: false,
    backgroundColor: '#f7f8fa',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  })
  win.once('ready-to-show', () => win.show())

  // open target=_blank / window.open links from the built-in browser in the user's browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  const sessions = new SessionManager()
  const settings = getSettings()
  if (settings.workspace) sessions.ensureRoots()

  registerIPC(win, sessions)

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// Single instance lock
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const all = BrowserWindow.getAllWindows()
    if (all[0]) {
      if (all[0].isMinimized()) all[0].restore()
      all[0].focus()
    }
  })

  void app.whenReady().then(async () => {
    try {
      loadDotEnv()
      loadSettings()
      await initSessionDb()
      pruneSessions()
      await initSliceDb().catch((e) => console.warn('slice DB unavailable:', e?.message ?? e))
      ensureKnowledge(getSettings().workspace)
      initLearning(getSettings().workspace)
    } catch (e: any) {
      console.warn('session DB unavailable:', e?.message ?? e)
    }
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  }).catch((e) => console.error('MAIN: whenReady failed:', e))

  app.on('window-all-closed', () => {
    disposeAllPty()
    flushSliceDb()
    app.quit()
  })
}
