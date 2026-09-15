import fs from 'node:fs'
import path from 'node:path'

interface CacheEntry {
  content: string
  mtimeMs: number
  size: number
  ts: number
}

class LRUCache {
  private map = new Map<string, CacheEntry>()
  private currentBytes = 0

  constructor(private maxBytes: number) {}

  get(key: string): CacheEntry | undefined {
    const e = this.map.get(key)
    if (e) {
      this.map.delete(key)
      this.map.set(key, e)
    }
    return e
  }

  set(key: string, value: CacheEntry): void {
    while (this.currentBytes + value.content.length > this.maxBytes && this.map.size > 0) {
      const first = this.map.keys().next().value
      if (first) {
        const old = this.map.get(first)!
        this.currentBytes -= old.content.length
        this.map.delete(first)
      }
    }
    const existing = this.map.get(key)
    if (existing) this.currentBytes -= existing.content.length
    this.map.delete(key)
    this.map.set(key, value)
    this.currentBytes += value.content.length
  }
}

const cache = new LRUCache(20 * 1024 * 1024) // 20 MB of truncated text

/**
 * Read a text file with a bounded budget, cached by (path, mtime, size).
 * Returns the truncated content. The original file content is not kept.
 */
export async function readFileCached(abs: string, maxChars = 8000): Promise<string> {
  const key = abs
  try {
    const st = await fs.promises.stat(abs)
    const mtimeMs = st.mtimeMs
    const size = st.size
    const cached = cache.get(key)
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      return cached.content
    }
    const raw = await fs.promises.readFile(abs, 'utf8')
    const content = raw.slice(0, maxChars) + (raw.length > maxChars ? '\n[... truncated]' : '')
    cache.set(key, { content, mtimeMs, size, ts: Date.now() })
    return content
  } catch {
    return ''
  }
}

/**
 * Synchronous version for paths that are already known to be small (memory.md).
 */
export function readFileCachedSync(abs: string, maxChars = 8000): string {
  const key = `${abs}:sync`
  try {
    const st = fs.statSync(abs)
    const mtimeMs = st.mtimeMs
    const size = st.size
    const cached = cache.get(key)
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      return cached.content
    }
    const raw = fs.readFileSync(abs, 'utf8')
    const content = raw.slice(0, maxChars) + (raw.length > maxChars ? '\n[... truncated]' : '')
    cache.set(key, { content, mtimeMs, size, ts: Date.now() })
    return content
  } catch {
    return ''
  }
}

export function invalidateFileCache(abs: string): void {
  cache.set(abs, { content: '', mtimeMs: -1, size: -1, ts: Date.now() })
}

export function cacheHitInfo(abs: string): { mtimeMs: number; size: number } | null {
  const e = cache.get(abs)
  if (!e) return null
  return { mtimeMs: e.mtimeMs, size: e.size }
}
