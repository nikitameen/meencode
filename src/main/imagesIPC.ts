import path from 'node:path'
import { ipcMain, dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import { requireRoot } from './ipcHelpers'
import { resizeImageToBase64 } from './imageResize'

export type ChatImage = { name: string; dataUrl: string; mime: string }

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])

function toDataUrl(abs: string): { name: string; dataUrl: string; mime: string } {
  const { dataUrl, mime } = resizeImageToBase64(abs)
  return { name: path.basename(abs), dataUrl, mime }
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