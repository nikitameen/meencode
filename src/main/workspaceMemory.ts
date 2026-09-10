// Workspace memory: multi-root codebase index + persistent project memory.
// Built automatically when workspace folders are added/opened; injected into
// every agent prompt so agents understand the codebase immediately.
import fs from 'node:fs'
import path from 'node:path'
import { searchCodebaseIndex, setIndex, type IndexEntry } from './agent/codebaseIndexBridge'

export interface MemoryStats {
  roots: string[]
  files: number
  lines: number
  symbols: number
  ms: number
  memoryPath: string | null
}

export interface SymbolEntry {
  root: number
  path: string
  kind: 'function' | 'class' | 'export' | 'import' | 'def' | 'interface' | 'type'
  name: string
  line: number
}

const IGNORED = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', '.meencode', '__pycache__',
  '.venv', 'venv', '.pytest_cache', '.idea', 'target', '.next'
])
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'zip', 'gz', 'tar', '7z', 'exe', 'dll',
  'bin', 'woff', 'woff2', 'ttf', 'otf', 'mp3', 'mp4', 'pdf', 'pyc', 'class', 'jar', 'wasm', 'node', 'lock'
])

const SYMBOL_RE = [
  /\bexport\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  /\bexport\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g,
  /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  /\bexport\s+(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/g,
  /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g,
  /\bclass\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:type|interface)\s+([A-Za-z_$][\w$]*)\s*[={]/g,
  /\bdef\s+([A-Za-z_]\w*)\s*\(/g,
  /\bclass\s+([A-Za-z_]\w*)\s*[(:]/g
]

function kindFor(matched: string): SymbolEntry['kind'] {
  if (matched.includes('function')) return 'function'
  if (matched.includes('def')) return 'def'
  if (matched.includes('class')) return 'class'
  if (matched.includes('type') || matched.includes('interface') || matched.includes('enum')) return 'type'
  return 'export'
}

export const memory = {
  roots: [] as string[],
  symbols: [] as SymbolEntry[],
  ready: false,
  stats: null as MemoryStats | null
}

/** Incrementally update the index for one file (used by fs watchers). */
export function updateFile(abs: string): void {
  const scoped = relOf(abs)
  if (!scoped) return
  const rootIdx = Number(scoped.slice(0, scoped.indexOf(':')))
  const rel = scoped.slice(scoped.indexOf(':') + 1)
  try {
    // keyword entries
    const fileEntries = safeExtract(abs, path.resolve(memory.roots[rootIdx]))
    setEntriesFor(abs, fileEntries)
    // symbols: drop this file's, re-extract
    memory.symbols = memory.symbols.filter((s) => !(s.root === rootIdx && s.path === rel))
    extractSymbols(abs, path.resolve(memory.roots[rootIdx]), rootIdx)
    // keep stats fresh
    if (memory.stats) {
      memory.stats.files = new Set(entries.map((e) => e.path)).size
      memory.stats.lines = entries.length
      memory.stats.symbols = memory.symbols.length
    }
  } catch { /* unreadable */ }
}

/** Remove a file's entries from the shared keyword index (file deleted/renamed). */
export function dropFile(abs: string): void {
  setEntriesFor(abs, [])
  const scoped = relOf(abs)
  if (!scoped) return
  const rootIdx = Number(scoped.slice(0, scoped.indexOf(':')))
  const rel = scoped.slice(scoped.indexOf(':') + 1)
  memory.symbols = memory.symbols.filter((s) => !(s.root === rootIdx && s.path === rel))
}

// ---------------- multi-root indexing ----------------

let entries: IndexEntry[] = []

function relOf(abs: string): string | null {
  for (let i = 0; i < memory.roots.length; i++) {
    const root = path.resolve(memory.roots[i])
    if (abs === root || abs.startsWith(root + path.sep)) {
      return `${i}:${path.relative(root, abs).split(path.sep).join('/')}`
    }
  }
  return null
}

function extractEntries(abs: string, root: string): IndexEntry[] {
  const rel = path.relative(root, abs).split(path.sep).join('/')
  const raw = fs.readFileSync(abs, 'utf8')
  if (raw.includes('\u0000')) return []
  const out: IndexEntry[] = []
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
    if (text.trim().length < 3 || text.length > 300) continue
    out.push({ path: rel, line: i + 1, text, lower: text.toLowerCase() })
  }
  return out
}

function setEntriesFor(abs: string, newEntries: IndexEntry[]): void {
  const scoped = relOf(abs)
  if (!scoped) return
  const relRoot = scoped.slice(scoped.indexOf(':') + 1)
  entries = entries.filter((e) => e.path !== relRoot)
  entries.push(...newEntries)
  memory.ready = true
  applyIndex()
}

function applyIndex(): void {
  setIndex(entries, memory.roots.join('|') || 'workspace')
}

/**
 * Full indexing pass over every workspace root. Non-blocking: yields to the
 * event loop between files and reports progress via onProgress.
 */
export async function indexWorkspace(
  roots: string[],
  onProgress?: (filesDone: number, totalFiles: number, rootName: string) => void
): Promise<MemoryStats> {
  const t0 = Date.now()
  memory.roots = roots.filter(Boolean)
  entries = []
  memory.symbols = []

  // count files first for progress reporting
  const totalFiles = countFiles(memory.roots)
  let filesDone = 0

  for (let rootIdx = 0; rootIdx < memory.roots.length; rootIdx++) {
    const root = path.resolve(memory.roots[rootIdx])
    await walkAsync(root, async (abs) => {
      const fileEntries = safeExtract(abs, root)
      for (const e of fileEntries) entries.push(e)
      extractSymbols(abs, root, rootIdx)
      filesDone++
      if (onProgress && filesDone % 25 === 0) onProgress(filesDone, totalFiles, path.basename(root))
      // yield to the event loop so the UI never freezes
      if (filesDone % 200 === 0) await new Promise((r) => setTimeout(r, 0))
    })
  }

  memory.ready = true
  const fileSet = new Set(entries.map((e) => e.path))
  const stats: MemoryStats = {
    roots: memory.roots,
    files: fileSet.size,
    lines: entries.length,
    symbols: memory.symbols.length,
    ms: Date.now() - t0,
    memoryPath: null
  }

  applyIndex()
  stats.memoryPath = writeMemoryFile(stats)
  memory.stats = stats
  return stats
}

function safeExtract(abs: string, root: string): IndexEntry[] {
  try {
    const ext = path.extname(abs).slice(1).toLowerCase()
    if (BINARY_EXT.has(ext)) return []
    const st = fs.statSync(abs)
    if (st.size > 512 * 1024) return []
    return extractEntries(abs, root)
  } catch {
    return []
  }
}

function extractSymbols(abs: string, root: string, rootIdx: number): void {
  try {
    const ext = path.extname(abs).slice(1).toLowerCase()
    if (!['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'rb'].includes(ext)) return
    const st = fs.statSync(abs)
    if (st.size > 512 * 1024) return
    const     raw = fs.readFileSync(abs, 'utf8')
    const rel = path.relative(root, abs).split(path.sep).join('/')
    const lines = raw.split('\n')
    const seen = new Set<string>()
    let count = 0
    for (const re of SYMBOL_RE) {
      re.lastIndex = 0
      for (let i = 0; i < lines.length && count < 60; i++) {
        const m = re.exec(lines[i])
        if (!m) continue
        const kind = kindFor(m[0])
        const name = m[1] ?? ''
        const key = `${kind}:${name}`
        if (seen.has(key)) continue
        seen.add(key)
        memory.symbols.push({ root: rootIdx, path: rel, kind, name, line: i + 1 })
        count++
      }
    }
  } catch { /* ignore */ }
}

async function walkAsync(root: string, visit: (abs: string) => void | Promise<void>): Promise<void> {
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  while (stack.length) {
    const { dir, depth } = stack.pop()!
    if (depth > 12) continue
    let dirs: fs.Dirent[]
    try {
      dirs = fs.readdirSync(dir, { withFileTypes: true })
    } catch { continue }
    for (const e of dirs) {
      if (IGNORED.has(e.name) || e.name.startsWith('.DS')) continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) stack.push({ dir: abs, depth: depth + 1 })
      else await visit(abs)
    }
  }
}

function countFiles(roots: string[]): number {
  let n = 0
  const stack: { dir: string; depth: number }[] = roots.map((r) => ({ dir: path.resolve(r), depth: 0 }))
  while (stack.length && n < 100000) {
    const { dir, depth } = stack.pop()!
    if (depth > 12) continue
    let dirs: fs.Dirent[]
    try {
      dirs = fs.readdirSync(dir, { withFileTypes: true })
    } catch { continue }
    for (const e of dirs) {
      if (IGNORED.has(e.name) || e.name.startsWith('.DS')) continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) stack.push({ dir: abs, depth: depth + 1 })
      else n++
    }
  }
  return n
}

// ---------------- persistent memory file ----------------

/** Stamp used to detect stale memory (regenerated when older than this). */
const MEMORY_STALE_MS = 24 * 60 * 60 * 1000

export function isMemoryStale(): boolean {
  const primary = memory.roots[0]
  if (!primary) return false
  try {
    const p = path.join(primary, '.meencode', 'memory.md')
    if (!fs.existsSync(p)) return true
    return Date.now() - fs.statSync(p).mtimeMs > MEMORY_STALE_MS
  } catch {
    return true
  }
}

/**
 * LLM-enriched memory: ask the fast model to write a compact project
 * understanding (stack, architecture, conventions) from the file tree and
 * a sample of key files. Appends to the deterministic memory.md.
 */
export async function enrichMemoryWithLLM(cfg: { apiKey: string; baseUrl: string; fastModel?: string }): Promise<string | null> {
  const primary = memory.roots[0]
  if (!primary || !cfg.apiKey) return null
  try {
    // gather the prompt material: tree + top symbols + a few key file heads
    const overview = buildMemoryMarkdown(memory.stats ?? { roots: memory.roots, files: 0, lines: 0, symbols: 0, ms: 0, memoryPath: null })
    const keyFiles = pickKeyFiles(primary)
    const samples = keyFiles
      .map((rel) => {
        try {
          const raw = fs.readFileSync(path.join(primary, rel), 'utf8')
          return `--- ${rel} (first 60 lines) ---\n${raw.split('\n').slice(0, 60).join('\n')}`
        } catch { return '' }
      })
      .filter(Boolean)
      .slice(0, 6)
      .join('\n\n')

    const { complete, stripReasoning } = await import('./agent/quickLLM')
    const raw = await complete(
      { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.fastModel ?? '', fastModel: cfg.fastModel ?? '' } as any,
      {
        system: 'You analyze codebases and write a compact project brief for a coding agent. Reply in plain markdown, max 40 lines. No code fences, no preamble.',
        user: `Write a project brief for this workspace.\nSections: Purpose, Tech stack, Architecture (how the main parts connect), Conventions (naming/style/patterns to follow), Build & test commands (if visible in configs), Danger zones (fragile code).\nBase it ONLY on the provided material.\n\nFile overview:\n${overview.slice(0, 2500)}\n\nKey file samples:\n${samples.slice(0, 6000)}`,
        maxTokens: 1200,
        temperature: 0.2
      }
    )
    const brief = stripReasoning(raw).trim()
    if (!brief) return null

    // append under a marker so the deterministic part can be regenerated independently
    const dir = path.join(primary, '.meencode')
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'memory.md')
    let prev = ''
    try { prev = fs.readFileSync(p, 'utf8') } catch { /* fresh */ }
    const marker = '<!-- llm-brief -->'
    const base = prev.includes(marker) ? prev.slice(0, prev.indexOf(marker)).trimEnd() : prev.trimEnd()
    fs.writeFileSync(p, `${base}\n\n${marker}\n\n# Project brief (LLM-generated)\n\n${brief}\n`)
    return p
  } catch {
    return null
  }
}

/** Heuristic key files: configs, entry points, README. */
function pickKeyFiles(root: string): string[] {
  const preferred = [
    'package.json', 'README.md', 'src/main/index.ts', 'src/index.ts', 'index.ts',
    'src/main.ts', 'main.ts', 'src/app.ts', 'app.ts', 'pyproject.toml', 'Cargo.toml',
    'go.mod', 'requirements.txt', 'src/renderer/src/App.tsx'
  ]
  const out: string[] = []
  for (const rel of preferred) {
    if (out.length >= 8) break
    if (fs.existsSync(path.join(root, rel))) out.push(rel)
  }
  // add the largest few indexed source files for architecture hints
  const bySize = [...new Set(entries.map((e) => e.path))]
    .filter((p) => /\.(ts|tsx|js|py|go|rs)$/.test(p))
    .slice(0, 30)
  for (const rel of bySize) {
    if (out.length >= 8) break
    if (!out.includes(rel) && fs.existsSync(path.join(root, rel))) out.push(rel)
  }
  return out
}

/** Write .meencode/memory.md describing the workspace. Returns its path or null. */
export function writeMemoryFile(stats: MemoryStats): string | null {
  const primary = memory.roots[0]
  if (!primary) return null
  try {
    const dir = path.join(primary, '.meencode')
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'memory.md')
    fs.writeFileSync(p, buildMemoryMarkdown(stats))
    return p
  } catch {
    return null
  }
}

export function buildMemoryMarkdown(stats: MemoryStats): string {
  const lines: string[] = []
  lines.push('# Workspace memory')
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push(`Roots: ${stats.roots.map((r, i) => `${i}: ${path.basename(r)}`).join(', ')}`)
  lines.push(`Indexed: ${stats.files} files, ${stats.lines} lines, ${stats.symbols} symbols in ${stats.ms}ms`)
  lines.push('')

  // project structure (directories only, 2 levels)
  for (let i = 0; i < stats.roots.length; i++) {
    const root = path.resolve(stats.roots[i])
    lines.push(`## Folder ${i}: ${path.basename(root)}`)
    lines.push('')
    const tree = listDirTree(root, 2)
    lines.push(tree.join('\n'))
    lines.push('')
  }

  // key symbols summary
  if (memory.symbols.length > 0) {
    lines.push('## Key symbols')
    lines.push('')
    const byKind = new Map<string, number>()
    for (const s of memory.symbols) byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1)
    lines.push(`Functions/defs: ${byKind.get('function') ?? 0}, classes: ${byKind.get('class') ?? 0}, exports: ${byKind.get('export') ?? 0}, types/interfaces: ${byKind.get('type') ?? 0}`)
    lines.push('')
  }

  // notable entry points
  const entryPoints = memory.symbols.filter((s) => s.kind === 'export' || s.kind === 'class').slice(0, 40)
  if (entryPoints.length > 0) {
    lines.push('## Entry points & key exports')
    lines.push('')
    for (const s of entryPoints) {
      lines.push(`- ${s.root}:${s.path}:${s.line} ${s.kind} ${s.name}`)
    }
    lines.push('')
  }

  lines.push('## Rules for agents')
  lines.push('- This file is auto-generated project context. Do not edit manually.')
  lines.push('- Use search_codebase / grep to find specifics; this file is the overview.')
  return lines.join('\n')
}

function listDirTree(root: string, maxDepth: number): string[] {
  const out: string[] = []
  const walk = (dir: string, prefix: string, depth: number): void => {
    if (depth > maxDepth) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch { return }
    const visible = entries
      .filter((e) => !IGNORED.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
      .slice(0, 25)
    for (const e of visible) {
      out.push(`${prefix}${e.isDirectory() ? '/' : ''}${e.name}`)
      if (e.isDirectory()) walk(path.join(dir, e.name), prefix + '  ', depth + 1)
    }
  }
  walk(root, '', 0)
  return out
}

// ---------------- retrieval helpers ----------------

/** Find definitions/imports of a symbol by name across all roots. */
export function findSymbol(name: string, limit = 20): SymbolEntry[] {
  const n = name.trim()
  if (!n) return []
  const hits = memory.symbols.filter((s) => s.name === n)
  if (hits.length > 0) return hits.slice(0, limit)
  return memory.symbols.filter((s) => s.name.toLowerCase().includes(n.toLowerCase())).slice(0, limit)
}

// ---------------- persistent session history ----------------

/** Append a user/assistant exchange to .meencode/history.md (oldest trimmed, max ~60k). */
export function appendHistory(user: string, assistant: string): void {
  const primary = memory.roots[0]
  if (!primary) return
  try {
    const dir = path.join(primary, '.meencode')
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'history.md')
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16)
    const block = `## ${stamp}\n**User:** ${user.replace(/\n+/g, ' ').slice(0, 500)}\n**Agent:** ${assistant.replace(/\n+/g, ' ').slice(0, 700)}\n\n`
    let prev = ''
    try { prev = fs.readFileSync(p, 'utf8') } catch { /* first entry */ }
    fs.writeFileSync(p, (prev + block).slice(-60000))
  } catch { /* best-effort */ }
}

/** Read the last few exchanges so new sessions start with context. */
export function readRecentHistory(maxChars = 4000): string | null {
  const primary = memory.roots[0]
  if (!primary) return null
  try {
    const p = path.join(primary, '.meencode', 'history.md')
    if (!fs.existsSync(p)) return null
    const raw = fs.readFileSync(p, 'utf8').trimEnd()
    if (!raw) return null
    return raw.slice(-maxChars)
  } catch {
    return null
  }
}

/** Keyword retrieval over the merged index — the "auto-context" for each message. */
export function retrieveRelevant(query: string, limit = 12): { path: string; line: number; text: string; score: number }[] {
  if (!memory.ready || !query.trim()) return []
  const cleaned = query
    .replace(/@[\w./-]+/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .slice(0, 300)
  // strict: all terms on one line
  const strict = searchCodebaseIndex(cleaned, limit)
  if (strict.length >= 3) return strict
  // loose: any term matches, scored
  const terms = [...new Set(cleaned.toLowerCase().split(/\s+/).filter((t) => t.length > 2))]
  if (terms.length === 0) return strict
  const scored: { path: string; line: number; text: string; score: number }[] = []
  for (const e of entries) {
    let score = 0
    for (const t of terms) {
      const at = e.lower.indexOf(t)
      if (at !== -1) score += at === 0 ? 4 : 2
      if (e.path.toLowerCase().includes(t)) score += 2
    }
    if (score >= 4) scored.push({ path: e.path, line: e.line, text: e.text.trim().slice(0, 240), score })
    if (scored.length >= 300) break
  }
  scored.sort((a, b) => b.score - a.score)
  const merged = [...strict]
  for (const h of scored) {
    if (merged.length >= limit) break
    if (!merged.some((m) => m.path === h.path && m.line === h.line)) merged.push(h)
  }
  return merged
}