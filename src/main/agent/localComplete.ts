// Local instant completion engine — zero-latency suggestions from the codebase index.
// Tier 1 (this file): immediate ghost text while typing.
// Tier 2 (cloud): richer multi-line completions on pause / Ctrl+Space.

import fs from 'node:fs'
import path from 'node:path'

interface VocabEntry { word: string; score: number; kind: 'identifier' | 'line' }

let vocab: Map<string, number> = new Map()
let lineBank: string[] = []
let vocabWorkspace: string | null = null

const IDENT_RE = /[A-Za-z_$][\w$]*/g

export function buildLocalVocab(root: string): { words: number; lines: number } {
  const IGNORED = new Set([
    'node_modules', '.git', 'dist', 'out', 'build', '.meencode', '__pycache__',
    '.venv', 'venv', '.pytest_cache', '.idea', 'target', '.next'
  ])
  const BINARY_EXT = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'zip', 'gz', 'tar', '7z', 'exe', 'dll',
    'bin', 'woff', 'woff2', 'ttf', 'otf', 'mp3', 'mp4', 'pdf', 'pyc', 'class', 'jar', 'wasm', 'node', 'lock'
  ])
  const counts = new Map<string, number>()
  const lines: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 12) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch { return }
    for (const e of entries) {
      if (IGNORED.has(e.name)) continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) { walk(abs, depth + 1); continue }
      const ext = path.extname(e.name).slice(1).toLowerCase()
      if (BINARY_EXT.has(ext)) continue
      let st: fs.Stats
      try { st = fs.statSync(abs) } catch { continue }
      if (st.size > 256 * 1024) continue
      let raw: string
      try { raw = fs.readFileSync(abs, 'utf8') } catch { continue }
      for (const m of raw.matchAll(IDENT_RE)) {
        const w = m[0]
        if (w.length < 3 || w.length > 40) continue
        if (/^\d/.test(w)) continue
        counts.set(w, (counts.get(w) ?? 0) + 1)
      }
      for (const line of raw.split('\n')) {
        const t = line.trim()
        if (t.length >= 8 && t.length <= 120 && lines.length < 30000) {
          // keep "template-ish" lines: function signatures, assignments, imports
          if (/^(import|from|const|let|var|function|class|def|return|export|if|for|while|async|await)\b/.test(t)) {
            lines.push(t)
          }
        }
      }
    }
  }
  walk(root, 0)
  vocab = counts
  lineBank = lines
  vocabWorkspace = root
  return { words: counts.size, lines: lines.length }
}

export function isVocabReady(root: string): boolean {
  return vocabWorkspace === root && vocab.size > 0
}

/**
 * Instant local suggestion.
 * prefix: text before the cursor on the current line (e.g. "const user = await getUs").
 * Returns the completion text to insert at the cursor, or ''.
 */
export function localComplete(prefix: string, language: string): string {
  const line = prefix
  if (line.length === 0) return ''

  // ---- 1) mid-word identifier completion ----
  const wordMatch = line.match(/([A-Za-z_$][\w$]*)$/)
  if (wordMatch) {
    const partial = wordMatch[1]
    const rest = line.slice(0, -partial.length)
    if (partial.length >= 2) {
      const candidate = bestWord(partial)
      if (candidate) {
        // language-aware suffixes
        if (language === 'python' && /^(def|class)\s/.test(rest)) return candidate
        return candidate
      }
    }
    // after "def " or "function " suggest from lineBank is noise — skip
  }

  // ---- 2) whole-line template completion ----
  const t = line.trim()
  if (t.length >= 3) {
    const tmpl = bestLine(t)
    if (tmpl) return '\n' + tmpl
  }
  return ''
}

function bestWord(partial: string): string | null {
  const lower = partial.toLowerCase()
  let best: { w: string; s: number } | null = null
  for (const [w, count] of vocab) {
    if (!w.toLowerCase().startsWith(lower) || w === partial) continue
    let s = Math.min(count, 50) - w.length * 0.1
    if (w.startsWith(partial)) s += 2 // exact-case prefix wins
    if (best === null || s > best.s) best = { w, s }
  }
  return best ? best.w.slice(partial.length) : null
}

function bestLine(t: string): string | null {
  const lower = t.toLowerCase()
  let best: { l: string; s: number } | null = null
  for (const l of lineBank) {
    const ll = l.toLowerCase()
    if (ll === lower) continue
    // require strong containment either way
    if (!ll.includes(lower) && !lower.includes(ll.slice(0, Math.min(ll.length, 20)))) continue
    let s = 0
    if (ll.startsWith(lower)) s += 3
    if (ll.includes(lower)) s += 2
    s += similarity(lower, ll)
    if (best === null || s > best.s) best = { l, s }
  }
  if (best && best.s >= 2.5) return best.l
  return null
}

function similarity(a: string, b: string): number {
  const setA = new Set(a.split(''))
  let hit = 0
  for (const c of b) if (setA.has(c)) hit++
  return hit / Math.max(a.length, b.length)
}