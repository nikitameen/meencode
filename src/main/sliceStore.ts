// Slice store: symbol-level content-addressed chunks of every workspace file.
// BM25 retrieval + typo-tolerant findSymbol + Merkle-style per-file incremental
// re-indexing. Standalone SQLite (sql.js) persisted to userData/slices.db.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import initSqlJs from 'sql.js'
import { app } from 'electron'
import { fileEdges } from './depGraph'
import { dropSliceVectors, updateSliceVectors, buildVectorIndex } from './vectorIndex'

export interface Slice {
  rel: string
  symbol: string | null
  kind: string // function | class | method | def | type | export | header | chunk
  line: number
  endLine: number
  signature: string
  body: string
}

export interface SliceHit extends Slice {
  id: number
  score: number
}

export interface IndexStats {
  files: number
  slices: number
  changed: number
  skipped: number
  deleted: number
  ms: number
}

let db: any = null
let dbFile = ''
let dirty = false
let sqlPromise: Promise<any> | null = null

function ensureSql(): Promise<any> {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({ locateFile: () => path.join(__dirname, '../../node_modules/sql.js/dist/sql-wasm.wasm') })
  }
  return sqlPromise
}

function rows(sql: string, params?: any[]): any[] {
  if (!db) return []
  const res = db.exec(sql, params)
  if (!res || !res[0]) return []
  const cols = res[0].columns
  return res[0].values.map((row: any[]) => Object.fromEntries(row.map((v, i) => [cols[i], v])))
}

function row1(sql: string, params?: any[]): any | null {
  const r = rows(sql, params)
  return r.length > 0 ? r[0] : null
}

function run1(sql: string, params?: any[]): void {
  if (!db) return
  db.run(sql, params)
}

export async function initSliceDb(dbPath?: string): Promise<void> {
  if (db) return
  dbFile = dbPath ?? path.join(app.getPath('userData'), 'slices.db')
  const SQL = await ensureSql()
  let buf: Uint8Array | undefined
  try {
    if (fs.existsSync(dbFile)) buf = new Uint8Array(fs.readFileSync(dbFile))
  } catch { /* corrupt -> start fresh */ }
  db = new SQL.Database(buf)
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      root TEXT NOT NULL,
      rel TEXT NOT NULL,
      hash TEXT NOT NULL,
      PRIMARY KEY (root, rel)
    );
    CREATE TABLE IF NOT EXISTS slices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      root TEXT NOT NULL,
      rel TEXT NOT NULL,
      symbol TEXT,
      kind TEXT NOT NULL,
      line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      signature TEXT NOT NULL,
      body TEXT NOT NULL,
      body_hash TEXT NOT NULL,
      len INTEGER NOT NULL,
      FOREIGN KEY(root, rel) REFERENCES files(root, rel) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_slices_file ON slices(root, rel);
    CREATE INDEX IF NOT EXISTS idx_slices_symbol ON slices(root, symbol);
    CREATE TABLE IF NOT EXISTS terms (
      root TEXT NOT NULL,
      term TEXT NOT NULL,
      slice_id INTEGER NOT NULL,
      tf INTEGER NOT NULL,
      PRIMARY KEY (root, term, slice_id)
    );
    CREATE INDEX IF NOT EXISTS idx_terms_slice ON terms(slice_id);
    CREATE TABLE IF NOT EXISTS dep_edges (
      root TEXT NOT NULL,
      from_rel TEXT NOT NULL,
      to_rel TEXT NOT NULL,
      spec TEXT NOT NULL,
      PRIMARY KEY (root, from_rel, spec)
    );
    CREATE INDEX IF NOT EXISTS idx_deps_to ON dep_edges(root, to_rel);
  `)
  dirty = false
}

export function closeSliceDb(): void {
  flushSliceDb()
  try { db?.close() } catch { /* ignore */ }
  db = null
}

export function flushSliceDb(): void {
  if (!db || !dbFile) return
  try {
    if (!dirty && fs.existsSync(dbFile)) return
    fs.mkdirSync(path.dirname(dbFile), { recursive: true })
    fs.writeFileSync(dbFile, Buffer.from(db.export() as Uint8Array))
    dirty = false
  } catch (e) {
    console.warn('failed to save slice db:', (e as Error).message)
  }
}

// ---------------- chunking ----------------

const BRACE_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'java', 'cs', 'go', 'rs',
  'c', 'h', 'cpp', 'hpp', 'cc', 'swift', 'kt', 'kts', 'scala', 'php', 'dart', 'groovy'
])
const PY_EXT = new Set(['py', 'pyi'])

const MAX_SLICE_LINES = 140
const MAX_SLICE_CHARS = 5000
const HEADER_LINES = 15
const FALLBACK_CHUNK = 50
const FALLBACK_OVERLAP = 10
const MAX_TERMS_PER_SLICE = 200

const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'switch', 'case', 'catch', 'try', 'do', 'return',
  'break', 'continue', 'new', 'delete', 'throw', 'await', 'yield', 'in', 'of', 'with'
])

const BRACE_SIGS: { re: RegExp; kind: string }[] = [
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function' },
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
  { re: /^\s*(?:export\s+)?(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/, kind: 'type' },
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/, kind: 'export' },
  { re: /^\s*(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|override\s+|async\s+|export\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/, kind: 'method' },
  { re: /^\s*(?:export\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/, kind: 'function' }
]

function matchSig(line: string): { name: string; kind: string } | null {
  for (const { re, kind } of BRACE_SIGS) {
    const m = line.match(re)
    if (m && !KEYWORDS.has(m[1])) return { name: m[1], kind }
  }
  return null
}

/** Find where a brace-block body opened on/after sigIdx closes. */
function findBraceEnd(lines: string[], sigIdx: number): number | null {
  let depth = 0
  let opened = false
  for (let i = sigIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; opened = true }
      else if (ch === '}') depth--
    }
    if (opened && depth <= 0) return i
    if (!opened && i - sigIdx > 5) return null
    if (opened && i - sigIdx > 2000) return i
  }
  return opened ? lines.length - 1 : null
}

function chunkBrace(rel: string, lines: string[]): Slice[] {
  const out: Slice[] = []
  let inBlockComment = false
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false
      continue
    }
    if (trimmed.startsWith('/*') && !trimmed.includes('*/')) { inBlockComment = true; continue }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
    const sig = matchSig(raw)
    if (!sig) continue
    const end = findBraceEnd(lines, i)
    if (end == null) {
      // declaration without a body (e.g. `export const x = 3;`) -> signature-only slice
      if (sig.kind === 'export' || sig.kind === 'type') {
        let stop = i
        while (stop < Math.min(lines.length - 1, i + 3) && !lines[stop].includes(';')) stop++
        pushSlice(out, rel, sig, i, stop, lines)
      }
      continue
    }
    pushSlice(out, rel, sig, i, end, lines)
  }
  return out
}

function chunkPython(rel: string, lines: string[]): Slice[] {
  const out: Slice[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/) ?? lines[i].match(/^\s*class\s+([A-Za-z_]\w*)/)
    if (!m) continue
    const kind = /def/.test(lines[i]) ? 'def' : 'class'
    const indent = lines[i].length - lines[i].trimStart().length
    let end = i
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]
      if (l.trim() === '') continue
      const ind = l.length - l.trimStart().length
      if (ind <= indent) break
      end = j
    }
    pushSlice(out, rel, { name: m[1], kind }, i, end, lines)
  }
  return out
}

function chunkFallback(rel: string, lines: string[]): Slice[] {
  const out: Slice[] = []
  const step = Math.max(1, FALLBACK_CHUNK - FALLBACK_OVERLAP)
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length - 1, start + FALLBACK_CHUNK - 1)
    if (end < start) break
    out.push({
      rel,
      symbol: null,
      kind: 'chunk',
      line: start + 1,
      endLine: end + 1,
      signature: lines[start].trim().slice(0, 200),
      body: lines.slice(start, end + 1).join('\n')
    })
    if (end === lines.length - 1) break
  }
  return out
}

function pushSlice(out: Slice[], rel: string, sig: { name: string; kind: string }, start: number, end: number, lines: string[]): void {
  const raw = lines.slice(start, Math.min(end + 1, start + MAX_SLICE_LINES))
  let body = raw.join('\n')
  if (end - start + 1 > MAX_SLICE_LINES) body += `\n… (truncated, ${end - start + 1} lines total)`
  if (body.length > MAX_SLICE_CHARS) body = body.slice(0, MAX_SLICE_CHARS) + '\n… (truncated)'
  out.push({
    rel,
    symbol: sig.name,
    kind: sig.kind,
    line: start + 1,
    endLine: end + 1,
    signature: lines[start].trim().slice(0, 200),
    body
  })
}

export function chunkFile(rel: string, content: string): Slice[] {
  const lines = content.split('\n')
  const ext = path.extname(rel).slice(1).toLowerCase()
  let slices: Slice[]
  if (PY_EXT.has(ext)) slices = chunkPython(rel, lines)
  else if (BRACE_EXT.has(ext)) slices = chunkBrace(rel, lines)
  else slices = chunkFallback(rel, lines)
  const firstSigLine = slices.length > 0 ? Math.min(...slices.map((s) => s.line)) : lines.length + 1
  const headerEnd = Math.min(HEADER_LINES, firstSigLine - 1)
  if (headerEnd > 0) {
    slices.unshift({
      rel,
      symbol: null,
      kind: 'header',
      line: 1,
      endLine: headerEnd,
      signature: `// ${rel}`,
      body: lines.slice(0, headerEnd).join('\n')
    })
  }
  return slices
}

// ---------------- tokenization ----------------

function tokensOf(text: string): Map<string, number> {
  const out = new Map<string, number>()
  const push = (t: string): void => {
    if (t.length >= 2 && t.length <= 40) out.set(t, (out.get(t) ?? 0) + 1)
  }
  for (const m of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    const id = m[0]
    push(id.toLowerCase())
    for (const part of id.split(/_+/)) if (part) push(part.toLowerCase())
    for (const part of id.matchAll(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g)) push(part[0].toLowerCase())
  }
  return out
}

function sliceTerms(s: Slice): Map<string, number> {
  const merged = tokensOf(`${s.body} ${s.signature} ${s.rel} ${s.symbol ?? ''}`)
  if (merged.size <= MAX_TERMS_PER_SLICE) return merged
  return new Map([...merged.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_TERMS_PER_SLICE))
}

// ---------------- indexing ----------------

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}

export function indexFileContent(root: string, rel: string, content: string): { skipped: boolean; slices: number } {
  if (!db) return { skipped: false, slices: 0 }
  const hash = sha256(content)
  const existing = row1('SELECT hash FROM files WHERE root = ? AND rel = ?', [root, rel])
  if (existing && String(existing.hash) === hash) return { skipped: true, slices: 0 }
  const slices = chunkFile(rel, content)
  const prevIds: number[] = existing
    ? rows('SELECT id FROM slices WHERE root = ? AND rel = ?', [root, rel]).map((r) => Number(r.id))
    : []
  db.run('BEGIN TRANSACTION')
  try {
    db.run('DELETE FROM terms WHERE root = ? AND slice_id IN (SELECT id FROM slices WHERE root = ? AND rel = ?)', [root, root, rel])
    db.run('DELETE FROM slices WHERE root = ? AND rel = ?', [root, rel])
    db.run('DELETE FROM files WHERE root = ? AND rel = ?', [root, rel])
    db.run('DELETE FROM dep_edges WHERE root = ? AND from_rel = ?', [root, rel])
    db.run('INSERT INTO files (root, rel, hash) VALUES (?, ?, ?)', [root, rel, hash])
    // dependency graph edges (resolved workspace imports only)
    for (const e of fileEdges(root, rel, content)) {
      if (!e.to || e.to === rel) continue
      db.run('INSERT OR REPLACE INTO dep_edges (root, from_rel, to_rel, spec) VALUES (?, ?, ?, ?)', [root, rel, e.to, e.spec])
    }
    const inserted: any[] = []
    for (const s of slices) {
      const terms = sliceTerms(s)
      let len = 0
      for (const n of terms.values()) len += n
      db.run(
        'INSERT INTO slices (root, rel, symbol, kind, line, end_line, signature, body, body_hash, len) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [root, s.rel, s.symbol, s.kind, s.line, s.endLine, s.signature, s.body, sha256(s.body), len]
      )
      const id = row1('SELECT last_insert_rowid() AS id')
      const idNum = Number(id?.id ?? 0)
      inserted.push({ id: idNum, rel: s.rel, line: s.line, endLine: s.endLine, symbol: s.symbol, kind: s.kind, body: s.body })
      for (const [term, tf] of terms) {
        db.run('INSERT OR REPLACE INTO terms (root, term, slice_id, tf) VALUES (?, ?, ?, ?)', [root, term, idNum, tf])
      }
    }
    db.run('COMMIT')
    dirty = true
    // vector index: drop stale, add fresh (best-effort, in-memory)
    try {
      dropSliceVectors(root, prevIds)
      updateSliceVectors(root, inserted)
    } catch { /* vectors are an accelerator, never a dependency */ }
    return { skipped: false, slices: slices.length }
  } catch (e) {
    try { db.run('ROLLBACK') } catch { /* ignore */ }
    throw e
  }
}

export function deleteFileFromStore(root: string, rel: string): void {
  if (!db) return
  db.run('BEGIN TRANSACTION')
  try {
    db.run('DELETE FROM terms WHERE root = ? AND slice_id IN (SELECT id FROM slices WHERE root = ? AND rel = ?)', [root, root, rel])
    db.run('DELETE FROM slices WHERE root = ? AND rel = ?', [root, rel])
    db.run('DELETE FROM files WHERE root = ? AND rel = ?', [root, rel])
    db.run('COMMIT')
    dirty = true
  } catch (e) {
    try { db.run('ROLLBACK') } catch { /* ignore */ }
  }
}

/** Purge everything indexed under a workspace root (root removed from settings). */
export function dropRoot(root: string): void {
  if (!db) return
  const absRoot = path.resolve(root)
  db.run('BEGIN TRANSACTION')
  try {
    db.run('DELETE FROM terms WHERE root = ?', [absRoot])
    db.run('DELETE FROM slices WHERE root = ?', [absRoot])
    db.run('DELETE FROM files WHERE root = ?', [absRoot])
    db.run('COMMIT')
    dirty = true
  } catch (e) {
    try { db.run('ROLLBACK') } catch { /* ignore */ }
  }
}

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', '.meencode', '__pycache__',
  '.venv', 'venv', '.pytest_cache', '.idea', 'target', '.next'
])
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'zip', 'gz', 'tar', '7z', 'exe', 'dll',
  'bin', 'woff', 'woff2', 'ttf', 'otf', 'mp3', 'mp4', 'pdf', 'pyc', 'class', 'jar', 'wasm', 'node', 'lock',
  'db', 'sqlite', 'sqlite3', 'mdb'
])

function walkFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 12) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (IGNORED_DIRS.has(e.name)) continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) { walk(abs, depth + 1); continue }
      if (!e.isFile()) continue
      const ext = path.extname(e.name).slice(1).toLowerCase()
      if (BINARY_EXT.has(ext)) continue
      try {
        const st = fs.statSync(abs)
        if (st.size > 512 * 1024) continue
      } catch { continue }
      out.push(abs)
    }
  }
  walk(root, 0)
  return out
}

export async function indexRoot(root: string, onProgress?: (done: number, total: number) => void): Promise<IndexStats> {
  const t0 = Date.now()
  const absRoot = path.resolve(root)
  const files = walkFiles(absRoot)
  let changed = 0
  let skipped = 0
  let deleted = 0
  let done = 0
  const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
  for (const abs of files) {
    const rel = path.relative(absRoot, abs).split(path.sep).join('/')
    try {
      const raw = fs.readFileSync(abs, 'utf8')
      if (raw.includes('\u0000')) { skipped++; continue }
      const res = indexFileContent(absRoot, rel, raw)
      if (res.skipped) skipped++
      else { changed++; if (db) dirty = true }
    } catch { skipped++ }
    done++
    if (onProgress) onProgress(done, files.length)
    if (done % 25 === 0) await tick()
  }
  const known = rows('SELECT rel FROM files WHERE root = ?', [absRoot]).map((r) => String(r.rel))
  const seen = new Set(files.map((abs) => path.relative(absRoot, abs).split(path.sep).join('/')))
  for (const rel of known) {
    if (!seen.has(rel)) {
      deleteFileFromStore(absRoot, rel)
      deleted++
    }
  }
  flushSliceDb()
  // rebuild the in-memory vector index for this root (brain's semantic channel)
  try { rebuildVectorsForRoot(absRoot) } catch { /* vectors are best-effort */ }
  const sliceCount = row1('SELECT COUNT(*) AS n FROM slices WHERE root = ?', [absRoot])
  return {
    files: files.length,
    slices: Number(sliceCount?.n ?? 0),
    changed,
    skipped,
    deleted,
    ms: Date.now() - t0
  }
}

// ---------------- retrieval ----------------

const K1 = 1.2
const B = 0.75

export function bm25Search(root: string, query: string, limit = 12): SliceHit[] {
  if (!db) return []
  const terms = tokensOf(query)
  if (terms.size === 0) return []
  const qs = [...terms.keys()]
  const ph = qs.map(() => '?').join(',')
  const agg = row1('SELECT COUNT(*) AS n, COALESCE(SUM(len), 0) AS total FROM slices WHERE root = ?', [root])
  const n = Number(agg?.n ?? 0)
  const avgdl = n > 0 ? Number(agg?.total ?? 0) / n : 0
  if (n === 0 || avgdl === 0) return []
  const dfs = new Map<string, number>()
  for (const r of rows(`SELECT term, COUNT(DISTINCT slice_id) AS df FROM terms WHERE root = ? AND term IN (${ph}) GROUP BY term`, [root, ...qs])) {
    dfs.set(String(r.term), Number(r.df))
  }
  if (dfs.size === 0) return []
  const scores = new Map<number, number>()
  for (const p of rows(
    `SELECT t.term, t.slice_id, t.tf, s.len AS len FROM terms t JOIN slices s ON s.id = t.slice_id
     WHERE t.root = ? AND t.term IN (${ph})`,
    [root, ...qs]
  )) {
    const df = dfs.get(String(p.term)) ?? 0
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
    const tf = Number(p.tf)
    const len = Number(p.len)
    const denom = tf + K1 * (1 - B + (B * len) / avgdl)
    const id = Number(p.slice_id)
    scores.set(id, (scores.get(id) ?? 0) + idf * ((tf * (K1 + 1)) / denom))
  }
  const top = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
  if (top.length === 0) return []
  const idPh = top.map(([id]) => id).join(',')
  const byId = new Map<number, any>()
  for (const r of rows(`SELECT * FROM slices WHERE id IN (${idPh})`)) byId.set(Number(r.id), r)
  return top
    .map(([id, score]) => {
      const s = byId.get(id)
      if (!s) return null
      return {
        id,
        rel: String(s.rel),
        symbol: s.symbol == null ? null : String(s.symbol),
        kind: String(s.kind),
        line: Number(s.line),
        endLine: Number(s.end_line),
        signature: String(s.signature),
        body: String(s.body),
        score: Math.round(score * 1000) / 1000
      } as SliceHit
    })
    .filter(Boolean) as SliceHit[]
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => '\\' + m)
}

export function findSymbol(
  root: string,
  name: string,
  mode: 'exact' | 'prefix' | 'substring' = 'prefix',
  limit = 20
): SliceHit[] {
  if (!db || !name.trim()) return []
  const esc = escapeLike(name.toLowerCase())
  const op = mode === 'exact' ? '= ?' : mode === 'prefix' ? `LIKE ? || '%' ESCAPE '\\'` : `LIKE '%' || ? || '%' ESCAPE '\\'`
  const rs = rows(
    `SELECT * FROM slices WHERE root = ? AND symbol IS NOT NULL AND lower(symbol) ${op} ORDER BY rel, line LIMIT ?`,
    mode === 'exact' ? [root, esc, limit] : [root, esc, limit]
  )
  return rs.map((s) => ({
    id: Number(s.id),
    rel: String(s.rel),
    symbol: String(s.symbol),
    kind: String(s.kind),
    line: Number(s.line),
    endLine: Number(s.end_line),
    signature: String(s.signature),
    body: String(s.body),
    score: 0
  }))
}

export function getSlicesForFile(root: string, rel: string): Slice[] {
  if (!db) return []
  return rows('SELECT * FROM slices WHERE root = ? AND rel = ? ORDER BY line', [root, rel]).map((s) => ({
    rel: String(s.rel),
    symbol: s.symbol == null ? null : String(s.symbol),
    kind: String(s.kind),
    line: Number(s.line),
    endLine: Number(s.end_line),
    signature: String(s.signature),
    body: String(s.body)
  }))
}

export function sliceStoreStats(root: string): { files: number; slices: number; terms: number } {
  if (!db) return { files: 0, slices: 0, terms: 0 }
  const f = row1('SELECT COUNT(*) AS n FROM files WHERE root = ?', [root])
  const s = row1('SELECT COUNT(*) AS n FROM slices WHERE root = ?', [root])
  const t = row1('SELECT COUNT(*) AS n FROM terms WHERE root = ?', [root])
  return { files: Number(f?.n ?? 0), slices: Number(s?.n ?? 0), terms: Number(t?.n ?? 0) }
}

// ---------------- dependency graph ----------------

/** files that import `rel` — impact analysis before an edit */
export function importersOf(root: string, rel: string, limit = 25): string[] {
  if (!db) return []
  return rows('SELECT DISTINCT from_rel AS f FROM dep_edges WHERE root = ? AND to_rel = ? LIMIT ?', [root, rel, limit])
    .map((r) => String(r.f))
}

/** files `rel` imports */
export function importsOf(root: string, rel: string, limit = 40): string[] {
  if (!db) return []
  return rows('SELECT DISTINCT to_rel AS t FROM dep_edges WHERE root = ? AND from_rel = ? LIMIT ?', [root, rel, limit])
    .map((r) => String(r.t))
}

/** rebuild the in-memory vector index for a root from current slice rows */
export function rebuildVectorsForRoot(root: string): number {
  if (!db) return 0
  const rs = rows('SELECT id, rel, line, end_line, symbol, kind, body FROM slices WHERE root = ?', [root]).map((s) => ({
    id: Number(s.id), rel: String(s.rel), line: Number(s.line), endLine: Number(s.end_line),
    symbol: s.symbol == null ? null : String(s.symbol), kind: String(s.kind), body: String(s.body)
  }))
  buildVectorIndex(root, rs)
  return rs.length
}