import fs from 'node:fs'
import path from 'node:path'

export function copyIntoWorkspace(src: string, destRoot: string, opts?: { skipExisting?: boolean }): { ok: boolean; reason?: string } {
  const dest = path.join(destRoot, path.basename(src))
  if (fs.existsSync(dest)) {
    if (opts?.skipExisting !== false) return { ok: false, reason: 'exists' }
  }
  copy(src, dest)
  return { ok: true }
}

function copy(src: string, dest: string): void {
  const st = fs.statSync(src)
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true })
    for (const e of fs.readdirSync(src)) copy(path.join(src, e), path.join(dest, e))
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
  }
}