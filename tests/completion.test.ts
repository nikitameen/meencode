import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

vi.mock('electron', () => ({
  app: {
    getPath: () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')),
    getAppPath: () => process.cwd()
  },
  net: {}
}))

const { AgentSession } = await import('../src/main/agent/orchestrator')

function makeSession() {
  const events: any[] = []
  const settings = { apiKey: 'k', baseUrl: 'https://ollama.com', model: 'm', fastModel: 'm', maxIterations: 10, autoRunCommands: false, workspace: null, roots: [], mcpServers: [] }
  const session = new AgentSession({
    emit: (e: any) => events.push(e),
    getSettings: () => settings
  })
  return { session, events }
}

describe('isRunComplete — work must actually exist on disk', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'meencode-complete-'))
  })

  it('rejects a narrated "done" with no edits and forces real work', () => {
    const { session } = makeSession()
    session.setWorkspace(root)
    session['lastUserText'] = 'add a dark-mode toggle to the app'
    const nudge: { text: string } = { text: '' }
    // model said "Done, added the feature" — but no tool calls, no edits
    const complete = session['isRunComplete']('Done! I added the function.', 0, nudge)
    expect(complete).toBe(false)
    expect(nudge.text).toMatch(/have not made any edits/i)
  })

  it('rejects code-in-prose and demands write_file/edit_file', () => {
    const { session } = makeSession()
    session.setWorkspace(root)
    session['lastUserText'] = 'write the util function'
    const nudge: { text: string } = { text: '' }
    const complete = session['isRunComplete']('```js\nconst x = 1\n```', 0, nudge)
    expect(complete).toBe(false)
    expect(nudge.text).toMatch(/no file was edited/i)
  })

  it('rejects read-only exploration followed by a "plan" answer', () => {
    const { session } = makeSession()
    session.setWorkspace(root)
    session['lastUserText'] = 'fix the login bug'
    const nudge: { text: string } = { text: '' }
    const complete = session['isRunComplete']('I read the files. Here is my plan: ...', 3, nudge)
    expect(complete).toBe(false)
    expect(nudge.text).toMatch(/no requested file was changed/i)
  })

  it('accepts completion once files were actually edited', () => {
    const { session } = makeSession()
    session.setWorkspace(root)
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello')
    // simulate a real edit recorded by the toolkit
    session['toolkit']!.changes.set('a.txt', {
      path: 'a.txt', kind: 'modified', before: 'hello', after: 'hello2', ts: Date.now()
    } as any)
    const nudge: { text: string } = { text: '' }
    const complete = session['isRunComplete']('Added the feature to a.txt.', 2, nudge)
    expect(complete).toBe(true)
  })

  it('accepts prose answers for questions (no change requested)', () => {
    const { session } = makeSession()
    session.setWorkspace(root)
    session['lastUserText'] = 'What does the config.ts file do?'
    const nudge: { text: string } = { text: '' }
    const complete = session['isRunComplete']('It sets up the app configuration.', 0, nudge)
    expect(complete).toBe(true)
  })

  it('gives up gracefully after bounded retries instead of looping forever', () => {
    const { session } = makeSession()
    session.setWorkspace(root)
    session['lastUserText'] = 'add a dark mode toggle'
    const nudge: { text: string } = { text: '' }
    session['isRunComplete']('nope', 0, nudge)
    session['isRunComplete']('nope', 0, nudge)
    session['isRunComplete']('nope', 0, nudge)
    // budget exhausted: accept so the run does not hang forever
    const complete = session['isRunComplete']('Done (claimed)', 0, nudge)
    expect(complete).toBe(true)
  })
})