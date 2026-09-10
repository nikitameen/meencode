import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { getSettings } from './settingsStore'
import * as core from './gitCore'

export type { GitFileStatus, GitState } from './gitCore'

function rootOrThrow(): string {
  const root = getSettings().workspace
  if (!root) throw new Error('No workspace open')
  return root
}

export function registerGitIPC(_mainWindow: BrowserWindow): void {
  ipcMain.handle('git:state', () => core.stateFor(rootOrThrow()).catch((e) => { throw e }))
  ipcMain.handle('git:init', async () => {
    const root = rootOrThrow()
    await core.initFor(root)
    return core.stateFor(root)
  })
  ipcMain.handle('git:stage', async (_e, p: string) => {
    const root = rootOrThrow()
    await core.stageFor(root, p)
    return core.stateFor(root)
  })
  ipcMain.handle('git:unstage', async (_e, p: string) => {
    const root = rootOrThrow()
    await core.unstageFor(root, p)
    return core.stateFor(root)
  })
  ipcMain.handle('git:discard', async (_e, p: string) => {
    const root = rootOrThrow()
    await core.discardFor(root, p)
    return core.stateFor(root)
  })
  ipcMain.handle('git:commit', async (_e, message: string) => {
    const root = rootOrThrow()
    await core.commitFor(root, message)
    return core.stateFor(root)
  })
  ipcMain.handle('git:push', async () => {
    const root = rootOrThrow()
    await core.pushFor(root)
    return core.stateFor(root)
  })
  ipcMain.handle('git:pull', async () => {
    const root = rootOrThrow()
    await core.pullFor(root)
    return core.stateFor(root)
  })
  ipcMain.handle('git:addRemote', async (_e, url: string) => {
    const root = rootOrThrow()
    await core.addRemoteFor(root, url)
    return true
  })
  ipcMain.handle('git:log', () => {
    const root = rootOrThrow()
    return core.logFor(root)
  })
}