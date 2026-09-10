// Automatic workspace indexing: runs whenever workspace folders change.
// Emits 'index:event' to the renderer with progress, so the StatusBar can show it.
import { BrowserWindow } from 'electron'
import path from 'node:path'
import { getSettings } from './settingsStore'
import { indexWorkspace, memory, type MemoryStats } from './workspaceMemory'
import { setIndex } from './agent/codebaseIndexBridge'
import { buildLocalVocab } from './agent/localComplete'

let indexing = false
let lastKey = ''
let win: BrowserWindow | null = null

export function bindIndexWindow(w: BrowserWindow): void {
  win = w
}

export function isIndexing(): boolean {
  return indexing
}

/** Index all current workspace roots (no-op if unchanged and already indexed). */
export async function autoIndex(force = false): Promise<MemoryStats | null> {
  const roots = getSettings().roots
  if (roots.length === 0) return null
  const key = roots.map((r) => path.resolve(r)).join('|')
  if (!force && key === lastKey && memory.ready) return memory.stats
  if (indexing) return null // a pass is already running; the watcher will re-run on completion
  indexing = true
  emit({ phase: 'start', roots })
  try {
    const stats = await indexWorkspace(roots, (filesDone, totalFiles, rootName) => {
      emit({
        phase: 'progress',
        filesDone,
        totalFiles,
        rootName,
        pct: totalFiles > 0 ? Math.round((filesDone / totalFiles) * 100) : 0
      })
    })
    lastKey = key
    buildLocalVocab(roots[0])
    emit({ phase: 'done', stats })
    return stats
  } catch (e) {
    emit({ phase: 'error', error: e instanceof Error ? e.message : String(e) })
    return null
  } finally {
    indexing = false
  }
}

type IndexEvent =
  | { phase: 'start'; roots: string[] }
  | { phase: 'progress'; filesDone: number; totalFiles: number; rootName: string; pct: number }
  | { phase: 'done'; stats: MemoryStats }
  | { phase: 'error'; error: string }

function emit(e: IndexEvent): void {
  try {
    win?.webContents?.send('index:event', e)
  } catch { /* window gone */ }
}