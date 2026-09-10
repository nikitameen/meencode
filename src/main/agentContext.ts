// Assembles the full context bundle sent with every agent message:
// IDE state (active file, cursor, selection, tabs, diagnostics),
// git state, workspace memory, auto-retrieved relevant code, last failed command.
import fs from 'node:fs'
import path from 'node:path'
import { isRepo, stateFor, logFor } from './gitCore'
import { memory, retrieveRelevant, readRecentHistory } from './workspaceMemory'
import { isQueryableText } from './agent/codebaseIndexBridge'

export interface IDEContext {
  activeFile: string | null      // scoped path "N:rel"
  cursorLine?: number
  selection?: string            // current editor selection (truncated)
  openTabs: string[]            // scoped paths
  diagnostics?: { path: string; line: number; severity: string; message: string }[]
}

let lastFailedCommand: { command: string; output: string; ts: number } | null = null

/** Called from the toolkit whenever a run_command exits non-zero. */
export function recordFailedCommand(command: string, output: string): void {
  lastFailedCommand = { command, output: output.slice(-4000), ts: Date.now() }
}

export function buildContextBlock(ide: IDEContext, userText: string): string {
  const parts: string[] = []

  // ---- IDE state ----
  const ideLines: string[] = []
  if (ide.activeFile) ideLines.push(`Active file: ${ide.activeFile}${ide.cursorLine ? ` (cursor line ${ide.cursorLine})` : ''}`)
  if (ide.selection && ide.selection.trim()) ideLines.push(`Selected text:\n${ide.selection.slice(0, 1500)}`)
  if (ide.openTabs.length > 0) ideLines.push(`Open tabs: ${ide.openTabs.slice(0, 10).join(', ')}`)
  if (ide.diagnostics && ide.diagnostics.length > 0) {
    ideLines.push('Editor problems:')
    for (const d of ide.diagnostics.slice(0, 15)) {
      ideLines.push(`- ${d.path}:${d.line} [${d.severity}] ${d.message.slice(0, 160)}`)
    }
  }
  if (ideLines.length > 0) parts.push(`--- IDE context ---\n${ideLines.join('\n')}`)

  // ---- git ----
  const root = memory.roots[0]
  if (root && isRepo(root)) {
    void stateFor(root).then((g) => { gitCache = g }).catch(() => {})
  }
  if (gitCache) {
    const g = gitCache
    const gitLines = [`Branch: ${g.branch}`, `Changed files (${g.files.length}): ${g.files.slice(0, 15).map((f) => `${f.x}${f.y} ${f.path}`).join(', ')}`]
    if (g.ahead || g.behind) gitLines.push(`vs upstream: ${g.ahead} ahead, ${g.behind} behind`)
    parts.push(`--- Git context ---\n${gitLines.join('\n')}`)
  }
  if (root && isRepo(root)) {
    void logFor(root).then((l) => { logCache = l }).catch(() => {})
  }
  if (logCache && logCache.length > 0) {
    parts.push(`--- Recent commits ---\n${logCache.slice(0, 5).join('\n')}`)
  }

  // ---- workspace memory (structure overview) ----
  if (memory.ready && memory.stats) {
    const primary = memory.roots[0]
    try {
      const memPath = path.join(primary, '.meencode', 'memory.md')
      if (fs.existsSync(memPath)) {
        const raw = fs.readFileSync(memPath, 'utf8')
        // only the overview + symbols — keep it under 3k
        parts.push(`--- Workspace memory (auto-generated overview) ---\n${raw.slice(0, 3000)}`)
      }
    } catch { /* ignore */ }
  }

  // ---- auto-retrieval: relevant code for this message ----
  if (memory.ready && isQueryableText(userText)) {
    const hits = retrieveRelevant(userText, 10)
    if (hits.length > 0) {
      const block = hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n')
      parts.push(`--- Possibly relevant code (keyword match on your message) ---\n${block}`)
    }
  }

  // ---- persistent session history (context across restarts) ----
  const hist = readRecentHistory()
  if (hist) parts.push(`--- Recent session history (previous conversations, oldest first) ---\n${hist}`)

  // ---- last failed command ----
  if (lastFailedCommand && Date.now() - lastFailedCommand.ts < 30 * 60 * 1000) {
    parts.push(`--- Last failed command (${new Date(lastFailedCommand.ts).toLocaleTimeString()}) ---\n$ ${lastFailedCommand.command}\n${lastFailedCommand.output.slice(-2000)}`)
  }

  return parts.length > 0 ? parts.join('\n\n') : ''
}

// caches refreshed asynchronously (fire-and-forget) to keep send() fast
let gitCache: import('./gitCore').GitState | null = null
let logCache: string[] | null = null