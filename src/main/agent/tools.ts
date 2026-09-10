import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import type { FileChange, ChangeKind } from '../../shared/types'
import type { ToolDef, ToolCall, ToolCallContext } from '../../shared/agent/types'
import { searchCodebaseIndex } from './codebaseIndexBridge'
import { recordFailedCommand } from '../agentContext'
import { semanticSearch } from '../semanticSearch'
import { getSettings } from '../settingsStore'

const IGNORED = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', '.meencode', '__pycache__',
  '.venv', 'venv', '.pytest_cache', '.idea', '.vscode', 'target', '.next'
])
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'zip', 'gz', 'tar', '7z', 'exe', 'dll',
  'bin', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'avi', 'mov', 'pdf',
  'pyc', 'class', 'jar', 'lock', 'wasm', 'node'
])

export interface ToolkitHooks {
  onFileChange(c: FileChange): void
  onOutput(id: string, chunk: string, stream: 'stdout' | 'stderr'): void
  approve(command: string): Promise<boolean>
  autoRun(): boolean
}

export class Toolkit {
  defs: ToolDef[]
  private changes = new Map<string, FileChange>()
  private checkpointed = new Set<string>()
  runId = 'run'

  constructor(public roots: string[], private hooks: ToolkitHooks) {
    this.root = roots[0] ?? ''
    this.defs = this.buildDefs()
  }

  /** primary root (kept for cwd of commands / checkpoint storage) */
  root: string

  // ---------- public helpers ----------

  getChanges(): FileChange[] {
    return [...this.changes.values()]
  }

  // ---------- tool definitions ----------

  private buildDefs(): ToolDef[] {
    return [
      {
        name: 'list_dir',
        description: 'List entries of a directory in the workspace. Use "" for the workspace root.',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'Directory path, "" = root' } }, required: ['path'] }
      },
      {
        name: 'read_file',
        description: 'Read a text file with line-range paging.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            offset: { type: 'number', description: '1-based line to start from' },
            limit: { type: 'number', description: 'Max lines to read (default 1200, max 1500)' }
          },
          required: ['path']
        }
      },
      {
        name: 'write_file',
        description: 'Create a file (full content) or fully overwrite an existing file.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content']
        }
      },
      {
        name: 'edit_file',
        description: 'Exact string replacement in a file. old_string must match file content exactly (including whitespace). If it occurs multiple times, set replace_all=true.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            old_string: { type: 'string' },
            new_string: { type: 'string' },
            replace_all: { type: 'boolean' }
          },
          required: ['path', 'old_string', 'new_string']
        }
      },
      {
        name: 'delete_file',
        description: 'Delete a file. Use sparingly.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
      },
      {
        name: 'search_files',
        description: 'Find files by glob pattern (e.g. "**/*.py", "src/**/agent*").',
        parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] }
      },
      {
        name: 'grep',
        description: 'Search file contents with a regex. Returns matches as path:line:text.',
        parameters: {
          type: 'object',
          properties: { pattern: { type: 'string' }, include: { type: 'string', description: 'Glob filter for files, e.g. "*.ts"' } },
          required: ['pattern']
        }
      },
      {
        name: 'run_command',
        description: 'Run a shell command in the workspace root (build, test, install). Streams output.',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' }, timeout_ms: { type: 'number', description: 'Default 120000, max 300000' } },
          required: ['command']
        }
      },
      {
        name: 'search_codebase',
        description: 'Semantic-ish keyword search over the pre-built workspace index. Much faster than grep for finding where a concept lives. Returns path:line: text.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Keywords to search for' }, limit: { type: 'number', description: 'Max results (default 25, max 60)' } },
          required: ['query']
        }
      }
    ]
  }

  // ---------- execution ----------

  async execute(name: string, args: any, ctx: ToolCallContext): Promise<string> {
    try {
      switch (name) {
        case 'list_dir': return await this.listDir(String(args.path ?? ''))
        case 'read_file': return await this.readFile(args.path, args.offset, args.limit)
        case 'write_file': return await this.writeFile(args.path, String(args.content ?? ''), ctx)
        case 'edit_file': return await this.editFile(args.path, args.old_string, args.new_string, !!args.replace_all, ctx)
        case 'delete_file': return await this.deleteFile(args.path, ctx)
        case 'search_files': return await this.searchFiles(args.pattern)
        case 'grep': return await this.grep(args.pattern, args.include)
        case 'run_command': return await this.runCommand(String(args.command ?? ''), args.timeout_ms, ctx)
        case 'search_codebase': {
          const r = this.searchCodebase(String(args.query ?? ''), args.limit)
          if (typeof r === 'string') return r
          return await this.semanticFallback(r.q.slice(0, 300), r.limit)
        }
        default: return `Error: unknown tool "${name}"`
      }
    } catch (e: any) {
      return `Error: ${e?.message ?? String(e)}`
    }
  }

  // ---------- path sandboxing ----------

  /** multi-root aware: tries "N:rel" scoped paths, then each root; absolute paths must fall inside a root */
  private resolve(userPath: string): string {
    const p = String(userPath ?? '')
    // scoped form "1:rel"
    const m = p.match(/^(\d+):(.*)$/)
    if (m) {
      const idx = Number(m[1])
      if (idx < 0 || idx >= this.roots.length) throw new Error(`Unknown workspace folder #${idx}. Folders: ${this.describeRoots()}`)
      const root = path.resolve(this.roots[idx])
      const abs = m[2] ? path.resolve(root, m[2]) : root
      if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`Path escapes the workspace sandbox: ${p}`)
      return abs
    }
    if (path.isAbsolute(p)) {
      for (const r of this.roots) {
        const root = path.resolve(r)
        if (p === root || p.startsWith(root + path.sep)) return path.normalize(p)
      }
      throw new Error(`Path escapes the workspace sandbox: ${p}. Workspace folders: ${this.describeRoots()}`)
    }
    // relative: try each root in order
    for (const r of this.roots) {
      const root = path.resolve(r)
      const abs = path.resolve(root, p)
      if (fs.existsSync(abs)) return abs
    }
    // not found in any root — resolve against the primary root (for writes of new files)
    const primary = path.resolve(this.root)
    const abs = path.resolve(primary, p)
    if (abs !== primary && !abs.startsWith(primary + path.sep)) {
      throw new Error(`Path escapes the workspace sandbox: ${p}`)
    }
    return abs
  }

  private describeRoots(): string {
    return this.roots.map((r, i) => `${i}=${path.basename(r) || r}`).join(', ')
  }

  private rootOf(abs: string): string {
    const norm = path.resolve(abs)
    for (const r of this.roots) {
      const root = path.resolve(r)
      if (norm === root || norm.startsWith(root + path.sep)) return root
    }
    return path.resolve(this.root)
  }

  private toPosix(abs: string): string {
    return path.relative(this.rootOf(abs), abs).split(path.sep).join('/')
  }

  // ---------- tools ----------

  private async listDir(dirPath: string): Promise<string> {
    if (dirPath === '' || dirPath === '.') {
      // workspace root: list all workspace folders
      if (this.roots.length > 1) {
        const lines = this.roots.map((r, i) => `D ${i}: (${path.basename(r) || r})`)
        return `# workspace root — ${this.roots.length} folder(s)\n` + lines.join('\n')
      }
    }
    const abs = this.resolve(dirPath)
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(abs, { withFileTypes: true })
    } catch (e: any) {
      if (e.code === 'ENOENT') return `Error: directory not found: ${dirPath}`
      throw e
    }
    const sorted = entries
      .filter((e) => !IGNORED.has(e.name))
      .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
    if (sorted.length === 0) return `Empty directory: ${dirPath}`
    const lines = sorted.slice(0, 400).map((e) => `${e.isDirectory() ? 'D ' : 'F '}${e.name}`)
    if (sorted.length > 400) lines.push(`... ${sorted.length - 400} more entries`)
    return `# ${dirPath || '.'}\n` + lines.join('\n')
  }

  private async readFile(userPath: any, offset?: number, limit?: number): Promise<string> {
    const abs = this.resolve(String(userPath ?? ''))
    let raw: string
    try {
      raw = await fs.promises.readFile(abs, 'utf8')
    } catch (e: any) {
      if (e.code === 'ENOENT') return `Error: file not found: ${userPath}`
      throw e
    }
    const lines = raw.split('\n')
    const total = raw.endsWith('\n') && lines.length > 1 ? lines.length - 1 : lines.length
    const start = Math.max(1, Number(offset) || 1)
    const lim = Math.min(Number(limit) || 1200, 1500)
    const slice = lines.slice(start - 1, start - 1 + lim)
    const end = Math.min(start + lim - 1, total)
    let out = `# ${this.toPosix(abs)} (lines ${start}-${end} of ${total})\n${slice.join('\n')}`
    if (end < total) out += `\n[... truncated, read more with offset=${end + 1}]`
    if (out.length > 200000) out = out.slice(0, 200000) + '\n[... file too large, truncated]'
    return out
  }

  private async writeFile(userPath: string, content: string, ctx: ToolCallContext): Promise<string> {
    const abs = this.resolve(userPath)
    let before: string | null = null
    try {
      before = await fs.promises.readFile(abs, 'utf8')
    } catch { /* new file */ }
    if (before === content) return `File unchanged: ${this.toPosix(abs)}`
    await this.checkpoint(abs, before)
    await fs.promises.mkdir(path.dirname(abs), { recursive: true })
    await fs.promises.writeFile(abs, content)
    const kind: ChangeKind = before == null ? 'created' : 'modified'
    this.record(abs, kind, before, content)
    return `Wrote ${this.toPosix(abs)} (${kind}, ${content.length} bytes) [${ctx.agent}]`
  }

  private async editFile(userPath: string, oldStr: string, newStr: string, replaceAll: boolean, ctx: ToolCallContext): Promise<string> {
    const abs = this.resolve(userPath)
    let raw: string
    try {
      raw = await fs.promises.readFile(abs, 'utf8')
    } catch (e: any) {
      if (e.code === 'ENOENT') return `Error: file not found: ${userPath}`
      throw e
    }
    if (!oldStr) return `Error: old_string is empty — provide exact text to replace.`
    const count = raw.split(oldStr).length - 1
    if (count === 0) {
      return `Error: old_string not found in ${this.toPosix(abs)}. Read the file again and copy the exact text (including whitespace/indentation).`
    }
    if (count > 1 && !replaceAll) {
      return `Error: old_string occurs ${count} times in ${this.toPosix(abs)}. Make it unique, or set replace_all=true.`
    }
    const next = replaceAll ? raw.split(oldStr).join(newStr) : raw.replace(oldStr, newStr)
    await this.checkpoint(abs, raw)
    await fs.promises.writeFile(abs, next)
    const kind: ChangeKind = 'modified'
    this.record(abs, kind, raw, next)
    const n = replaceAll ? count : 1
    return `Edited ${this.toPosix(abs)}: ${n} replacement${n > 1 ? 's' : ''} made [${ctx.agent}]`
  }

  private async deleteFile(userPath: string, ctx: ToolCallContext): Promise<string> {
    const abs = this.resolve(userPath)
    let before: string | null = null
    try {
      before = await fs.promises.readFile(abs, 'utf8')
    } catch { /* ignore */ }
    await this.checkpoint(abs, before)
    await fs.promises.unlink(abs).catch(() => {})
    this.record(abs, 'deleted', before, null)
    return `Deleted ${this.toPosix(abs)} [${ctx.agent}]`
  }

  private async searchFiles(pattern: string): Promise<string> {
    if (!pattern) return 'Error: pattern is required'
    const re = globToRegex(String(pattern))
    const results: string[] = []
    for await (const { rel } of this.walk()) {
      if (re.test(rel.replace(/^\.\//, ''))) {
        results.push(rel)
        if (results.length >= 500) break
      }
    }
    if (results.length === 0) return `No files match "${pattern}"`
    return `Found ${results.length} file(s):\n${results.join('\n')}`
  }

  private async grep(pattern: string, include?: string): Promise<string> {
    if (!pattern) return 'Error: pattern is required'
    let re: RegExp
    try {
      re = new RegExp(String(pattern))
    } catch {
      return `Error: invalid regex: ${pattern}`
    }
    const inc = include ? globToRegex(String(include)) : null
    const matches: string[] = []
    let scanned = 0
    for await (const { abs, rel } of this.walk()) {
      if (inc && !inc.test(rel)) continue
      const st = await statOrNull(abs)
      if (!st || !st.isFile() || st.size > 1024 * 1024) continue
      if (BINARY_EXT.has(path.extname(rel).slice(1).toLowerCase())) continue
      scanned++
      let raw: string
      try {
        raw = await fs.promises.readFile(abs, 'utf8')
      } catch { continue }
      if (raw.includes('\u0000')) continue
      let fileMatches = 0
      const lines = raw.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          const text = lines[i].length > 240 ? lines[i].slice(0, 240) + '…' : lines[i]
          matches.push(`${rel}:${i + 1}: ${text}`)
          fileMatches++
          if (matches.length >= 300 || fileMatches >= 50) break
        }
      }
      if (matches.length >= 300) break
    }
    if (matches.length === 0) return `No matches for /${pattern}/ in ${scanned} file(s).`
    return `Matches (${matches.length}, scanned ${scanned} files):\n${matches.join('\n')}`
  }

  private async runCommand(command: string, timeoutMs: any, ctx: ToolCallContext): Promise<string> {
    if (!command) return 'Error: command is required'
    if (!this.hooks.autoRun()) {
      const ok = await this.hooks.approve(command)
      if (!ok) return `Command "${command}" was not approved by the user.`
    }
    const timeout = Math.min(Number(timeoutMs) || 120000, 300000)
    const isWin = process.platform === 'win32'
    const child = spawn(isWin ? 'cmd' : 'bash', isWin ? ['/d', '/s', '/c', command] : ['-c', command], {
      cwd: this.root,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
    })
    let out = ''
    let err = ''
    let killed = false
    child.stdout?.on('data', (d: Buffer) => {
      const s = d.toString()
      out += s
      this.hooks.onOutput(ctx.callId, s, 'stdout')
    })
    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString()
      err += s
      this.hooks.onOutput(ctx.callId, s, 'stderr')
    })
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        killed = true
        child.kill()
        resolve(null)
      }, timeout)
      child.on('close', (c) => {
        clearTimeout(timer)
        resolve(c)
      })
      child.on('error', () => {
        clearTimeout(timer)
        resolve(null)
      })
    })
    const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '\n[... truncated]' : s)
    if (code !== 0) recordFailedCommand(command, `${out}\n${err}`)
    return [
      killed ? `TIMED OUT after ${timeout}ms (killed)` : `Exit code: ${code}`,
      `--- stdout ---\n${cap(out, 12000)}`,
      `--- stderr ---\n${cap(err, 8000)}`
    ].join('\n')
  }

  // ---------- change recording / checkpoints ----------

  private searchCodebase(query: string, limit?: number): string | { semantic: true; q: string; limit: number } {
    const q = query.trim()
    if (!q) return 'Error: query is required'
    const hits = searchCodebaseIndex(q, Math.min(Number(limit) || 25, 60))
    if (hits.length > 0) {
      return `Index hits (${hits.length}) for "${q}":\n${hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n')}`
    }
    // thin keyword results -> semantic expansion
    return { semantic: true, q, limit: Math.min(Number(limit) || 25, 60) }
  }

  private async semanticFallback(q: string, limit: number): Promise<string> {
    const s = getSettings()
    if (!s.apiKey) return `No index hits for "${q}". The index may be empty — fall back to grep.`
    const hits = await semanticSearch(q, { apiKey: s.apiKey, baseUrl: s.baseUrl, fastModel: s.fastModel }, limit)
    if (hits.length === 0) return `No hits (keyword or semantic) for "${q}". Fall back to grep.`
    return `Semantic search results (${hits.length}) for "${q}":\n${hits.map((h) => `${h.path}:${h.line} (via ${h.via}): ${h.text}`).join('\n')}`
  }

  private async record(abs: string, kind: ChangeKind, before: string | null, after: string | null) {
    const rel = this.toPosix(abs)
    const existing = this.changes.get(rel)
    const change: FileChange = {
      path: rel,
      kind: existing ? existing.kind : kind,
      before: existing ? existing.before : before,
      after,
      ts: Date.now()
    }
    this.changes.set(rel, change)
    this.hooks.onFileChange(change)
  }

  private async checkpoint(abs: string, before: string | null) {
    const rel = this.toPosix(abs)
    if (this.checkpointed.has(rel) || before == null) return
    this.checkpointed.add(rel)
    const cpDir = path.join(this.root, '.meencode', 'checkpoints', this.runId, path.dirname(rel))
    await fs.promises.mkdir(cpDir, { recursive: true }).catch(() => {})
    await fs.promises.writeFile(path.join(this.root, '.meencode', 'checkpoints', this.runId, rel), before).catch(() => {})
  }

  revert(relPath: string): boolean {
    const change = this.changes.get(relPath)
    if (!change) return false
    const abs = this.resolve(relPath)
    ;(async () => {
      if (change.kind === 'created') {
        await fs.promises.unlink(abs).catch(() => {})
      } else {
        await fs.promises.mkdir(path.dirname(abs), { recursive: true })
        await fs.promises.writeFile(abs, change.before ?? '')
      }
    })()
    this.changes.delete(relPath)
    return true
  }

  revertAll(): number {
    const n = this.changes.size
    for (const p of [...this.changes.keys()]) this.revert(p)
    return n
  }

  // ---------- walk (multi-root: yields "N:rel" scoped paths) ----------

  private async *walk(depthLimit = 12): AsyncGenerator<{ abs: string; rel: string }> {
    for (let rootIdx = 0; rootIdx < this.roots.length; rootIdx++) {
      const root = path.resolve(this.roots[rootIdx])
      const queue: { dir: string; rel: string; depth: number }[] = [{ dir: root, rel: '', depth: 0 }]
      while (queue.length) {
        const { dir, rel, depth } = queue.shift()!
        if (depth >= depthLimit) continue
        let entries: fs.Dirent[]
        try {
          entries = await fs.promises.readdir(dir, { withFileTypes: true })
        } catch { continue }
        for (const e of entries) {
          if (IGNORED.has(e.name) || e.name.startsWith('.DS')) continue
          const abs = path.join(dir, e.name)
          const childRel = rel ? `${rel}/${e.name}` : e.name
          if (e.isDirectory()) {
            queue.push({ dir: abs, rel: childRel, depth: depth + 1 })
          } else {
            yield { abs, rel: `${rootIdx}:${childRel}` }
          }
        }
      }
    }
  }
}

async function statOrNull(abs: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(abs)
  } catch {
    return null
  }
}

export function globToRegex(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp(`^${re}$`)
}

export { os }