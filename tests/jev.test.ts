import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// settingsStore needs electron's app.getPath — stub the module before import.
// net must exist (empty) so proxySafeFetch falls back to global fetch.
vi.mock('electron', () => ({
  app: {
    getPath: () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')),
    getAppPath: () => process.cwd()
  },
  net: {}
}))

const { updateSettings } = await import('../src/main/settingsStore')
const { Toolkit } = await import('../src/main/agent/tools')
const jev = await import('../src/main/agent/jevClient')
const { localCommandVerdict, jevDecide, jevCommandVerdict, jevNoul, jevFocusDirective, jevCompletionVerdict, jevExplorationVerdict } = jev
type JevAnswer = jev.JevAnswer

const SAFE_SETTINGS = { jevApiKey: 'sk_test', jevAutoApprove: true, jevRouting: true } as any

describe('localCommandVerdict', () => {
  it('marks read-only git commands safe', () => {
    expect(localCommandVerdict('git status')).toBe('safe')
    expect(localCommandVerdict('git log --oneline -5')).toBe('safe')
    expect(localCommandVerdict('git diff HEAD~1')).toBe('safe')
    expect(localCommandVerdict('ls -la')).toBe('safe')
    expect(localCommandVerdict('cat package.json')).toBe('safe')
  })

  it('marks destructive commands risky without any network call', () => {
    expect(localCommandVerdict('rm -rf /')).toBe('risky')
    expect(localCommandVerdict('git push --force origin main')).toBe('risky')
    expect(localCommandVerdict('git reset --hard')).toBe('risky')
    expect(localCommandVerdict('del /s /q src')).toBe('risky')
  })

  it('sends ambiguous commands to Jev (unknown)', () => {
    expect(localCommandVerdict('npm run build')).toBe('unknown')
    expect(localCommandVerdict('npm install')).toBe('unknown')
    expect(localCommandVerdict('')).toBe('risky')
  })

  it('never lets chained/piped dangerous commands through as locally safe', () => {
    // the danger regex catches these outright — even safer than "ask Jev"
    expect(localCommandVerdict('ls && rm -rf /')).toBe('risky')
    expect(localCommandVerdict('git status | sh')).toBe('risky')
    // redirection to a sensitive path is not locally classified
    expect(localCommandVerdict('cat a.txt > /etc/passwd')).toBe('unknown')
  })
})

describe('jevNoul', () => {
  it('extracts the noul probability', () => {
    const answers: Record<string, JevAnswer> = { safe: { type: 'noul', noul: 0.42 } }
    expect(jevNoul(answers, 'safe')).toBe(0.42)
    expect(jevNoul(null, 'safe')).toBeNull()
    expect(jevNoul({}, 'missing')).toBeNull()
  })
})

describe('jevDecide', () => {
  it('returns null without a key (no signal, callers must fall back)', async () => {
    const out = await jevDecide({ jevApiKey: '' } as any, 'state', {})
    expect(out).toBeNull()
  })

  it('parses the /v1/systemone response shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        code: 0,
        data: {
          result: {
            answers: { safe: { type: 'noul', noul: 0.95 } },
            usage: { input_tokens: 100, output_tokens: 10 }
          }
        }
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const out = await jevDecide(SAFE_SETTINGS, 'git status', {
      safe: { type: 'noul', instructions: 'Is it safe?' }
    })
    expect(out?.safe).toEqual({ type: 'noul', noul: 0.95 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('thejevai.com/v1/systemone')
    expect(init.headers.Authorization).toBe('Bearer sk_test')
    vi.unstubAllGlobals()
  })

  it('returns null on HTTP failure so the gate falls back to human approval', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }))
    const out = await jevDecide(SAFE_SETTINGS, 'state', {})
    expect(out).toBeNull()
    vi.unstubAllGlobals()
  })
})

describe('jevCommandVerdict thresholds', () => {
  it('auto-runs only when Jev is confidently safe', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ data: { result: { answers: { safe_to_autorun: { type: 'noul', noul: 0.93 } } } } })
    }))
    expect(await jevCommandVerdict(SAFE_SETTINGS, 'npm run build')).toBe('safe')
    vi.unstubAllGlobals()
  })

  it('asks the human when Jev is uncertain', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ data: { result: { answers: { safe_to_autorun: { type: 'noul', noul: 0.55 } } } } })
    }))
    expect(await jevCommandVerdict(SAFE_SETTINGS, 'npm run build')).toBe('unknown')
    vi.unstubAllGlobals()
  })

  it('never calls Jev for locally-obvious commands', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await jevCommandVerdict(SAFE_SETTINGS, 'git status')).toBe('safe')
    expect(await jevCommandVerdict(SAFE_SETTINGS, 'rm -rf .')).toBe('risky')
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('jevFocusDirective — Jev as coding partner', () => {
  const mk = (choice: string, ambiguity: number) => vi.fn().mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({ data: { result: { answers: {
      intent: { type: 'choice', choice, probabilities: {}, confidence: 1 },
      ambiguity: { type: 'noul', noul: ambiguity }
    } } } })
  })

  it('edit requests get a code-first directive', async () => {
    vi.stubGlobal('fetch', mk('edit', 0.2))
    const d = await jevFocusDirective(SAFE_SETTINGS, 'add a dark mode toggle')
    expect(d).toMatch(/straight to edits/i)
    vi.unstubAllGlobals()
  })

  it('ambiguous edit requests get a read-then-implement directive', async () => {
    vi.stubGlobal('fetch', mk('edit', 0.9))
    const d = await jevFocusDirective(SAFE_SETTINGS, 'improve the app')
    expect(d).toMatch(/underspecified/i)
    expect(d).toMatch(/read the relevant files FIRST/i)
    vi.unstubAllGlobals()
  })

  it('explain requests forbid edits and require file:line citations', async () => {
    vi.stubGlobal('fetch', mk('explain', 0))
    const d = await jevFocusDirective(SAFE_SETTINGS, 'how does the router work?')
    expect(d).toMatch(/No edits/i)
    expect(d).toMatch(/file:line/i)
    vi.unstubAllGlobals()
  })

  it('run requests go straight to commands', async () => {
    vi.stubGlobal('fetch', mk('run', 0))
    const d = await jevFocusDirective(SAFE_SETTINGS, 'run the test suite')
    expect(d).toMatch(/run_command/i)
    vi.unstubAllGlobals()
  })

  it('returns null (no directive) when Jev is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    const d = await jevFocusDirective(SAFE_SETTINGS, 'add a feature')
    expect(d).toBeNull()
    vi.unstubAllGlobals()
  })
})

describe('jevCompletionVerdict — Jev decision analytics on the actual diff', () => {
  const changes = [{ path: 'a.ts', kind: 'modified', afterExcerpt: 'export function add(a,b){return a+b}' }]
  const mk = (choice: string) => vi.fn().mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({ data: { result: { answers: {
      done: { type: 'choice', choice, probabilities: {}, confidence: 0.9 }
    } } } })
  })

  it('returns complete when Jev accepts the changes', async () => {
    vi.stubGlobal('fetch', mk('complete'))
    expect(await jevCompletionVerdict(SAFE_SETTINGS, 'add a function', changes, 'done')).toBe('complete')
    vi.unstubAllGlobals()
  })

  it('returns fix when Jev finds gaps', async () => {
    vi.stubGlobal('fetch', mk('fix'))
    expect(await jevCompletionVerdict(SAFE_SETTINGS, 'add a function', changes, 'done')).toBe('fix')
    vi.unstubAllGlobals()
  })

  it('skips Jev when there are no changes to analyze', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await jevCompletionVerdict(SAFE_SETTINGS, 'add a function', [], 'done')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('jevExplorationVerdict — stop wasteful read-loops', () => {
  const mk = (choice: string) => vi.fn().mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({ data: { result: { answers: {
      next: { type: 'choice', choice, probabilities: {}, confidence: 0.9 }
    } } } })
  })

  it('only consults Jev after 3+ turns without edits', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await jevExplorationVerdict(SAFE_SETTINGS, 'do it', ['read_file'], 2)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('edit verdict when context is sufficient', async () => {
    vi.stubGlobal('fetch', mk('edit'))
    expect(await jevExplorationVerdict(SAFE_SETTINGS, 'fix the bug', ['read_file', 'grep'], 4)).toBe('edit')
    vi.unstubAllGlobals()
  })

  it('explore verdict when key areas are unexamined', async () => {
    vi.stubGlobal('fetch', mk('explore'))
    expect(await jevExplorationVerdict(SAFE_SETTINGS, 'add auth to the API', ['read_file'], 3)).toBe('explore')
    vi.unstubAllGlobals()
  })
})

describe('Toolkit — Jev command gate', () => {
  let root: string
  const approvals: string[] = []
  const events: any[] = []

  function makeToolkit(autoRun: boolean): Toolkit {
    approvals.length = 0
    return new Toolkit([root], {
      onFileChange: (c) => events.push({ type: 'change', c }),
      onOutput: (id, chunk, stream) => events.push({ type: 'output', id, chunk, stream }),
      approve: async (cmd) => { approvals.push(cmd); return true },
      autoRun: () => autoRun
    })
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'meencode-jev-'))
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n')
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('safe commands skip human approval when Jev is enabled', async () => {
    updateSettings({ jevApiKey: 'sk_test', jevAutoApprove: true })
    const tk = makeToolkit(false)
    await tk.execute('run_command', { command: 'echo hi' }, { callId: 't', agent: 'test' })
    expect(approvals).toEqual([])
  })

  it('dangerous commands always require human approval', async () => {
    updateSettings({ jevApiKey: 'sk_test', jevAutoApprove: true })
    const tk = makeToolkit(false)
    await tk.execute('run_command', { command: 'del /s /q everything' }, { callId: 't', agent: 'test' })
    expect(approvals).toEqual(['del /s /q everything'])
  })

  it('falls back to human approval when Jev is not configured', async () => {
    updateSettings({ jevApiKey: '', jevAutoApprove: true })
    const tk = makeToolkit(false)
    await tk.execute('run_command', { command: 'echo hi' }, { callId: 't', agent: 'test' })
    expect(approvals).toEqual(['echo hi'])
  })

  it('falls back to human approval when Jev is disabled', async () => {
    updateSettings({ jevApiKey: 'sk_test', jevAutoApprove: false })
    const tk = makeToolkit(false)
    await tk.execute('run_command', { command: 'echo hi' }, { callId: 't', agent: 'test' })
    expect(approvals).toEqual(['echo hi'])
  })
})