import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AgentEvent, FileNode, Settings } from '../shared/types'

export type GitFileStatus = { path: string; x: string; y: string; staged: boolean; untracked: boolean }
export type GitState = { repo: boolean; branch: string; ahead: number; behind: number; files: GitFileStatus[] }

type EventCb<T> = (payload: T) => void

const listeners: { channel: string; cb: (payload: unknown) => void; handler: (e: IpcRendererEvent, p: unknown) => void }[] = []

function subscribe<T>(channel: string, cb: EventCb<T>): () => void {
  const handler = (_e: IpcRendererEvent, p: unknown) => cb(p as T)
  listeners.push({ channel, cb: cb as (payload: unknown) => void, handler })
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximize: () => ipcRenderer.invoke('win:maximize'),
    close: () => ipcRenderer.invoke('win:close'),
    zoom: (dir: 'in' | 'out' | 'reset') => ipcRenderer.invoke('win:zoom', dir) as Promise<boolean>
  },
  about: () => ipcRenderer.invoke('app:about') as Promise<{ app: string; version: string; model: string; workspace: string | null; electron: string; node: string }>,
  clipboard: {
    read: () => ipcRenderer.invoke('clipboard:read') as Promise<string>
  },
  dev: {
    tools: () => ipcRenderer.invoke('dev:tools')
  },
  openExternal: (url: string) => ipcRenderer.invoke('open:external', url),
  settings: {
    get: () => ipcRenderer.invoke('settings:get') as Promise<Settings>,
    update: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:update', patch) as Promise<Settings>
  },
  models: {
    list: () => ipcRenderer.invoke('models:list') as Promise<{ ok: boolean; models: string[]; error: string | null }>
  },
  fs: {
    openFolder: () => ipcRenderer.invoke('fs:openFolder') as Promise<string | null>,
    tree: () => ipcRenderer.invoke('fs:tree') as Promise<FileNode[]>,
    read: (path: string) => ipcRenderer.invoke('fs:read', path) as Promise<string>,
    write: (path: string, content: string) => ipcRenderer.invoke('fs:write', path, content) as Promise<boolean>,
    create: (dir: string, name: string, type: 'file' | 'dir') => ipcRenderer.invoke('fs:create', dir, name, type) as Promise<string>,
    remove: (path: string) => ipcRenderer.invoke('fs:remove', path) as Promise<boolean>,
    rename: (path: string, newName: string) => ipcRenderer.invoke('fs:rename', path, newName) as Promise<string>,
    listFiles: () => ipcRenderer.invoke('fs:listFiles') as Promise<string[]>,
    reveal: (path: string) => ipcRenderer.invoke('fs:reveal', path) as Promise<boolean>
  },
  workspace: {
    roots: () => ipcRenderer.invoke('workspace:roots') as Promise<string[]>,
    addFolders: () => ipcRenderer.invoke('workspace:addFolders') as Promise<{ ok: boolean; added: string[]; roots?: string[] }>,
    removeRoot: (abs: string) => ipcRenderer.invoke('workspace:removeRoot', abs) as Promise<{ ok: boolean; roots: string[] }>
  },
  agent: {
    send: (text: string, attachedFile?: string | null, images?: { name: string; dataUrl: string }[]) =>
      ipcRenderer.invoke('agent:send', text, attachedFile, images) as Promise<boolean>,
    stop: () => ipcRenderer.invoke('agent:stop') as Promise<boolean>,
    approve: (id: string, ok: boolean) => ipcRenderer.invoke('agent:approve', id, ok) as Promise<boolean>,
    reset: () => ipcRenderer.invoke('agent:reset') as Promise<boolean>,
    revert: (path: string) => ipcRenderer.invoke('agent:revert', path) as Promise<boolean>,
    revertAll: () => ipcRenderer.invoke('agent:revertAll') as Promise<number>,
    onEvent: (cb: EventCb<AgentEvent>) => subscribe('agent:event', cb)
  },
  exec: {
    run: (command: string) => ipcRenderer.invoke('exec:run', command) as Promise<string>,
    onEvent: (cb: EventCb<{ kind: 'output' | 'exit'; id: string; stream?: 'stdout' | 'stderr'; data?: string; code?: number | null }>) =>
      subscribe('exec:event', cb)
  },
  fsEvents: {
    on: (cb: EventCb<{ path: string; root: string }>) => subscribe('fs:changed', cb)
  },
  workspaceImport: {
    importFiles: () => ipcRenderer.invoke('workspace:importFiles') as Promise<{ ok: boolean; added: string[]; message: string }>,
    importFolder: () => ipcRenderer.invoke('workspace:importFolder') as Promise<{ ok: boolean; added: string[]; message: string }>
  },
  images: {
    pick: () => ipcRenderer.invoke('images:pick') as Promise<{ name: string; dataUrl: string; mime: string }[]>,
    read: (rel: string) => ipcRenderer.invoke('images:read', rel) as Promise<{ name: string; dataUrl: string; mime: string }>
  },
  git: {
    state: () => ipcRenderer.invoke('git:state') as Promise<GitState>,
    init: () => ipcRenderer.invoke('git:init') as Promise<GitState>,
    stage: (p: string) => ipcRenderer.invoke('git:stage', p) as Promise<GitState>,
    unstage: (p: string) => ipcRenderer.invoke('git:unstage', p) as Promise<GitState>,
    discard: (p: string) => ipcRenderer.invoke('git:discard', p) as Promise<GitState>,
    commit: (message: string) => ipcRenderer.invoke('git:commit', message) as Promise<GitState>,
    push: () => ipcRenderer.invoke('git:push') as Promise<GitState>,
    pull: () => ipcRenderer.invoke('git:pull') as Promise<GitState>,
    addRemote: (url: string) => ipcRenderer.invoke('git:addRemote', url) as Promise<boolean>,
    log: () => ipcRenderer.invoke('git:log') as Promise<string[]>
  },
  pty: {
    profiles: () => ipcRenderer.invoke('pty:profiles') as Promise<{ id: string; label: string; available: boolean }[]>,
    create: (cols: number, rows: number, cwd?: string, profile?: string) =>
      ipcRenderer.invoke('pty:create', cols, rows, cwd, profile) as Promise<{ id: string; interactive: boolean; error: string | null }>,
    write: (id: string, data: string) => ipcRenderer.invoke('pty:write', id, data) as Promise<boolean>,
    resize: (id: string, cols: number, rows: number) => ipcRenderer.invoke('pty:resize', id, cols, rows) as Promise<boolean>,
    kill: (id: string) => ipcRenderer.invoke('pty:kill', id) as Promise<boolean>,
    onData: (cb: EventCb<{ id: string; data: string }>) => subscribe('pty:data', cb),
    onExit: (cb: EventCb<{ id: string; exitCode: number }>) => subscribe('pty:exit', cb)
  },
  cursor: {
    indexCodebase: () => ipcRenderer.invoke('codebase:index') as Promise<{ ok: boolean; files: number; lines: number }>,
    searchCodebase: (query: string, limit?: number) => ipcRenderer.invoke('codebase:search', query, limit) as Promise<{ path: string; line: number; text: string; score: number }[]>,
    applyEdit: (args: { path: string; code: string; instruction: string; language: string }) =>
      ipcRenderer.invoke('edit:apply', args) as Promise<{ code: string }>,
    completeCode: (args: { prefix: string; suffix: string; language: string; path: string }) =>
      ipcRenderer.invoke('ai:complete', args) as Promise<{ completion: string }>,
    completeLocal: (args: { prefix: string; language: string }) =>
      ipcRenderer.invoke('ai:completeLocal', args) as Promise<{ completion: string }>,
    suggestCommand: (args: { context: string; history: string[] }) =>
      ipcRenderer.invoke('ai:suggestCommand', args) as Promise<{ command: string }>,
    listCheckpoints: () => ipcRenderer.invoke('checkpoints:list') as Promise<{ run: string; files: string[]; ts: number }[]>,
    restoreCheckpoint: (run: string, relPath: string) => ipcRenderer.invoke('checkpoints:restore', run, relPath) as Promise<boolean>,
    loadRules: () => ipcRenderer.invoke('rules:load') as Promise<string>
  }
}

contextBridge.exposeInMainWorld('meencode', api)
export type MeencodeAPI = typeof api