import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Settings } from '../shared/types'

const DEFAULTS: Settings = {
  apiKey: '',
  baseUrl: 'https://ollama.com',
  model: 'glm-5.3-flash',
  fastModel: 'glm-5.3-flash',
  maxIterations: 30,
  autoRunCommands: false,
  workspace: null,
  roots: []
}

let settings: Settings = { ...DEFAULTS }

function file(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

function normalizeBaseUrl(url: string): string {
  return url
    .trim()
    .replace('://api.ollama.com', '://ollama.com')
    .replace(/\/+$/, '')
}

function normalizeRoots(roots: unknown): string[] {
  if (!Array.isArray(roots)) return []
  const out: string[] = []
  for (const r of roots) {
    if (typeof r !== 'string' || !r.trim()) continue
    const abs = path.resolve(r)
    if (!out.includes(abs)) out.push(abs)
  }
  return out.slice(0, 8)
}

function migrate(raw: Record<string, unknown>): Settings {
  const s: Settings = { ...DEFAULTS, ...raw } as Settings
  s.baseUrl = normalizeBaseUrl(s.baseUrl)
  if (!s.fastModel) s.fastModel = s.model
  // migrate legacy single workspace -> roots[0]
  let roots = normalizeRoots(raw.roots)
  const legacy = raw.workspace
  if (roots.length === 0 && typeof legacy === 'string' && legacy.trim()) {
    roots = [path.resolve(legacy)]
  }
  s.roots = roots
  // keep workspace as the first root for backward compat reads
  s.workspace = roots[0] ?? null
  return s
}

export function loadSettings(): Settings {
  try {
    const raw = fs.readFileSync(file(), 'utf8')
    settings = migrate(JSON.parse(raw))
  } catch {
    settings = { ...DEFAULTS }
  }
  if (process.env.OLLAMA_API_KEY && !settings.apiKey) settings.apiKey = process.env.OLLAMA_API_KEY
  return settings
}

export function getSettings(): Settings {
  return settings
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next = { ...settings, ...patch }
  next.baseUrl = normalizeBaseUrl(next.baseUrl)
  if (patch.roots !== undefined) {
    next.roots = normalizeRoots(patch.roots)
    next.workspace = next.roots[0] ?? null
  }
  settings = next
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(settings, null, 2))
  return settings
}

export function addRoots(dirs: string[]): Settings {
  const current = getSettings().roots
  const merged = normalizeRoots([...current, ...dirs])
  return updateSettings({ roots: merged })
}

export function removeRoot(abs: string): Settings {
  const next = getSettings().roots.filter((r) => path.resolve(r) !== path.resolve(abs))
  return updateSettings({ roots: next })
}

/** Resolve a scoped path "N:relative/path" to an absolute path inside roots[N]. */
export function resolveScoped(p: string): { abs: string; root: string; rel: string } {
  const roots = getSettings().roots
  if (!p || !roots.length) throw new Error('No workspace folders added')
  const m = p.match(/^(\d+):(.*)$/)
  if (!m) {
    // no scope — treat as path inside first root
    const root = path.resolve(roots[0])
    const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(root, p)
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('Path escapes the workspace sandbox')
    return { abs, root, rel: path.relative(root, abs) }
  }
  const idx = Number(m[1])
  if (idx < 0 || idx >= roots.length) throw new Error(`Unknown workspace folder #${idx}`)
  const root = path.resolve(roots[idx])
  const rel = m[2]
  const abs = rel ? path.resolve(root, rel) : root
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('Path escapes the workspace sandbox')
  return { abs, root, rel: path.relative(root, abs) }
}

/** Build a scoped path for an absolute path (finds which root owns it). */
export function toScoped(abs: string): string {
  const roots = getSettings().roots
  const norm = path.resolve(abs)
  for (let i = 0; i < roots.length; i++) {
    const root = path.resolve(roots[i])
    if (norm === root) return `${i}:`
    if (norm.startsWith(root + path.sep)) return `${i}:${path.relative(root, norm).split(path.sep).join('/')}`
  }
  throw new Error('Path is outside all workspace folders')
}