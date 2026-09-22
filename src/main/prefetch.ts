// Prefetch pack: speculative context assembled BEFORE the agent's first tool call.
// Fuses three signals into one budgeted pack:
//   1. BM25 slice hits over the symbol-level workspace index (sliceStore)
//   2. Identifier lookups pulled straight from the request text (findSymbol)
//   3. The behavior prior: files the agent actually touched on similar past
//      requests (accessGraph) — the signal no other tool has
// Optional LLM query expansion (caller-supplied, cached) widens the BM25 net.
import path from 'node:path'
import fs from 'node:fs'
import { bm25Search, findSymbol, getSlicesForFile, type SliceHit } from './sliceStore'
import { accessPrior, hotFiles, requestHashOf } from './accessGraph'

export interface PrefetchOptions {
  budgetChars?: number
  /** extra queries (e.g. LLM expansions of the user's request) */
  expansions?: string[]
  maxSlices?: number
  /** rel paths already injected into this session's context — skipped */
  excludeRels?: string[]
}

interface Card {
  rootIdx: number
  rel: string // display path ("N:rel" when multi-root)
  storeRel: string
  symbol: string | null
  kind: string
  line: number
  endLine: number
  signature: string
  body: string
  score: number
  via: Set<string>
}

const RRF_K = 60
const DEFAULT_BUDGET = 12000
const DEFAULT_MAX_SLICES = 10
const MAX_EXPANSION_RUNS = 4
const MAX_SYMBOL_WORDS = 4

/** Words in the request that look like identifiers (camelCase, snake_case, digits). */
function identifierWords(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]{3,}/g)) {
    const w = m[0]
    const identLike = /[_\d]/.test(w) || (w.length > 4 && /[a-z][A-Z]/.test(w))
    if (identLike && !out.includes(w)) out.push(w)
    if (out.length >= MAX_SYMBOL_WORDS) break
  }
  return out
}

/** RRF-fuse several BM25 runs (raw text, expansions, per root) into scored cards. */
function fuseRuns(runs: { rootIdx: number; hits: SliceHit[] }[], multiRoot: boolean): Map<string, Card> {
  const cards = new Map<string, Card>()
  for (const { rootIdx, hits } of runs) {
    hits.forEach((h, rank) => {
      const rel = multiRoot ? `${rootIdx}:${h.rel}` : h.rel
      const key = `${rel}#${h.line}`
      const add = 1 / (RRF_K + rank + 1)
      const cur = cards.get(key)
      if (cur) {
        cur.score += add
        cur.via.add('index')
      } else {
        cards.set(key, {
          rootIdx,
          rel,
          storeRel: h.rel,
          symbol: h.symbol,
          kind: h.kind,
          line: h.line,
          endLine: h.endLine,
          signature: h.signature,
          body: h.body,
          score: add,
          via: new Set(['index'])
        })
      }
    })
  }
  return cards
}

/**
 * Build the prefetch pack for a user request. Returns '' when nothing
 * confident is found (caller skips injection entirely).
 */
export function buildPrefetchPack(roots: string[], text: string, opts: PrefetchOptions = {}): string {
  const cleanRoots = roots.filter(Boolean).map((r) => path.resolve(r))
  if (cleanRoots.length === 0 || !text.trim()) return ''
  const budget = Math.max(2000, opts.budgetChars ?? DEFAULT_BUDGET)
  const maxSlices = opts.maxSlices ?? DEFAULT_MAX_SLICES
  const multiRoot = cleanRoots.length > 1

  // ---- channel 1: BM25 over the slice index (raw text + expansions) ----
  const runs: { rootIdx: number; hits: SliceHit[] }[] = []
  const queries = [text, ...(opts.expansions ?? []).slice(0, MAX_EXPANSION_RUNS)]
  for (let i = 0; i < cleanRoots.length; i++) {
    for (const q of queries) {
      if (!q.trim()) continue
      runs.push({ rootIdx: i, hits: bm25Search(cleanRoots[i], q, 15) })
    }
  }

  // ---- channel 2: identifier lookups from the request text ----
  for (let i = 0; i < cleanRoots.length; i++) {
    for (const word of identifierWords(text)) {
      runs.push({ rootIdx: i, hits: findSymbol(cleanRoots[i], word, 'prefix', 4) })
    }
  }

  const cards = fuseRuns(runs, multiRoot)
  if (cards.size === 0) {
    // still fall through: the behavior prior may know this topic
  }

  // ---- channel 3: the behavior prior (agent's own history) ----
  const ws = cleanRoots[0]
  const hash = requestHashOf(text)
  const prior = accessPrior(ws, hash, 8)
  const priorScore = new Map<string, number>()
  for (const p of prior) priorScore.set(p.rel, p.score)
  const priorMax = Math.max(...[...priorScore.values(), 1]) // avoid /0
  // prior-only files get their key slices injected as cards
  const coveredFiles = new Set([...cards.values()].map((c) => c.storeRel))
  for (const p of prior) {
    if (coveredFiles.has(p.rel)) continue
    // find which root holds this file's slices
    let rootIdx = -1
    let slices: ReturnType<typeof getSlicesForFile> = []
    for (let i = 0; i < cleanRoots.length; i++) {
      const found = getSlicesForFile(cleanRoots[i], p.rel)
      if (found.length > 0) {
        rootIdx = i
        slices = found
        break
      }
    }
    if (rootIdx === -1) continue
    const norm = p.score / priorMax
    // header + up to 2 symbol slices per prior-only file
    const picked = [
      ...slices.filter((s) => s.kind === 'header'),
      ...slices.filter((s) => s.symbol != null).slice(0, 2)
    ].slice(0, 3)
    for (const s of picked) {
      const rel = multiRoot ? `${rootIdx}:${p.rel}` : p.rel
      const key = `${rel}#${s.line}`
      if (cards.has(key)) continue
      cards.set(key, {
        rootIdx,
        rel,
        storeRel: p.rel,
        symbol: s.symbol,
        kind: s.kind,
        line: s.line,
        endLine: s.endLine,
        signature: s.signature,
        body: s.body,
        score: norm * (RRF_K + 1), // fresh card: comparable to a top-1 index hit
        via: new Set(['behavior'])
      })
    }
  }
  // boost index cards for files the agent historically touched
  for (const c of cards.values()) {
    const pr = priorScore.get(c.storeRel)
    if (pr) {
      c.score *= 1 + 0.6 * (pr / priorMax)
      c.via.add('behavior')
    }
  }

  // ---- assemble under budget ----
  const excluded = new Set((opts.excludeRels ?? []).map((r) => r.replace(/^\d+:/, '')))
  const ranked = [...cards.values()]
    .filter((c) => !excluded.has(c.storeRel))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSlices)

  const lines: string[] = []
  if (ranked.length > 0) {
    lines.push('--- Relevant code (from the live workspace index — this is the CURRENT on-disk code; edit it directly with edit_file/write_file, no re-reading needed) ---')
  }

  // candidate files: everything found but not included (one cheap line each)
  const includedFiles = new Set(ranked.map((c) => c.rel))
  const candidates = new Set<string>()
  for (const c of cards.values()) {
    if (!includedFiles.has(c.rel)) candidates.add(c.rel)
    if (candidates.size >= 8) break
  }
  for (const p of hotFiles(ws, 5)) {
    if (!includedFiles.has(p.rel) && fsExistsRel(cleanRoots, p.rel)) candidates.add(p.rel)
    if (candidates.size >= 8) break
  }
  if (candidates.size > 0) {
    lines.push(`Other possibly relevant files: ${[...candidates].slice(0, 8).join(', ')}`)
  }

  let used = lines.join('\n').length
  let included = 0
  for (const c of ranked) {
    const header = `\n### ${c.rel}:${c.line}-${c.endLine}${c.symbol ? ` — ${c.symbol}` : ''} (${c.kind}) [${[...c.via].join('+')}]`
    const block = `\n${c.body}`
    if (used + header.length + block.length > budget) break
    lines.push(header + block)
    used += header.length + block.length
    included++
  }
  if (included === 0 && candidates.size === 0) return ''
  if (included === 0) {
    // candidates only: reframe without the "relevant code" header
    return `--- Files you often work with here (from your past sessions) ---\n${lines.join('\n')}`
  }
  return lines.join('\n')
}

/** does the store hold slices for rel under any root? (cheap existence check via file slice lookup) */
function fsExistsRel(roots: string[], rel: string): boolean {
  try {
    return roots.some((r) => fs.existsSync(path.resolve(r, rel)))
  } catch {
    return false
  }
}