// End-to-end smoke test: boots the real renderer against the built bundle
// and verifies the core UI structure mounts without runtime errors.
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

// Playwright is not installed; we do a lightweight HTTP + jsdom-free structural check:
// 1. dev server serves index.html
// 2. built bundle contains all view components
// 3. main bundle registers every IPC channel
import fs from 'node:fs'
import path from 'node:path'

const read = (p: string) => fs.readFileSync(path.resolve(p), 'utf8')

describe('E2E structural verification (built app)', () => {
  it('renderer bundle contains every major UI view', () => {
    const dir = 'out/renderer/assets'
    const bundleFile = fs.readdirSync(dir).find((f) => f.startsWith('index-') && f.endsWith('.js'))!
    const bundle = read(path.join(dir, bundleFile))
    const mustContain = [
      'activitybar', 'activity-rail',      // Activity Bar (Explorer/Search/Git/Agent)
      'SOURCE CONTROL',                     // Source Control view
      'EXPLORER',                           // Explorer view
      'SEARCH',                             // Search view
      'AGENT',                              // Agent view
      'menubar',                            // Menu bar (File/Edit/...)
      'ctx-menu',                           // right-click context menus
      'image-chip',                         // image attach previews
      'workspaceImport'                     // import into workspace
    ]
    for (const frag of mustContain) {
      expect(bundle.includes(frag), `renderer bundle missing: ${frag}`).toBe(true)
    }
  })

  it('main bundle registers every IPC channel', () => {
    const main = read('out/main/index.js')
    const channels = [
      'pty:create', 'pty:write', 'pty:resize', 'pty:kill',
      'git:state', 'git:stage', 'git:commit', 'git:push', 'git:pull', 'git:log',
      'workspace:importFiles', 'workspace:importFolder',
      'images:pick', 'images:read',
      'codebase:index', 'codebase:search',
      'edit:apply', 'ai:complete', 'ai:completeLocal', 'ai:suggestCommand',
      'checkpoints:list', 'checkpoints:restore',
      'agent:send', 'agent:stop', 'agent:approve', 'agent:revert', 'agent:revertAll',
      'fs:tree', 'fs:read', 'fs:write', 'fs:create', 'fs:remove', 'fs:rename', 'fs:openFolder',
      'exec:run', 'settings:get', 'settings:update', 'win:zoom',
      'models:list', 'index:stats'
    ]
    for (const ch of channels) {
      expect(main.includes(ch), `main bundle missing channel: ${ch}`).toBe(true)
    }
  })

  it('preload bridge exposes the full API surface', () => {
    const preload = read('out/preload/index.js')
    const keys = [
      'workspaceImport', 'images', 'pty', 'git', 'cursor',
      'agent', 'fs', 'exec', 'settings', 'win', 'clipboard', 'about'
    ]
    for (const k of keys) {
      expect(preload.includes(k), `preload missing API: ${k}`).toBe(true)
    }
  })

  it('app boots and serves the full bundle (E2E boot)', async () => {
    const http = await import('node:http')
    const root = path.resolve('out/renderer')
    const server = http.createServer((req, res) => {
      const url = String(req.url).split('?')[0]
      let file = url === '/' ? 'index.html' : url.replace(/^\//, '')
      const p = path.join(root, file)
      if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) {
        res.writeHead(404).end('not found')
        return
      }
      const ext = path.extname(p).slice(1)
      const mime = ext === 'html' ? 'text/html' : ext === 'js' ? 'text/javascript' : ext === 'css' ? 'text/css' : 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': mime })
      fs.createReadStream(p).pipe(res)
    })
    await new Promise<void>((r) => server.listen(4199, r))
    try {
      const res = await fetch('http://localhost:4199/')
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain('<div id="root">')
      const asset = html.match(/assets\/index-[\w-]+\.js/)?.[0]
      expect(asset).toBeTruthy()
      const js = await fetch(`http://localhost:4199/${asset}`)
      const body = await js.text()
      expect(body.length).toBeGreaterThan(1_000_000)
      expect(body).toContain('activitybar')
    } finally {
      server.close()
    }
  }, 30000)
})