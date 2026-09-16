// Full local integration test: real AgentSession + Toolkit + slice index +
// access graph + prefetch, with only the network layer mocked (fetch).
// Verifies the "write code immediately" flow end to end:
// prompt -> prefetch injected -> orchestrator edits directly -> file on disk
// -> change recorded -> telemetry logged -> next run gets a behavior prior.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const sessionStore = await import('../src/main/sessionStore')
const sliceStore = await import('../src/main/sliceStore')
const g = await import('../src/main/accessGraph')

let tmp = ''
let ws = ''
let dbFile = ''

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meencode-it-'))
  ws = path.join(tmp, 'project')
  dbFile = path.join(tmp, 'slices.db')
  const mock = await import('./mocks/electron')
  fs.rmSync(mock.app.getPath('userData'), { recursive: true, force: true })
  await sessionStore.initSessionDb()
  await sliceStore.initSliceDb(dbFile)
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const write = (p: string, c: string): void => {
  const abs = path.join(ws, p)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, c)
}

/**
 * Fetch mock that discriminates by request body:
 * - stream:false  -> expandQuery / quickLLM background probes -> empty answer
 * - stream:true   -> the agent chat (SSE) -> scripted sequence
 */
function chatMock(script: { toolCalls?: { id: string; name: string; args: object }[]; final: string }) {
  let chatTurn = 0
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    if (!body || body.stream !== true) {
      return new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 })
    }
    chatTurn++
    if (chatTurn === 1 && script.toolCalls?.length) {
      return sse([
        ...script.toolCalls.map((c) => toolCallTurn(c.id, c.name, JSON.stringify(c.args))),
        { choices: [{ index: 0, delta: {} }] }
      ])
    }
    return sse([contentTurn(script.final)])
  })
}

/** capture the first chat (stream:true) user message */
function captureFirstChatUser(captured: { user: string }): (u: string, init?: RequestInit) => Promise<Response> {
  let chatSeen = false
  const base = chatMock({ final: 'done' })
  return async (u: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    if (body?.stream === true && !chatSeen) {
      chatSeen = true
      const user = body.messages?.find((m: any) => m.role === 'user')
      captured.user = typeof user?.content === 'string' ? user.content : ''
    }
    return base(u, init)
  }
}

/** OpenAI-style SSE stream carrying the given chunks. */
function sse(chunks: object[]): Response {
  const enc = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const c of chunks) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`))
        }
        controller.enqueue(enc.encode('data: [DONE]\n\n'))
        controller.close()
      }
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  )
}

/** assistant turn with tool_calls (OpenAI streaming delta format) */
function toolCallTurn(id: string, name: string, argsJson: string): object {
  return {
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: argsJson } }]
      }
    }]
  }
}

function contentTurn(text: string): object {
  return { choices: [{ index: 0, delta: { role: 'assistant', content: text } }] }
}

describe('write-immediately integration', () => {
  let session: any
  let events: any[]
  let settings: any

  beforeEach(async () => {
    // fresh workspace with an existing file to edit
    write('src/app.ts', [
      'export function greet(name: string): string {',
      '  return "hello " + name',
      '}',
      'export function main(): void {',
      '  console.log(greet("world"))',
      '}'
    ].join('\n'))
    write('src/settings.ts', 'export const MAX = 10\n')
    await sliceStore.indexRoot(ws)

    events = []
    settings = {
      apiKey: 'test-key',
      baseUrl: 'https://api.ollama.com',
      model: 'test-model',
      fastModel: 'test-fast',
      maxIterations: 8,
      autoRunCommands: false,
      workspace: ws,
      roots: [ws]
    }
    const { AgentSession } = await import('../src/main/agent/orchestrator')
    session = new AgentSession({
      emit: (e: any) => events.push(e),
      getSettings: () => settings
    })
    session.setRoots([ws])
  })

  it('lead agent edits directly on the first turn (no spawn_agent)', async () => {
    // the model goes straight to edit_file in its FIRST chat response
    vi.stubGlobal('fetch', chatMock({
      toolCalls: [{
        id: 'c1',
        name: 'edit_file',
        args: {
          path: 'src/app.ts',
          old_string: 'return "hello " + name',
          new_string: 'return `hello ${name}`'
        }
      }],
      final: 'Switched greet() to a template literal in src/app.ts.'
    }))

    await session.send('use a template literal in the greet function', null, null, null)

    // file was actually changed on disk
    const onDisk = fs.readFileSync(path.join(ws, 'src/app.ts'), 'utf8')
    expect(onDisk).toContain('return `hello ${name}`')

    // the change went through the review/checkpoint pipeline
    const fileChange = events.find((e) => e.type === 'file_change')
    expect(fileChange?.change?.path).toBe('src/app.ts')
    expect(fileChange?.change?.kind).toBe('modified')

    // NO sub-agent was spawned
    expect(events.some((e) => e.type === 'subagent_start')).toBe(false)

    // run completed cleanly
    const runEnd = events.find((e) => e.type === 'run_end')
    expect(runEnd?.error).toBeUndefined()

    // telemetry: the edit was logged for this request topic
    g.flushAccessForTest()
    const hash = g.requestHashOf('use a template literal in the greet function')
    const prior = g.accessPrior(ws, hash, 10)
    expect(prior.some((p) => p.rel === 'src/app.ts' && p.edits >= 1)).toBe(true)
    vi.unstubAllGlobals()
  })

  it('second run on the same topic: prefetch pack includes the behavior prior', async () => {
    // seed the prior with a first run's telemetry
    const hash = g.requestHashOf('make greet return uppercase')
    g.recordAccess(ws, hash, 'src/app.ts', 'edit')
    g.flushAccessForTest()

    const captured: { user: string } = { user: '' }
    vi.stubGlobal('fetch', captureFirstChatUser(captured))

    await session.send('make greet return uppercase', null, null, null)
    // the user turn carried the behavior prior (file touched for this topic before)
    expect(captured.user).toContain('src/app.ts')
    vi.unstubAllGlobals()
  })

  it('first-turn prompt carries prefetched slices for the touched code', async () => {
    await sliceStore.indexRoot(ws) // ensure fresh index of app.ts
    const captured: { user: string } = { user: '' }
    vi.stubGlobal('fetch', captureFirstChatUser(captured))

    await session.send('change the greet function to shout loudly', null, null, null)
    // BM25 should have prefetched the greet() slice into the first user turn
    expect(captured.user).toContain('greet')
    expect(captured.user).toContain('src/app.ts')
    vi.unstubAllGlobals()
  })
})