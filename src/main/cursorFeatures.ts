import fs from 'node:fs'
import path from 'node:path'
import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { getSettings } from './settingsStore'
import { AgentSession } from './agent/orchestrator'
import { complete, stripReasoning, extractCodeBlock } from './agent/quickLLM'
import { indexRoot, searchCodebaseIndex, getIndexedWorkspace, index as indexRef } from './agent/codebaseIndexBridge'
import { buildLocalVocab, isVocabReady, localComplete } from './agent/localComplete'

let win: BrowserWindow
let session: AgentSession

export function registerCursorIPC(mainWindow: BrowserWindow, agentSession: AgentSession): void {
  win = mainWindow
  session = agentSession

  // ---------------- @codebase index ----------------
  ipcMain.handle('codebase:index', async () => {
    const root = getSettings().workspace
    if (!root) return { ok: false, files: 0, lines: 0 }
    if (getIndexedWorkspace() === root) {
      return { ok: true, files: new Set(indexRef.map((e) => e.path)).size, lines: indexRef.length }
    }
    const r = indexRoot(root)
    buildLocalVocab(root) // tier-1 instant completion vocabulary
    return { ok: true, files: r.files, lines: r.lines }
  })

  ipcMain.handle('codebase:search', (_e, query: string, limit?: number) => {
    return searchCodebaseIndex(String(query ?? ''), Math.min(Number(limit) || 40, 100))
  })

  // ---------------- Cmd+K inline edit ----------------
  ipcMain.handle('edit:apply', async (_e, args: { path: string; code: string; instruction: string; language: string }) => {
    const settings = getSettings()
    if (!settings.apiKey) throw new Error('Add your API key in Settings first')
    const system = `You are an expert code editor. Rewrite the given code according to the instruction.
Rules:
- Return ONLY the rewritten code inside a single \`\`\` fenced block. No explanations, no prose.
- Preserve the surrounding structure and indentation style.
- Keep code that is unrelated to the instruction unchanged.
- NEVER add comments unless the instruction asks for them.`
    const user = `File: ${args.path} (language: ${args.language})

Instruction: ${args.instruction}

Code:
\`\`\`${args.language}
${args.code}
\`\`\``
    const raw = await complete(settings, { system, user, maxTokens: 4000, temperature: 0.15 })
    const block = extractCodeBlock(raw)
    const cleaned = block ?? stripReasoning(raw)
    if (!cleaned.trim()) throw new Error('The model returned an empty edit. Try a more specific instruction.')
    return { code: cleaned.replace(/\s+$/, '') }
  })

  // ---------------- Tab autocomplete ----------------
  // tier 1: instant local engine (always fires, ~0ms)
  ipcMain.handle('ai:completeLocal', (_e, args: { prefix: string; language: string }) => {
    const root = getSettings().workspace
    if (!root || !isVocabReady(root)) return { completion: '' }
    try {
      return { completion: localComplete(String(args.prefix ?? ''), String(args.language ?? 'plaintext')) }
    } catch {
      return { completion: '' }
    }
  })

  // tier 2: cloud model (pause / Ctrl+Space)
  ipcMain.handle('ai:complete', async (_e, args: { prefix: string; suffix: string; language: string; path: string }) => {
    const settings = getSettings()
    if (!settings.apiKey) return { completion: '' }
    const prefix = args.prefix.slice(-4000)
    const suffix = args.suffix.slice(1500)
    const system = `You are a code completion engine. Continue the code at <CURSOR>.
Rules:
- Return ONLY the insertion text that belongs at <CURSOR>. No explanations, no code fences, no repetition of existing code.
- Complete at most ~15 lines. Prefer finishing the current statement/block.
- If nothing useful can be inserted, return an empty string.`
    const user = `File: ${args.path} (${args.language})

${prefix}<CURSOR>${suffix}`
    try {
      const raw = await complete(settings, { system, user, maxTokens: 300, temperature: 0.1 })
      let text = stripReasoning(raw)
      // strip accidental fences
      const m = text.match(/```[a-zA-Z]*\n?([\s\S]*?)```/)
      if (m) text = m[1]
      // models sometimes echo the prefix's last line — drop if duplicated
      const lastPrefixLine = prefix.split('\n').filter(Boolean).at(-1)?.trim()
      if (lastPrefixLine && text.trim().startsWith(lastPrefixLine)) {
        text = text.trim().slice(lastPrefixLine.length)
      }
      return { completion: text.trimEnd().slice(0, 1200) }
    } catch {
      return { completion: '' }
    }
  })

  // ---------------- terminal command suggestion ----------------
  ipcMain.handle('ai:suggestCommand', async (_e, args: { context: string; history: string[] }) => {
    const settings = getSettings()
    if (!settings.apiKey) return { command: '' }
    const system = `You suggest shell commands. Given the workspace context and recent commands, suggest the single most useful next command.
Rules:
- Reply with ONLY the command — no explanation, no quotes, no code fences.
- Keep it short and safe (build/test/run/install). Max ~80 chars.
- Platform: ${process.platform}.`
    const user = `Recent commands:\n${(args.history ?? []).slice(-5).join('\n') || '(none)'}\n\nContext: ${args.context.slice(0, 300)}`
    try {
      const raw = await complete(settings, { system, user, maxTokens: 60, temperature: 0.3 })
      const cmd = stripReasoning(raw).split('\n').filter(Boolean)[0]?.trim() ?? ''
      return { command: cmd.replace(/^[`"']|[`"']$/g, '').slice(0, 120) }
    } catch {
      return { command: '' }
    }
  })

  // ---------------- checkpoints ----------------
  ipcMain.handle('checkpoints:list', () => {
    const root = getSettings().workspace
    if (!root) return []
    const cpRoot = path.join(root, '.meencode', 'checkpoints')
    if (!fs.existsSync(cpRoot)) return []
    const out: { run: string; files: string[]; ts: number }[] = []
    for (const run of fs.readdirSync(cpRoot)) {
      const runDir = path.join(cpRoot, run)
      try {
        const st = fs.statSync(runDir)
        const files = collectFiles(runDir, runDir)
        out.push({ run, files, ts: st.mtimeMs })
      } catch { /* skip */ }
    }
    return out.sort((a, b) => b.ts - a.ts)
  })

  ipcMain.handle('checkpoints:restore', (_e, run: string, relPath: string) => {
    const root = getSettings().workspace
    if (!root) throw new Error('No workspace open')
    const src = path.join(root, '.meencode', 'checkpoints', run, relPath)
    const dest = path.join(root, relPath)
    if (!fs.existsSync(src)) throw new Error('Checkpoint file not found')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
    return true
  })

  ipcMain.handle('rules:load', () => {
    const root = getSettings().workspace
    if (!root) return ''
    for (const name of ['.meencoderules', 'meencoderules.md', '.cursorrules']) {
      const p = path.join(root, name)
      if (fs.existsSync(p)) {
        return fs.readFileSync(p, 'utf8').slice(0, 8000)
      }
    }
    return ''
  })
}

function collectFiles(dir: string, runDir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) collectFiles(abs, runDir, acc)
    else acc.push(path.relative(runDir, abs).split(path.sep).join('/'))
    if (acc.length > 200) break
  }
  return acc
}