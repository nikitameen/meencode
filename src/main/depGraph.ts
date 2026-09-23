// Dependency graph: file-level import edges extracted at index time.
// Stored in the slice DB (sql.js) alongside symbols/terms. Answers:
//   - who imports X? (impact analysis before editing)
//   - what does X import? (follow the data)
// Pure static heuristics (regex import scans) — no LLM, instant.
import fs from 'node:fs'
import path from 'node:path'

export interface DepEdge {
  from: string // rel path of the importer
  to: string // rel path of the imported file (resolved) — empty when unresolved
  spec: string // the raw import specifier
  kind: 'import' | 'require' | 'from'
}

export function extractImports(rel: string, content: string): string[] {
  const out: string[] = []
  const push = (s: string): void => {
    const t = s.trim()
    if (t && !out.includes(t)) out.push(t)
  }
  // ES imports + TS type imports
  for (const m of content.matchAll(/import\s+(?:[\s\S]*?)\s*from\s+['"]([^'"]+)['"]/g)) push(m[1])
  for (const m of content.matchAll(/import\s+['"]([^'"]+)['"]/g)) push(m[1])
  for (const m of content.matchAll(/export\s+(?:[\s\S]*?)\s*from\s+['"]([^'"]+)['"]/g)) push(m[1])
  // CommonJS / dynamic import
  for (const m of content.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) push(m[1])
  for (const m of content.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) push(m[1])
  // Python imports (best-effort, module dotted names kept as-is)
  if (extOf(rel) === 'py') {
    for (const m of content.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)) {
      push(m[1] ?? m[2])
    }
  }
  return out.slice(0, 120) // pathological files should not flood the graph
}

function extOf(rel: string): string {
  return path.extname(rel).slice(1).toLowerCase()
}

const RESOLVE_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.json', '.css', '.vue', '.svelte', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.py']

/** Resolve an import specifier against the importing file + root.
 *  Returns the rel path of the target, or '' when it cannot be resolved
 *  (bare package names, url imports, aliases). */
export function resolveImport(root: string, fromRel: string, spec: string): string {
  if (!spec || !spec.startsWith('.')) return '' // bare (npm/pip) or alias — not a workspace edge
  const fromDir = path.dirname(path.join(root, fromRel))
  const abs = path.resolve(fromDir, spec)
  if (abs !== root && !abs.startsWith(root + path.sep)) return '' // escaped sandbox
  let rel = path.relative(root, abs).split(path.sep).join('/')
  // direct file match with extension probing
  const candidates = [rel, ...RESOLVE_EXTS.map((e) => rel + e), ...RESOLVE_EXTS.map((e) => rel + '/index' + e)]
  for (const c of candidates) {
    if (c === rel && path.extname(c) === '') continue
    try {
      if (fs.statSync(path.join(root, c)).isFile()) return c
    } catch { /* try next */ }
  }
  return ''
}

/** All edges of a file: imports resolved to workspace files when possible. */
export function fileEdges(root: string, rel: string, content: string): DepEdge[] {
  const specs = extractImports(rel, content)
  const out: DepEdge[] = []
  for (const spec of specs) {
    const to = resolveImport(root, rel, spec)
    out.push({ from: rel, to, spec, kind: 'from' })
  }
  return out
}

export function isTestPath(rel: string): boolean {
  return /(^|\/)(tests?|__tests__|spec)\//i.test(rel) || /\.(test|spec)\.[jt]sx?$/i.test(rel) || /(^|_)test_[^.\/]+\.py$/i.test(path.basename(rel)) || /(^|\/)conftest\.py$/i.test(rel)
}

export function isApiRoutePath(rel: string): boolean {
  return /(^|\/)(api|routes?|controllers?|endpoints?|handlers?)\//i.test(rel) || /(^|\/)server\.(ts|js|py)$/i.test(rel) || /@(app|router)\.(get|post|put|patch|delete)\(/i.test(rel)
}