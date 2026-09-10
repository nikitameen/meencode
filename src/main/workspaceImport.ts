import fs from 'node:fs'
import path from 'node:path'
import { ipcMain, dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import { requireRoot } from './ipcHelpers'
import { copyIntoWorkspace } from './importCore'

function rootOr(w: BrowserWindow): string | null {
  try {
    return requireRoot()
  } catch {
    return null
  }
}

export function registerWorkspaceImportIPC(win: BrowserWindow): void {
  ipcMain.handle('workspace:importFiles', async () => {
    const root = rootOr(win)
    if (!root) return { ok: false, added: [], message: 'Open a workspace folder first' }
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })
    if (r.canceled) return { ok: false, added: [], message: 'cancelled' }
    const added: string[] = []
    const skipped: string[] = []
    for (const src of r.filePaths) {
      const res = copyIntoWorkspace(src, root)
      if (res.ok) added.push(path.basename(src))
      else skipped.push(path.basename(src))
    }
    const msg = [
      added.length > 0 ? `Imported ${added.length} file(s)` : '',
      skipped.length > 0 ? `Skipped (already exist): ${skipped.join(', ')}` : ''
    ].filter(Boolean).join(' — ')
    return { ok: added.length > 0, added, message: msg || 'nothing imported' }
  })

  ipcMain.handle('workspace:importFolder', async () => {
    const root = rootOr(win)
    if (!root) return { ok: false, added: [], message: 'Open a workspace folder first' }
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return { ok: false, added: [], message: 'cancelled' }
    const src = r.filePaths[0]
    const name = path.basename(src)
    if (fs.existsSync(path.join(root, name))) {
      return { ok: false, added: [], message: `"${name}" already exists in the workspace` }
    }
    const res = copyIntoWorkspace(src, root)
    if (!res.ok) return { ok: false, added: [], message: `Import failed: ${res.reason}` }
    return { ok: true, added: [name], message: `Imported folder "${name}"` }
  })
}