import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { BrowserWindow, dialog, ipcMain, shell, clipboard } from 'electron'
import type { FileNode, Settings } from '../shared/types'
import { getSettings, updateSettings, addRoots, removeRoot, resolveScoped, toScoped } from './settingsStore'
import { AgentSession } from './agent/orchestrator'
import { registerGitIPC } from './gitService'
import { registerPtyIPC } from './ptyService'
import { registerCursorIPC } from './cursorFeatures'
import { registerImagesIPC } from './imagesIPC'
import { registerWorkspaceImportIPC } from './workspaceImport'
import { proxySafeFetch } from './proxyFetch'
import { bindIndexWindow, autoIndex, isIndexing } from './indexingService'
import { memory, updateFile, dropFile } from './workspaceMemory'
import * as sessionStore from './sessionStore'

const IGNORED = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', '.meencode', '__pycache__',
  '.venv', 'venv', '.pytest_cache', '.idea', 'target', '.next'
])

let session: AgentSession
let win: BrowserWindow
let watchers: fs.FSWatcher[] = []

export function registerIPC(mainWindow: BrowserWindow, agentSession: AgentSession): void {
  win = mainWindow
  session = agentSession
  bindIndexWindow(mainWindow)
  restartWatchers()
  registerGitIPC(mainWindow)
  registerPtyIPC(mainWindow)
  registerWorkspaceImportIPC(mainWindow)
  registerCursorIPC(mainWindow, agentSession)
  registerImagesIPC(mainWindow)

  applyWorkspaceToSession()
  void autoIndex()

  // ---------- window / app ----------
  ipcMain.handle('win:minimize', () => win.minimize())
  ipcMain.handle('win:maximize', () => (win.isMaximized() ? win.unmaximize() : win.maximize()))
  ipcMain.handle('win:close', () => win.close())
  ipcMain.handle('win:zoom', (_e, dir: 'in' | 'out' | 'reset') => {
    if (dir === 'reset') win.webContents.setZoomLevel(0)
    else win.webContents.setZoomLevel(win.webContents.getZoomLevel() + (dir === 'in' ? 0.5 : -0.5))
    return true
  })
  ipcMain.handle('app:about', () => {
    const settings = getSettings()
    return { app: 'Meencode', version: '0.1.0', model: settings.model, workspace: settings.roots.join(', ') || null, electron: process.versions.electron, node: process.versions.node }
  })
  ipcMain.handle('clipboard:read', () => clipboard.readText())
  ipcMain.handle('dev:tools', () => win.webContents.toggleDevTools())
  ipcMain.handle('open:external', (_e, url: string) => shell.openExternal(url))

  // ---------- settings ----------
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:update', (_e, patch: Partial<Settings>) => {
    const s = updateSettings(patch)
    applyWorkspaceToSession()
    restartWatchers()
    if (patch.roots !== undefined) void autoIndex(true)
    return s
  })

  // ---------- models ----------
  ipcMain.handle('models:list', async () => {
    const s = getSettings()
    if (!s.apiKey) return { ok: false, models: [] as string[], error: 'Add your Ollama Cloud API key first.' }
    let base = s.baseUrl.trim().replace(/\/+$/, '')
    if (base.endsWith('/v1/chat/completions')) base = base.slice(0, -'/v1/chat/completions'.length)
    else if (base.endsWith('/chat/completions')) base = base.slice(0, -'/chat/completions'.length)
    else if (base.endsWith('/v1')) base = base.slice(0, -'/v1'.length)
    if (!/^https?:\/\//.test(base)) base = 'https://' + base
    try {
      let res = await proxySafeFetch(base + '/v1/models', {
        headers: { Authorization: `Bearer ${s.apiKey}` }
      })
      // fall back to the native Ollama API when the OpenAI-compatible one is absent
      if (res.status === 404) {
        res = await proxySafeFetch(base + '/api/tags', {
          headers: { Authorization: `Bearer ${s.apiKey}` }
        })
      }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, models: [] as string[], error: 'Invalid or missing Ollama Cloud API key. Add your key in Settings.' }
      }
      if (!res.ok) {
        const t = await res.text().catch(() => '')
        return { ok: false, models: [] as string[], error: `Ollama Cloud error ${res.status}: ${t.slice(0, 200)}` }
      }
      const j = (await res.json()) as { data?: { id?: string; name?: string; model?: string }[]; models?: { id?: string; name?: string; model?: string }[] }
      const list = j.data ?? j.models ?? []
      const models = [...new Set(list.map((m) => m.id ?? m.name ?? m.model).filter((x): x is string => typeof x === 'string'))].sort()
      return { ok: true, models, error: null }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const cause = (e as { cause?: { message?: string } })?.cause?.message
      return { ok: false, models: [] as string[], error: cause ? `${msg} (${cause})` : msg }
    }
  })

  // ---------- multi-root workspace ----------
  ipcMain.handle('workspace:addFolders', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'multiSelections'] })
    if (r.canceled || r.filePaths.length === 0) return { ok: false, added: [] as string[] }
    const s = addRoots(r.filePaths)
    applyWorkspaceToSession()
    restartWatchers()
    void autoIndex()
    return { ok: true, added: r.filePaths, roots: s.roots }
  })

  ipcMain.handle('workspace:removeRoot', (_e, abs: string) => {
    const s = removeRoot(abs)
    applyWorkspaceToSession()
    restartWatchers()
    void autoIndex(true)
    return { ok: true, roots: s.roots }
  })

  ipcMain.handle('workspace:roots', () => getSettings().roots)

  ipcMain.handle('index:stats', () => ({
    ready: memory.ready,
    indexing: isIndexing(),
    files: memory.stats?.files ?? 0,
    lines: memory.stats?.lines ?? 0,
    symbols: memory.stats?.symbols ?? 0
  }))

  ipcMain.handle('fs:openFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    // "Open Folder" resets to a single-root workspace
    const s = updateSettings({ roots: [r.filePaths[0]], workspace: r.filePaths[0] })
    applyWorkspaceToSession()
    restartWatchers()
    void autoIndex(true)
    return s.roots[0]
  })

  // ---------- fs (scoped paths "N:rel") ----------
  ipcMain.handle('fs:tree', () => buildScopedTree())

  ipcMain.handle('fs:read', (_e, scoped: string) => {
    const { abs } = resolveScoped(scoped)
    const st = fs.statSync(abs)
    if (st.size > 2 * 1024 * 1024) throw new Error('File too large to open in the editor')
    return fs.readFileSync(abs, 'utf8')
  })

  ipcMain.handle('fs:write', (_e, scoped: string, content: string) => {
    const { abs } = resolveScoped(scoped)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
    return true
  })

  ipcMain.handle('fs:create', (_e, scopedDir: string, name: string, type: 'file' | 'dir') => {
    const { abs } = resolveScoped(scopedDir || '0:')
    if (!/^[^\\/:*?"<>|]+$/.test(name)) throw new Error('Invalid name')
    const target = path.join(abs, name)
    if (type === 'dir') fs.mkdirSync(target, { recursive: true })
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, '')
    }
    return toScoped(target)
  })

  ipcMain.handle('fs:remove', (_e, scoped: string) => {
    const { abs, root } = resolveScoped(scoped)
    if (abs === path.resolve(root)) throw new Error('Cannot delete a workspace folder root — remove it from the workspace instead')
    fs.rmSync(abs, { recursive: true, force: true })
    return true
  })

  ipcMain.handle('fs:rename', (_e, scoped: string, newName: string) => {
    const { abs } = resolveScoped(scoped)
    if (!/^[^\\/:*?"<>|]+$/.test(newName)) throw new Error('Invalid name')
    const target = path.join(path.dirname(abs), newName)
    fs.renameSync(abs, target)
    return toScoped(target)
  })

  ipcMain.handle('fs:listFiles', () => listAllFiles())

  ipcMain.handle('fs:reveal', (_e, scoped: string) => {
    const { abs } = resolveScoped(scoped)
    shell.showItemInFolder(abs)
    return true
  })

  // ---------- agent ----------
  ipcMain.handle('agent:send', (_e, text: string, attachedFile?: string | null, images?: { name: string; dataUrl: string }[], ide?: {
    activeFile: string | null
    cursorLine?: number
    selection?: string
    openTabs: string[]
    diagnostics?: { path: string; line: number; severity: string; message: string }[]
  }) => {
    void session.send(text, attachedFile ?? null, images, ide ?? null)
    return true
  })
  ipcMain.handle('agent:stop', () => { session.stop(); return true })
  ipcMain.handle('agent:approve', (_e, id: string, ok: boolean) => session.resolveApproval(id, ok))
  ipcMain.handle('agent:reset', () => { session.reset(); return true })

  // ---------- sessions (SQLite) ----------
  ipcMain.handle('sessions:list', () => sessionStore.listSessions())
  ipcMain.handle('sessions:load', (_e, sessionId: string) => {
    const transcript = session.loadSession(String(sessionId ?? ''))
    if (!transcript) return { ok: false as const, messages: [] }
    return { ok: true as const, messages: transcript }
  })
  ipcMain.handle('sessions:delete', (_e, sessionId: string) => {
    sessionStore.deleteSession(String(sessionId ?? ''))
    return true
  })
  ipcMain.handle('sessions:rename', (_e, sessionId: string, title: string) => {
    sessionStore.renameSession(String(sessionId ?? ''), String(title ?? ''))
    return true
  })
  ipcMain.handle('agent:revert', (_e, scoped: string) => session.revert(toLegacyRel(scoped)))
  ipcMain.handle('agent:revertAll', () => session.revertAll())
  ipcMain.handle('agent:changes', () => session.getChanges())

  // ---------- terminal ----------
  ipcMain.handle('exec:run', (_e, command: string) => {
    const roots = getSettings().roots
    const id = `user-${randomUUID().slice(0, 6)}`
    if (roots.length === 0 || !command) return id
    const isWin = process.platform === 'win32'
    const child = spawn(isWin ? 'cmd' : 'bash', isWin ? ['/d', '/s', '/c', command] : ['-c', command], {
      cwd: roots[0],
      env: { ...process.env, NO_COLOR: '1' }
    })
    child.stdout?.on('data', (d) => win.webContents.send('exec:event', { kind: 'output', id, stream: 'stdout', data: d.toString() }))
    child.stderr?.on('data', (d) => win.webContents.send('exec:event', { kind: 'output', id, stream: 'stderr', data: d.toString() }))
    child.on('close', (code) => win.webContents.send('exec:event', { kind: 'exit', id, code }))
    return id
  })
}

export function sendAgentEvent(e: unknown): void {
  win?.webContents?.send('agent:event', e)
}

// ---------------- helpers ----------------

function applyWorkspaceToSession(): void {
  const roots = getSettings().roots
  // the agent sees ALL workspace folders (multi-root)
  session.setRoots(roots)
}

/** old-style relative paths ("src/a.ts") are resolved against root 0 for agent compat */
function toLegacyRel(scoped: string): string {
  try {
    const { rel } = resolveScoped(scoped)
    return rel.split(path.sep).join('/')
  } catch {
    return scoped
  }
}

function buildScopedTree(): FileNode[] {
  const roots = getSettings().roots
  const out: FileNode[] = []
  roots.forEach((rootDir, idx) => {
    const children: FileNode[] = []
    const walk = (dir: string, into: FileNode[], depth: number, relBase: string): void => {
      if (depth > 10) return
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch { return }
      for (const e of entries) {
        if (IGNORED.has(e.name) || e.name.startsWith('.DS')) continue
        const abs = path.join(dir, e.name)
        const rel = relBase ? `${relBase}/${e.name}` : e.name
        if (e.isDirectory()) {
          const kids: FileNode[] = []
          const node: FileNode = { name: e.name, path: `${idx}:${rel}`, type: 'dir', children: kids }
          into.push(node)
          walk(abs, kids, depth + 1, rel)
        } else {
          into.push({ name: e.name, path: `${idx}:${rel}`, type: 'file' })
        }
      }
    }
    walk(path.resolve(rootDir), children, 0, '')
    out.push({
      name: path.basename(path.resolve(rootDir)) || rootDir,
      path: `${idx}:`,
      type: 'dir',
      children
    })
  })
  return out
}

function listAllFiles(): string[] {
  const files: string[] = []
  const roots = getSettings().roots
  roots.forEach((rootDir, idx) => {
    const walk = (dir: string, depth: number): void => {
      if (depth > 12 || files.length >= 8000) return
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch { return }
      for (const e of entries) {
        if (IGNORED.has(e.name)) continue
        const abs = path.join(dir, e.name)
        if (e.isDirectory()) walk(abs, depth + 1)
        else if (files.length < 8000) files.push(`${idx}:${path.relative(path.resolve(rootDir), abs).split(path.sep).join('/')}`)
      }
    }
    walk(path.resolve(rootDir), 0)
  })
  return files
}

function restartWatchers(): void {
  for (const w of watchers) {
    try { w.close() } catch { /* ignore */ }
  }
  watchers = []
  pendingChanges.clear()
  if (indexFlushTimer) clearTimeout(indexFlushTimer)
  indexFlushTimer = null
  const roots = getSettings().roots
  for (const root of roots) {
    try {
      const w = fs.watch(path.resolve(root), { recursive: true }, (event, filename) => {
        const p = filename ? path.resolve(root, String(filename)) : path.resolve(root)
        pendingChanges.add(p)
        // debounce the whole flush (UI refresh + index update) — one pass per burst
        if (indexFlushTimer) clearTimeout(indexFlushTimer)
        indexFlushTimer = setTimeout(() => {
          indexFlushTimer = null
          void flushPendingChanges(root)
        }, 400)
      })
      w.on('error', () => { /* ignore */ })
      watchers.push(w)
    } catch { /* recursive watch unsupported — skip */ }
  }
}

const pendingChanges = new Set<string>()
let indexFlushTimer: NodeJS.Timeout | null = null

/** One pass per change burst: notify UI + live index refresh (async, non-blocking). */
async function flushPendingChanges(root: string): Promise<void> {
  const changed = [...pendingChanges]
  pendingChanges.clear()
  for (const abs of changed) {
    win?.webContents?.send('fs:changed', { path: abs, root })
  }
  // live index update — only for files, ignore .meencode internals and ignored dirs
  for (const abs of changed) {
    const segs = abs.slice(path.resolve(root).length).split(path.sep)
    if (segs.some((s) => IGNORED.has(s))) continue
    try {
      const st = await fs.promises.stat(abs).catch(() => null)
      if (st?.isFile()) updateFile(abs)
      else if (!st) dropFile(abs)
    } catch { /* transient */ }
    // yield between files so the main thread stays responsive
    await new Promise((r) => setTimeout(r, 0))
  }
}