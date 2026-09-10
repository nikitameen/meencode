import { randomUUID } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'

type Pty = {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  pid: number
}

interface PtySession {
  id: string
  pty: Pty | null
  fallback: { proc: import('node:child_process').ChildProcess } | null
  cols: number
  rows: number
}

let sessions = new Map<string, PtySession>()
let win: BrowserWindow
let ptyModule: any = null
let ptyTried = false

function loadPty(): any {
  if (ptyTried) return ptyModule
  ptyTried = true
  try {
    ptyModule = require('node-pty')
  } catch {
    ptyModule = null
  }
  return ptyModule
}

export type ShellProfile = 'powershell' | 'cmd' | 'gitbash' | 'default'

const PROFILE_SPECS: Record<Exclude<ShellProfile, 'default'>, { win?: string; winArgs?: string[]; unix?: string; unixArgs?: string[] }> = {
  powershell: { win: 'powershell.exe', winArgs: ['-NoLogo'] },
  cmd: { win: 'cmd.exe', winArgs: [] },
  gitbash: { win: 'C:\\Program Files\\Git\\bin\\bash.exe', winArgs: ['-i', '-l'] }
}

function exeFor(profile: ShellProfile): { exe: string; args: string[] } {
  const isWin = process.platform === 'win32'
  if (profile === 'default') {
    if (isWin) return { exe: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', args: [] }
    return { exe: process.env.SHELL || '/bin/bash', args: ['-l'] }
  }
  const spec = PROFILE_SPECS[profile]
  if (isWin) return { exe: spec.win ?? process.env.ComSpec!, args: spec.winArgs ?? [] }
  return { exe: spec.unix ?? process.env.SHELL ?? '/bin/bash', args: spec.unixArgs ?? ['-l'] }
}

function fsExists(p: string): boolean {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

export function listProfiles(): { id: ShellProfile; label: string; available: boolean }[] {
  const out: { id: ShellProfile; label: string; available: boolean }[] = []
  for (const [id, spec] of Object.entries(PROFILE_SPECS) as [Exclude<ShellProfile, 'default'>, typeof PROFILE_SPECS['cmd']][]) {
    let available = true
    if (process.platform === 'win32' && spec.win) {
      if (spec.win.includes('\\')) available = fsExists(spec.win)
      else {
        // on PATH?
        try {
          fs.accessSync(spec.win)
          available = true
        } catch {
          available = process.env.PATH?.split(';').some((d) => fsExists(path.join(d, spec.win!))) ?? false
        }
      }
    }
    out.push({ id, label: id === 'gitbash' ? 'Git Bash' : id === 'powershell' ? 'PowerShell' : 'CMD', available })
  }
  out.push({ id: 'default', label: 'Default shell', available: true })
  return out
}

export function registerPtyIPC(mainWindow: BrowserWindow): void {
  win = mainWindow

  ipcMain.handle('pty:profiles', () => listProfiles())

  ipcMain.handle('pty:create', (_e, cols: number, rows: number, cwd?: string, profile?: ShellProfile) => {
    const pty = loadPty()
    const id = `pty-${randomUUID().slice(0, 8)}`
    const root = cwd || process.cwd()
    if (pty) {
      try {
        const { exe, args } = exeFor((profile as ShellProfile) ?? 'default')
        if (!fsExists(exe) && !exe.includes('/bin')) {
          return { id, interactive: false, error: `Shell not found: ${exe}` }
        }
        const term = pty.spawn(exe, args, {
          name: 'xterm-256color',
          cols: Math.max(2, cols | 0 || 80),
          rows: Math.max(2, rows | 0 || 24),
          cwd: root,
          env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
        })
        const p: Pty = {
          write: (d) => term.write(d),
          resize: (c, r) => term.resize(c, r),
          kill: () => { try { term.kill() } catch { /* ignore */ } },
          pid: term.pid
        }
        sessions.set(id, { id, pty: p, fallback: null, cols: cols || 80, rows: rows || 24 })
        term.onData((data: string) => win?.webContents?.send('pty:data', { id, data }))
        term.onExit(({ exitCode }: { exitCode: number }) => {
          win?.webContents?.send('pty:exit', { id, exitCode })
          sessions.delete(id)
        })
        return { id, interactive: true, error: null }
      } catch (e: any) {
        console.error('pty spawn failed:', e?.message)
        return { id, interactive: false, error: e?.message ?? 'spawn failed' }
      }
    }
    // fallback: not interactive, single commands only
    return { id, interactive: false, error: 'node-pty unavailable' }
  })

  ipcMain.handle('pty:write', (_e, id: string, data: string) => {
    sessions.get(id)?.pty?.write(data)
    return true
  })

  ipcMain.handle('pty:resize', (_e, id: string, cols: number, rows: number) => {
    sessions.get(id)?.pty?.resize(Math.max(2, cols | 0), Math.max(2, rows | 0))
    return true
  })

  ipcMain.handle('pty:kill', (_e, id: string) => {
    sessions.get(id)?.pty?.kill()
    sessions.delete(id)
    return true
  })
}

export function disposeAllPty(): void {
  for (const s of sessions.values()) {
    try { s.pty?.kill() } catch { /* ignore */ }
  }
  sessions = new Map()
}