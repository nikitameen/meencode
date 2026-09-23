// Local vector index: deterministic hashed-bigram embeddings per slice.
// No embedding model/API — a hashing trick (feature hashing over token
// bigrams, L2-normalized) gives a cheap-but-effective semantic-ish vector
// that matches paraphrases better than BM25 keywords alone ("make the login
// work" finds `authenticate`). Built during indexing, queried in-memory.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

const DIM = 1024 // hashed feature dimension — large enough to avoid collisions
const INDEX_VERSION = 2

export interface VecEntry {
  id: number // slice id from the slice store
  rel: string
  line: number
  endLine: number
  symbol: string | null
  kind: string
  body: string
  vec: Float32Array
}

interface RootIndex {
  entries: VecEntry[]
  byId: Map<number, VecEntry>
}

const roots = new Map<string, RootIndex>()

// ---------------- vector construction ----------------

function hash32(s: string, seed: number): number {
  const h = crypto.createHash('md5').update(`${seed}:${s}`).digest()
  return h.readUInt32LE(0)
}

const CODE_NOISE = new Set(['export', 'function', 'const', 'let', 'var', 'return', 'import', 'from', 'class', 'interface', 'type', 'async', 'await', 'def', 'public', 'private', 'static', 'void', 'boolean', 'string', 'number', 'true', 'false', 'null', 'undefined', 'new', 'this', 'self', 'require', 'module', 'default', 'extends', 'implements'])

const ENGLISH_STOP = new Set(['how', 'do', 'does', 'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'in', 'on', 'for', 'with', 'and', 'or', 'not', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'we', 'they', 'my', 'your', 'our', 'their', 'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must', 'what', 'where', 'when', 'which', 'who', 'whom', 'why', 'all', 'any', 'some', 'no', 'if', 'then', 'else', 'as', 'at', 'by', 'up', 'out', 'about', 'into', 'over', 'after', 'before', 'again', 'there', 'here'])

function weightOf(word: string): number {
  const w = word.toLowerCase()
  if (CODE_NOISE.has(w)) return 0.25
  if (ENGLISH_STOP.has(w)) return 0.25
  return 1.5
}

/** light stemming: plurals + verb suffixes so users~user, logs~log match */
function stem(w: string): string {
  let s = w
  if (s.length > 4 && s.endsWith('ies')) s = s.slice(0, -3) + 'y'
  else if (s.length > 3 && s.endsWith('es') && !s.endsWith('ses')) s = s.slice(0, -2)
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1)
  if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3)
  else if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2)
  return s
}

/** tokens for vectorization: split identifiers + words, lowercased,
 *  with code keywords and English stopwords de-weighted */
function vecTokens(text: string): { tok: string; w: number }[] {
  const out: { tok: string; w: number }[] = []
  const seen = new Set<string>()
  const push = (t: string, w: number): void => {
    if (t.length < 2) return
    const s = stem(t)
    if (seen.has(s)) return
    seen.add(s)
    out.push({ tok: s, w })
  }
  for (const m of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    const id = m[0]
    push(id.toLowerCase(), weightOf(id) * 1.4) // identifiers carry the most signal
    for (const part of id.matchAll(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g)) {
      push(part[0].toLowerCase(), weightOf(part[0]))
    }
    for (const part of id.split(/_+/)) if (part.length > 1) push(part.toLowerCase(), weightOf(part))
  }
  return out.slice(0, 500)
}

/** feature-hashed embedding: token + bigram hashing with sign trick */
export function embed(text: string): Float32Array {
  const v = new Float32Array(DIM)
  const toks = vecTokens(text)
  const add = (feat: string, weight: number): void => {
    const h = hash32(feat, 0)
    const i = h % DIM
    const sign = (hash32(feat, 1) & 1) === 0 ? 1 : -1
    v[i] += sign * weight
  }
  for (let i = 0; i < toks.length; i++) {
    add(toks[i].tok, toks[i].w)
    if (i > 0) add(`${toks[i - 1].tok}~${toks[i].tok}`, 0.5 * toks[i].w) // bigrams catch phrase shapes
  }
  // L2 normalize
  let norm = 0
  for (let i = 0; i < DIM; i++) norm += v[i] * v[i]
  norm = Math.sqrt(norm)
  if (norm > 0) for (let i = 0; i < DIM; i++) v[i] /= norm
  return v
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < DIM; i++) s += a[i] * b[i]
  return s
}

// ---------------- build (from slice-store rows) ----------------

export interface SliceRow {
  id: number
  rel: string
  line: number
  endLine: number
  symbol: string | null
  kind: string
  body: string
}

/** Build the vector index for a root from slice rows (called after slice indexing). */
export function buildVectorIndex(root: string, slices: SliceRow[]): void {
  const entries: VecEntry[] = []
  const byId = new Map<number, VecEntry>()
  for (const s of slices) {
    const vec = embed(`${s.symbol ?? ''} ${s.kind} ${s.rel} ${s.body}`)
    const e: VecEntry = { id: s.id, rel: s.rel, line: s.line, endLine: s.endLine, symbol: s.symbol, kind: s.kind, body: s.body, vec }
    entries.push(e)
    byId.set(s.id, e)
  }
  roots.set(path.resolve(root), { entries, byId })
}

/** Incremental update: re-embed only changed slices. */
export function updateSliceVectors(root: string, slices: SliceRow[]): void {
  const r = roots.get(path.resolve(root))
  if (!r) return buildVectorIndex(root, slices)
  for (const s of slices) {
    const vec = embed(`${s.symbol ?? ''} ${s.kind} ${s.rel} ${s.body}`)
    const e: VecEntry = { id: s.id, rel: s.rel, line: s.line, endLine: s.endLine, symbol: s.symbol, kind: s.kind, body: s.body, vec }
    const old = r.byId.get(s.id)
    if (old) {
      const i = r.entries.indexOf(old)
      if (i >= 0) r.entries[i] = e
    } else {
      r.entries.push(e)
    }
    r.byId.set(s.id, e)
  }
}

/** Remove vectors of slices that no longer exist (file deleted/replaced). */
export function dropSliceVectors(root: string, sliceIds: number[]): void {
  const r = roots.get(path.resolve(root))
  if (!r) return
  const drop = new Set(sliceIds)
  r.entries = r.entries.filter((e) => !drop.has(e.id))
  for (const id of drop) r.byId.delete(id)
}

export interface VectorHit {
  id: number
  rel: string
  line: number
  endLine: number
  symbol: string | null
  kind: string
  body: string
  score: number
}

/** Semantic search: cosine over all slice vectors (DIM=256 — fast even for 50k slices). */
export function vectorSearch(root: string, query: string, limit = 10, minScore = 0.06): VectorHit[] {
  const r = roots.get(path.resolve(root))
  if (!r || r.entries.length === 0) return []
  const q = embed(query)
  const scored: VectorHit[] = []
  for (const e of r.entries) {
    const s = cosine(q, e.vec)
    if (s >= minScore) {
      scored.push({ id: e.id, rel: e.rel, line: e.line, endLine: e.endLine, symbol: e.symbol, kind: e.kind, body: e.body, score: Math.round(s * 1000) / 1000 })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

export function vectorIndexStats(root: string): { entries: number } {
  return { entries: roots.get(path.resolve(root))?.entries.length ?? 0 }
}