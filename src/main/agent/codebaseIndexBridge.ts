// shared keyword index between cursorFeatures IPC and the orchestrator
import fs from 'node:fs'
import path from 'node:path'

export interface IndexEntry { path: string; line: number; text: string; lower: string }

const indexByPath = new Map<string, IndexEntry[]>()
export let indexedWorkspace: string | null = null
const MAX_TOTAL_LINES = 120000

export function setIndex(entries: IndexEntry[], workspace: string): void {
  indexByPath.clear()
  indexedWorkspace = workspace
  for (const e of entries) {
    let list = indexByPath.get(e.path)
    if (!list) { list = []; indexByPath.set(e.path, list) }
    list.push(e)
  }
}

/** Legacy flat export for consumers that still expect an array (e.g. semanticSearch fusion). */
export function getFlatIndex(): IndexEntry[] {
  return [...indexByPath.values()].flat()
}

export function getIndexedWorkspace(): string | null {
  return indexedWorkspace
}

export function updateFile(rel: string, entries: IndexEntry[]): void {
  indexByPath.set(rel, entries)
}

export function dropFile(rel: string): void {
  indexByPath.delete(rel)
}

export function searchCodebaseIndex(query: string, limit = 40): { path: string; line: number; text: string; score: number }[] {
  const q = query.toLowerCase().trim()
  if (!q || indexByPath.size === 0) return []
  const terms = q.split(/\s+/).filter(Boolean)
  const hits: { path: string; line: number; text: string; score: number }[] = []
  for (const [rel, lines] of indexByPath) {
    for (const e of lines) {
      let score = 0
      let all = true
      for (const t of terms) {
        const idx = e.lower.indexOf(t)
        if (idx === -1) { all = false; break }
        score += idx === 0 ? 3 : 1
        if (rel.toLowerCase().includes(t)) score += 2
      }
      if (all) {
        hits.push({ path: rel, line: e.line, text: e.text.trim().slice(0, 240), score })
        if (hits.length >= 400) break
      }
    }
    if (hits.length >= 400) break
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, limit)
}

/** true when the query is specific enough for retrieval (not "fix this" chatter) */
export function isQueryableText(query: string): boolean {
  const words = query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w))
  return words.length >= 2
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'this', 'that', 'with', 'what', 'when', 'how', 'why',
  'can', 'could', 'should', 'would', 'make', 'made', 'does', 'did', 'done', 'have', 'has',
  'please', 'need', 'want', 'about', 'into', 'from', 'are', 'was', 'were', 'will', 'there',
  'then', 'than', 'them', 'they', 'its', 'just', 'now', 'get', 'got', 'use', 'using', 'add',
  'fix', 'fixing', 'change', 'update', 'refactor', 'look', 'see', 'try', 'like', 'some'
])

export function indexRoot(root: string): { files: number; lines: number } {
  indexByPath.clear()
  indexedWorkspace = root
  const IGNORED = new Set([
    'node_modules', '.git', 'dist', 'out', 'build', '.meencode', '__pycache__',
    '.venv', 'venv', '.pytest_cache', '.idea', 'target', '.next'
  ])
  const BINARY_EXT = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'zip', 'gz', 'tar', '7z', 'exe', 'dll',
    'bin', 'woff', 'woff2', 'ttf', 'otf', 'mp3', 'mp4', 'pdf', 'pyc', 'class', 'jar', 'wasm', 'node', 'lock'
  ])
  const walk = (dir: string, depth: number): void => {
    if (depth > 12) return
    let dirs: fs.Dirent[]
    try {
      dirs = fs.readdirSync(dir, { withFileTypes: true })
    } catch { return }
    let totalLines = 0
    for (const e of dirs) {
      if (IGNORED.has(e.name)) continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) { walk(abs, depth + 1); continue }
      const ext = path.extname(e.name).slice(1).toLowerCase()
      if (BINARY_EXT.has(ext)) continue
      let st: fs.Stats
      try { st = fs.statSync(abs) } catch { continue }
      if (st.size > 512 * 1024) continue
      let raw: string
      try { raw = fs.readFileSync(abs, 'utf8') } catch { continue }
      if (raw.includes('\u0000')) continue
      const rel = path.relative(root, abs).split(path.sep).join('/')
      const lines = raw.split('\n')
      const entries: IndexEntry[] = []
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i]
        if (text.trim().length < 3 || text.length > 300) continue
        entries.push({ path: rel, line: i + 1, text, lower: text.toLowerCase() })
      }
      if (totalLines + entries.length > MAX_TOTAL_LINES) {
        // keep the first files fully and stop adding new files once we hit the cap
        const keep = MAX_TOTAL_LINES - totalLines
        if (keep > 0) indexByPath.set(rel, entries.slice(0, keep))
        return
      }
      indexByPath.set(rel, entries)
      totalLines += entries.length
    }
  }
  walk(root, 0)
  return { files: indexByPath.size, lines: [...indexByPath.values()].reduce((n, l) => n + l.length, 0) }
}
