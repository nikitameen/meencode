import fs from 'node:fs'
import path from 'node:path'
import { readFileCached, readFileCachedSync } from './fileCache'

export interface SnapshotEntry {
  rel: string
  abs: string
  content: string
  mtimeMs: number
  size: number
}

interface Snapshot {
  root: string
  entries: Map<string, SnapshotEntry>
  tree: string
  ts: number
}

const snapshots = new Map<string, Snapshot>()

const KEY_FILES = [
  'README.md', 'readme.md',
  'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'requirements.txt',
  'tsconfig.json', 'vite.config.ts', 'webpack.config.js', 'next.config.js',
  '.cursorrules', '.meencoderules', 'meencoderules.md', 'AGENTS.md', 'CLAUDE.md'
]

const ENTRY_GLOBS = [
  'src/main/index.ts', 'src/index.ts', 'index.ts', 'src/main.ts', 'main.ts',
  'src/app.ts', 'app.ts', 'src/renderer/src/App.tsx', 'src/App.tsx',
  'src/main.py', 'main.py', 'app.py', 'src/lib.rs', 'src/main.go'
]

/** Build or refresh a lightweight in-memory snapshot of a workspace root. */
export async function buildWorkspaceSnapshot(root: string, force = false): Promise<void> {
  const existing = snapshots.get(root)
  if (existing && !force && Date.now() - existing.ts < 60_000) return
  const entries = new Map<string, SnapshotEntry>()
  const seen = new Set<string>()

  // key config / rule files
  for (const rel of KEY_FILES) {
    const abs = path.join(root, rel)
    if (!fs.existsSync(abs)) continue
    const st = fs.statSync(abs)
    const content = readFileCachedSync(abs, 8000)
    entries.set(rel, { rel, abs, content, mtimeMs: st.mtimeMs, size: st.size })
    seen.add(abs)
  }

  // a few likely entry points
  for (const rel of ENTRY_GLOBS) {
    if (entries.has(rel)) continue
    const abs = path.join(root, rel)
    if (!fs.existsSync(abs)) continue
    const st = fs.statSync(abs)
    const content = readFileCachedSync(abs, 4000)
    entries.set(rel, { rel, abs, content, mtimeMs: st.mtimeMs, size: st.size })
    seen.add(abs)
  }

  // largest few source files (architecture hints), max 5
  const bySize: { rel: string; abs: string; size: number }[] = []
  for (const { abs, rel } of walkSourceFiles(root, 2)) {
    if (seen.has(abs)) continue
    const st = fs.statSync(abs)
    bySize.push({ rel, abs, size: st.size })
  }
  bySize.sort((a, b) => b.size - a.size)
  for (const { rel, abs } of bySize.slice(0, 5)) {
    const st = fs.statSync(abs)
    const content = await readFileCached(abs, 3000)
    if (content) entries.set(rel, { rel, abs, content, mtimeMs: st.mtimeMs, size: st.size })
  }

  snapshots.set(root, { root, entries, tree: buildTree(root), ts: Date.now() })
}

export function getWorkspaceSnapshot(root: string): Snapshot | undefined {
  return snapshots.get(root)
}

export function invalidateSnapshot(root: string): void {
  snapshots.delete(root)
}

export function snapshotMarkdown(root: string): string {
  const snap = snapshots.get(root)
  if (!snap) return ''
  const parts: string[] = []
  parts.push('--- Workspace snapshot (pre-loaded context) ---')
  parts.push(snap.tree)
  for (const [rel, e] of snap.entries) {
    parts.push(`\n--- ${rel} ---\n${e.content}`)
  }
  return parts.join('\n\n')
}

function* walkSourceFiles(root: string, maxDepth: number): Generator<{ abs: string; rel: string }> {
  const IGNORED = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.meencode', '__pycache__', '.venv', 'venv', 'target', '.next'])
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  while (stack.length) {
    const { dir, depth } = stack.pop()!
    if (depth > maxDepth) continue
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (IGNORED.has(e.name) || e.name.startsWith('.')) continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) { stack.push({ dir: abs, depth: depth + 1 }); continue }
      const ext = path.extname(e.name).slice(1).toLowerCase()
      if (!['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'rb'].includes(ext)) continue
      yield { abs, rel: path.relative(root, abs).split(path.sep).join('/') }
    }
  }
}

function buildTree(root: string): string {
  const IGNORED = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.meencode', '__pycache__', '.venv', 'venv', 'target', '.next'])
  const out: string[] = []
  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > 2) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    const visible = entries
      .filter((e) => !IGNORED.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
      .slice(0, 30)
    for (const e of visible) {
      out.push(`${prefix}${e.isDirectory() ? '/' : ''}${e.name}`)
      if (e.isDirectory()) walk(path.join(dir, e.name), prefix + '  ', depth + 1)
    }
  }
  walk(root, '', 0)
  return out.join('\n')
}

export function snapshotReadFile(root: string, rel: string): SnapshotEntry | undefined {
  const snap = snapshots.get(root)
  if (!snap) return undefined
  return snap.entries.get(rel)
}

export async function refreshSnapshotEntryIfChanged(root: string, rel: string): Promise<SnapshotEntry | undefined> {
  const snap = snapshots.get(root)
  if (!snap) return undefined
  const abs = path.join(root, rel)
  if (!fs.existsSync(abs)) { snap.entries.delete(rel); return undefined }
  const st = fs.statSync(abs)
  const existing = snap.entries.get(rel)
  if (existing && existing.mtimeMs === st.mtimeMs && existing.size === st.size) return existing
  const content = await readFileCached(abs, 8000)
  if (!content) return undefined
  const entry: SnapshotEntry = { rel, abs, content, mtimeMs: st.mtimeMs, size: st.size }
  snap.entries.set(rel, entry)
  return entry
}
