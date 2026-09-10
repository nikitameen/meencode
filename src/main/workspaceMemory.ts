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
export function indexFile(abs: string, root: string): void {
  try {
    const entries = extractEntries(abs, root)
    setEntriesFor(abs, entries)
  } catch { /* unreadable */ }
}

/** Remove a file's entries from the shared keyword index (kept in the bridge). */
export function dropFile(abs: string): void {
  const key = relOf(abs)
  if (!key) return
  setEntriesFor(abs, [])
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
  // index.js keeps entries per relative path; replacing means drop+push
  // simple approach: filter out all entries with same path then append
  const root = relOf(abs)
  if (!root) return
  const relRoot = root.includes(':') ? root.slice(root.indexOf(':') + 1) : root
  entries = entries.filter((e) => e.path !== relRoot)
  entries.push(...newEntries)
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