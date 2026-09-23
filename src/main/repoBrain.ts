// Repository Brain: one fused query over all four indexes.
//   1. BM25 slice hits (exact keyword/symbol strength)
//   2. Local vector similarity (paraphrase-level matches)
//   3. Symbol lookups from the request text
//   4. Dependency graph expansion (impact neighborhood of top files)
//   5. Feature tags: related tests + API routes for the top areas
// RRF-fused, budgeted, returned as compact cards — the agent gets the right
// code without exploring.
import path from 'node:path'
import fs from 'node:fs'
import { bm25Search, findSymbol, importersOf, importsOf } from './sliceStore'
import { vectorSearch } from './vectorIndex'
import { isTestPath, isApiRoutePath } from './depGraph'
import { accessPrior, requestHashOf } from './accessGraph'

export interface BrainCard {
  rel: string
  line: number
  endLine: number
  symbol: string | null
  kind: string
  body: string
  score: number
  via: Set<string>
}

export interface BrainResult {
  cards: BrainCard[]
  relatedTests: string[]
  relatedApi: string[]
  impactedBy: string[] // files importing the top hits (edit-impact)
  importsOf: string[] // files the top hits depend on
  candidateFiles: string[]
}

const RRF_K = 60
const MAX_CARDS = 12
const MAX_BODY = 2400

function identifierWords(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]{3,}/g)) {
    const w = m[0]
    const identLike = /[_\d]/.test(w) || (w.length > 4 && /[a-z][A-Z]/.test(w))
    if (identLike && !out.includes(w)) out.push(w)
    if (out.length >= 4) break
  }
  return out
}

function rootOf(roots: string[], multiRoot: boolean, rootIdx: number, rel: string): string {
  return multiRoot ? `${rootIdx}:${rel}` : rel
}

/** The brain query: `findRelevantCode(root, "add OAuth login")` → cards + maps. */
export function findRelevantCode(rootsArg: string[], query: string, opts: { expansions?: string[]; budget?: number } = {}): BrainResult {
  const roots = rootsArg.filter(Boolean).map((r) => path.resolve(r))
  const multiRoot = roots.length > 1
  const cards = new Map<string, BrainCard>()

  const addHit = (rel: string, line: number, endLine: number, symbol: string | null, kind: string, body: string, score: number, via: string, rootIdx = 0): void => {
    const display = rootOf(roots, multiRoot, rootIdx, rel)
    const key = `${display}#${line}`
    const cur = cards.get(key)
    if (cur) {
      cur.score += score
      cur.via.add(via)
    } else {
      cards.set(key, { rel: display, line, endLine, symbol, kind, body: body.slice(0, MAX_BODY), score, via: new Set([via]) })
    }
  }

  for (let i = 0; i < roots.length; i++) {
    const root = roots[i]
    // 1. BM25 (raw + expansions)
    const queries = [query, ...(opts.expansions ?? []).slice(0, 4)]
    for (const q of queries) {
      if (!q.trim()) continue
      bm25Search(root, q, 15).forEach((h, rank) => addHit(h.rel, h.line, h.endLine, h.symbol, h.kind, h.body, 1 / (RRF_K + rank + 1), 'keyword', i))
    }
    // 2. vectors (paraphrases)
    vectorSearch(root, query, 10).forEach((h, rank) => addHit(h.rel, h.line, h.endLine, h.symbol, h.kind, h.body, 1 / (RRF_K + rank + 1), 'semantic', i))
    // 3. symbols named in the request
    for (const word of identifierWords(query)) {
      findSymbol(root, word, 'prefix', 4).forEach((h, rank) => addHit(h.rel, h.line, h.endLine, h.symbol, h.kind, h.body, 1 / (RRF_K + rank + 1), 'symbol', i))
    }
  }

  // 4. behavior prior boost (files the agent touched on similar requests)
  const ws = roots[0]
  try {
    const prior = accessPrior(ws, requestHashOf(query), 8)
    const priorMax = Math.max(...prior.map((p) => p.score), 1)
    for (const c of cards.values()) {
      const pr = prior.find((p) => p.rel === c.rel.replace(/^\d+:/, ''))
      if (pr) {
        c.score *= 1 + 0.6 * (pr.score / priorMax)
        c.via.add('behavior')
      }
    }
  } catch { /* prior is best-effort */ }

  const ranked = [...cards.values()].sort((a, b) => b.score - a.score).slice(0, MAX_CARDS)

  // 5. graph + feature maps from the top areas
  const topFiles = [...new Set(ranked.map((c) => c.rel))]
  const relatedTests = new Set<string>()
  const relatedApi = new Set<string>()
  const impactedBy = new Set<string>()
  const importsOfSet = new Set<string>()
  const candidateFiles = new Set<string>()

  for (let i = 0; i < roots.length && i < 4; i++) {
    const root = roots[i]
    for (const f of topFiles.slice(0, 6)) {
      const rel = multiRoot ? f.replace(/^\d+:/, '') : f
      for (const imp of importersOf(root, rel, 10)) {
        const display = rootOf(roots, multiRoot, i, imp)
        if (isTestPath(imp)) relatedTests.add(display)
        else if (!topFiles.includes(display)) impactedBy.add(display)
      }
      for (const dep of importsOf(root, rel, 12)) {
        const display = rootOf(roots, multiRoot, i, dep)
        if (isApiRoutePath(dep)) relatedApi.add(display)
        else if (!topFiles.includes(display)) importsOfSet.add(display)
      }
    }
  }

  // candidates: test/api files that mention the query's key identifiers
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i]
    for (const word of identifierWords(query)) {
      for (const h of findSymbol(root, word, 'substring', 8)) {
        if (isTestPath(h.rel) || isApiRoutePath(h.rel)) {
          const display = rootOf(roots, multiRoot, i, h.rel)
          if (isTestPath(h.rel)) relatedTests.add(display)
          else relatedApi.add(display)
        } else {
          candidateFiles.add(rootOf(roots, multiRoot, i, h.rel))
        }
      }
    }
  }
  for (const c of [...impactedBy, ...importsOfSet].slice(0, 6)) candidateFiles.add(c)

  const exists = (rel: string): boolean => {
    try {
      const m = rel.match(/^(\d+):(.*)$/)
      const root = m ? roots[Number(m[1])] : roots[0]
      const p = m ? m[2] : rel
      return root ? fs.existsSync(path.join(root, p)) : false
    } catch { return false }
  }

  return {
    cards: ranked,
    relatedTests: [...relatedTests].filter(exists).slice(0, 5),
    relatedApi: [...relatedApi].filter(exists).slice(0, 5),
    impactedBy: [...impactedBy].filter(exists).slice(0, 6),
    importsOf: [...importsOfSet].filter(exists).slice(0, 6),
    candidateFiles: [...candidateFiles].filter((c) => !topFiles.includes(c) && exists(c)).slice(0, 8)
  }
}

/** Render a BrainResult as a compact context block for the model. */
export function brainBlock(res: BrainResult, budgetChars = 14000): string {
  if (res.cards.length === 0 && res.candidateFiles.length === 0) return ''
  const lines: string[] = ['--- Relevant code (repository brain: keyword+semantic+symbol+graph fused — CURRENT on-disk code; edit directly) ---']
  let used = lines[0].length
  let included = 0
  for (const c of res.cards) {
    const header = `\n### ${c.rel}:${c.line}-${c.endLine}${c.symbol ? ` — ${c.symbol}` : ''} (${c.kind}) [${[...c.via].join('+')}]`
    const body = c.body.length > 1600 ? c.body.slice(0, 1600) + '\n…' : c.body
    if (used + header.length + body.length + 1 > budgetChars) break
    lines.push(header + '\n' + body)
    used += header.length + body.length + 1
    included++
  }
  const maps: string[] = []
  if (res.relatedTests.length) maps.push(`Related tests: ${res.relatedTests.join(', ')}`)
  if (res.relatedApi.length) maps.push(`Related API routes: ${res.relatedApi.join(', ')}`)
  if (res.impactedBy.length) maps.push(`Importers of the files above (verify after editing): ${res.impactedBy.join(', ')}`)
  if (res.importsOf.length) maps.push(`Dependencies of the files above: ${res.importsOf.join(', ')}`)
  if (res.candidateFiles.length) maps.push(`Other possibly relevant files: ${res.candidateFiles.join(', ')}`)
  if (maps.length) {
    lines.push('\n' + maps.join('\n'))
    used += maps.join('\n').length
  }
  if (included === 0 && maps.length === 0) return ''
  return lines.join('\n')
}