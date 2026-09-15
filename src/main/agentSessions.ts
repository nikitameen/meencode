import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentEventPayload, Settings } from '../shared/types'
import type { IDEContext } from './agentContext'
import { AgentSession } from './agent/orchestrator'
import { getSettings } from './settingsStore'
import { BrowserWindow } from 'electron'

export type SendEvent = (e: AgentEvent) => void

export interface SessionManagerIO {
  send(event: AgentEvent): void
  getSettings(): Settings
}

export class SessionManager implements SessionManagerIO {
  private sessions = new Map<string, AgentSession>()
  private win: BrowserWindow | null = null

  constructor() {}

  bindWindow(win: BrowserWindow): void {
    this.win = win
  }

  getSettings(): Settings {
    return getSettings()
  }

  send(event: AgentEvent): void {
    this.win?.webContents?.send('agent:event', event)
  }

  private make(): { id: string; session: AgentSession } {
    const id = randomUUID().slice(0, 8)
    const session = new AgentSession({
      emit: (e: AgentEventPayload) => this.send({ ...e, sessionId: id } as AgentEvent),
      getSettings: () => this.getSettings()
    })
    this.sessions.set(id, session)
    return { id, session }
  }

  ensureRoots(): void {
    const roots = getSettings().roots
    for (const session of this.sessions.values()) {
      session.setRoots(roots)
    }
  }

  getOrCreate(id?: string | null): { id: string; session: AgentSession } {
    if (id && this.sessions.has(id)) return { id, session: this.sessions.get(id)! }
    return this.make()
  }

  get(id: string): AgentSession | undefined {
    return this.sessions.get(id)
  }

  list(): string[] {
    return [...this.sessions.keys()]
  }

  delete(id: string): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    s.stop()
    this.sessions.delete(id)
    return true
  }

  reset(id: string): void {
    this.get(id)?.reset()
  }

  async sendTo(id: string | null, text: string, attachedFile?: string | null, images?: { name: string; dataUrl: string }[], ide?: IDEContext | null): Promise<string> {
    const { id: sessionId, session } = this.getOrCreate(id)
    const roots = getSettings().roots
    if (roots.length > 0 && (!session.roots.length || session.roots[0] !== roots[0])) {
      session.setRoots(roots)
    }
    void session.send(text, attachedFile, images, ide ?? null)
    return sessionId
  }

  stop(id: string): void {
    this.get(id)?.stop()
  }

  approve(id: string, approvalId: string, ok: boolean): boolean {
    return this.get(id)?.resolveApproval(approvalId, ok) ?? false
  }

  revert(id: string, path: string): boolean {
    return this.get(id)?.revert(path) ?? false
  }

  revertAll(id: string): number {
    return this.get(id)?.revertAll() ?? 0
  }

  getChanges(id: string): import('../shared/types').FileChange[] {
    return this.get(id)?.getChanges() ?? []
  }
}
