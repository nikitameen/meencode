import fs from 'node:fs'
import path from 'node:path'
import { ipcMain, dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import { requireRoot } from './ipcHelpers'

export type ChatImage = { name: string; dataUrl: string; mime: string }

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])
const MAX_BYTES = 5 * 1024 * 1024

function toDataUrl(abs: string): { name: string; dataUrl: string; mime: string } {
  const ext = path.extname(abs).slice(1).toLowerCase()
  const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
  const buf = fs.readFileSync(abs)
  if (buf.length > MAX_BYTES) throw new Error(`${path.basename(abs)} is larger than 5 MB`)
  return { name: path.basename(abs), dataUrl: `data:${mime};base64,${buf.toString('base64')}`, mime }
}

function resolveIn(root: string, p: string): string {
  const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(root, p)
  if (abs !== path.resolve(root) && !abs.startsWith(path.resolve(root) + path.sep)) {
    throw new Error('Path escapes the workspace')
  }
  return abs
}

export function registerImagesIPC(win: BrowserWindow): void {
  // pick image(s) via dialog
  ipcMain.handle('images:pick', async () => {
    const root = requireRoot()
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: [...IMAGE_EXT] }]
    })
    if (r.canceled) return []
    const out: ChatImage[] = []
    for (const abs of r.filePaths) {
      try {
        out.push(toDataUrl(abs))
      } catch (e: any) {
        throw new Error(e?.message ?? 'Failed to read image')
      }
    }
    return out
  })

  // read a workspace image as data URL (used by paste from explorer, drag-drop)
  ipcMain.handle('images:read', (_e, rel: string) => {
    const root = requireRoot()
    const abs = resolveIn(root, rel)
    if (!IMAGE_EXT.has(path.extname(abs).slice(1).toLowerCase())) throw new Error('Unsupported image type')
    return toDataUrl(abs)
  })
}