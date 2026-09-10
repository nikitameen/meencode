// Semantic-ish search without embeddings: the fast model expands a natural
// language question into keyword/symbol queries; several keyword searches run
// and results are fused via Reciprocal Rank Fusion. Cache in SQLite.
import { searchCodebaseIndex } from './agent/codebaseIndexBridge'
import { memory, findSymbol } from './workspaceMemory'
import { proxySafeFetch } from './proxyFetch'

export interface SearchHit {
  path: string
  line: number
  text: string
  score: number
  via: string
}

interface CacheRow {
  id: number
  query: string
  expansions_json: string
  ts: number
}

let cacheDb: import('sql.js').Database | null = null
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** attach a sql.js handle (created by sessionStore's init) for query caching */
export function bindSearchCache(db: import('sql.js').Database): void {
  cacheDb = db
  db.run(`
    CREATE TABLE IF NOT EXISTS query_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT UNIQUE NOT NULL,
      expansions_json TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
  `)
}

function cacheGet(query: string): string[] | null {
  if (!cacheDb) return null
  const stmt = cacheDb.prepare('SELECT expansions_json, ts FROM query_cache WHERE query = ?')
  stmt.bind([query])
  let out: string[] | null = null
  if (stmt.step()) {
    const r = stmt.getAsObject() as Record<string, unknown>
    if (Date.now() - Number(r.ts) < CACHE_TTL_MS) {
      try { out = JSON.parse(String(r.expansions_json)) } catch { out = null }
    }
  }
  stmt.free()
  return out
}

function cachePut(query: string, expansions: string[]): void {
  if (!cacheDb) return
  cacheDb.run('INSERT OR REPLACE INTO query_cache (query, expansions_json, ts) VALUES (?, ?, ?)', [
    query, JSON.stringify(expansions), Date.now()
  ])
}

/** Ask the fast model to expand a question into search queries. Cached 24h. */
export async function expandQuery(query: string, cfg: { apiKey: string; baseUrl: string; fastModel?: string }): Promise<string[]> {
  const q = query.trim().slice(0, 300)
  if (!q) return []
  const cached = cacheGet(q)
  if (cached) return cached
  try {
    let base = cfg.baseUrl.replace(/\/+$/, '')
    if (base.endsWith('/v1/chat/completions')) base = base.slice(0, -'/chat/completions'.length)
    else if (base.endsWith('/v1')) base = base.slice(0, -'/v1'.length)
    const res = await proxySafeFetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.fastModel,
        stream: false,
        max_tokens: 120,
        temperature: 0,
        messages: [
          { role: 'system', content: 'You expand a question about a codebase into 3-5 short keyword queries (identifiers, file names, terms). Reply with ONLY the queries, one per line, lowercase, no numbering, no prose.' },
          { role: 'user', content: q }
        ]
      })
    })
    if (!res.ok) return []
    const j: any = await res.json()
    const raw = String(j.choices?.[0]?.message?.content ?? '')
    const lines = raw
      .split('\n')
      .map((l) => l.replace(/^[-*\d.\s]+/, '').trim().toLowerCase())
      .filter((l) => l.length > 1 && l.length < 80)
      .slice(0, 5)
    if (lines.length > 0) cachePut(q, lines)
    return lines
  } catch {
    return []
  }
}

/** Reciprocal Rank Fusion over several keyword searches. */
export function fuseHits(runs: SearchHit[][], limit: number): SearchHit[] {
  const K = 60
  const scores = new Map<string, { hit: SearchHit; score: number }>()
  for (const hits of runs) {
    hits.forEach((h, rank) => {
      const key = `${h.path}:${h.line}`
      const add = 1 / (K + rank + 1)
      const cur = scores.get(key)
      if (cur) cur.score += add
      else scores.set(key, { hit: h, score: add })
    })
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ hit, score }) => ({ ...hit, score: Math.round(score * 10000) / 100 }))
}

/**
 * Semantic search: expand -> multi-query keyword search + symbol lookup -> RRF.
 * Falls back to plain keyword search when no API key / expansion fails.
 */
export async function semanticSearch(
  query: string,
  cfg: { apiKey: string; baseUrl: string; fastModel?: string },
  limit = 20
): Promise<SearchHit[]> {
  if (!memory.ready) return []
  const expansions = await expandQuery(query, cfg)
  const terms = expansions.length > 0 ? expansions : [query]
  const runs: SearchHit[][] = []
  for (const t of terms) {
    const hits = searchCodebaseIndex(t, 40)
    if (hits.length > 0) runs.push(hits.map((h) => ({ ...h, via: t })))
    // symbol table hits are high-precision
    for (const sym of findSymbol(t, 5)) {
      runs.push([{ path: sym.path, line: sym.line, text: `${sym.kind} ${sym.name}`, score: 3, via: `symbol:${t}` }])
    }
  }
  if (runs.length === 0) return []
  return fuseHits(runs, limit)
}

/** expose db readiness so callers can decide about caching */
export function isCacheReady(): boolean {
  return cacheDb != null
}