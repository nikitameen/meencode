# Meencode

**Meencode** is a desktop code editor with a built-in autonomous coding agent — a Cursor-class experience powered by **Ollama Cloud** and a team of specialist **sub-agents** (planner, coder, reviewer, debugger, researcher).

Built with Electron + React + Monaco.

## Highlights

- **Sub-agent team** — a lead orchestrator delegates to specialists: Planner → Coder (per step) → Reviewer → Debugger, with a Researcher for read-only exploration. You watch every step live in chat.
- **Ollama Cloud only** — streams from `https://api.ollama.com` (OpenAI-compatible `/v1/chat/completions`). No local server needed. Bring any cloud model (`qwen3-coder:480b`, `gpt-oss:120b`, `deepseek-v3.1`, custom tags…).
- **Real editor** — Monaco with tabs, file tree, fuzzy file open (Ctrl+P), command palette (Ctrl+Shift+P), save, reveal-in-explorer.
- **Reviewable changes** — every agent edit is tracked with before/after; review diffs side-by-side, revert single files or everything in one click. Checkpoints are also written to `.meencode/checkpoints/`.
- **Command approval gate** — by default every shell command the agent wants to run requires your approval in chat. Flip one setting to auto-run.
- **Agent terminal** — commands run by the agent stream into a terminal panel (with exit codes); run your own commands there too.
- **Streaming chat** — tokens, thinking (`…` or `reasoning_content`), live tool activity with per-agent colors, plan checklist cards.
- **Sandboxed** — all agent file access is restricted to your workspace folder. No path escapes.
- **Native-format fallback** — handles both OpenAI-style `tool_calls` and Qwen-style text tool calls, so any model can drive the tools.
- **Cmd+K inline edits** — select code, press Ctrl+K, describe the change → AI rewrites the selection with Accept/Reject, like Cursor's Cmd+K.
- **Tab autocomplete** — AI ghost-text completions as you type (debounced), Ctrl+Space for manual, Tab to accept; toggle in the status bar or palette.
- **@-mentions + rules** — type `@file.ts` in chat to attach context; drop a `.meencoderules` (or `.cursorrules`) file in the workspace and every request obeys it.
- **@codebase search** — fast keyword index of your workspace (Ctrl+Shift+F panel, or `@codebase` inside a chat message) with ranked file:line hits.
- **Checkpoints** — every agent edit saves the original to `.meencode/checkpoints/<run>/`; restore any file or a whole run from the Checkpoints modal (status bar or palette).
- **Real terminals** — interactive shells (node-pty + xterm.js) alongside the Agent terminal; AI command suggestions with one click.
- **Git built-in** — stage/unstage/commit/push/pull, branch + ahead/behind in the status bar (Ctrl+Shift+G panel).
- **Built-in browser** — webview panel with URL bar and navigation (Ctrl+Alt+B) for docs/previews.
- **Import into workspace** — sidebar buttons copy external files/folders into your project.

## Quickstart

```bash
npm install

# Option A: put your key in .env
cp .env.example .env
#   then set OLLAMA_API_KEY=...

# Option B: paste the key in the app (Settings → Ollama Cloud API key)

npm run dev
```

Get an API key at https://ollama.com/sign-in (Cloud → API keys).

## The workflow

1. **Open a folder** (top bar).
2. Ask the agent: *"Add a dark-mode toggle to this app"*.
3. Watch it plan → code → review → verify, with each step live in the chat panel.
4. Click **N changes** (status bar) to review diffs; keep or revert each file.

### Shortcuts

| Keys | Action |
|---|---|
| Ctrl+Shift+P | Command palette |
| Ctrl+P | Fuzzy find files |
| Ctrl+S | Save active file |
| Ctrl+B | Toggle sidebar |
| Ctrl+K | Inline AI edit (with code selected) |
| Ctrl+Space | AI autocomplete at cursor |
| Ctrl+Shift+F | Search codebase |
| Ctrl+Shift+G | Git panel |
| Ctrl+Alt+B | Built-in browser |
| Ctrl+` / Ctrl+J | Toggle terminal |
| Ctrl+L | Toggle chat |

## Architecture

```
src/
├── main/                 # Electron main process
│   ├── agent/
│   │   ├── orchestrator.ts   # lead agent + sub-agent spawning + approvals
│   │   ├── loop.ts           # reusable tool-use loop (model-agnostic)
│   │   ├── ollamaClient.ts   # Ollama Cloud streaming client + SSE/native parsing
│   │   ├── tools.ts          # sandboxed workspace tools (fs, grep, glob, exec)
│   │   └── subagents.ts      # sub-agent prompts, plan/verdict parsing
│   ├── ipc.ts            # all IPC handlers, tree builder, watcher
│   └── settingsStore.ts  # persisted settings (userData/settings.json)
├── preload/index.ts      # contextBridge API
├── renderer/             # React UI (chat, editor, review, terminal, palette)
└── shared/               # types shared across processes
```

- Agent messages stream over one WebSocket-like IPC channel (`agent:event`), so the UI renders a single live activity feed.
- Every file edit flows through `Toolkit.record()` → `file_change` event → review UI, with on-disk checkpoints per run.
- The loop is pure and model-agnostic; the client handles OpenAI `tool_calls`, Qwen `…` text tool calls, and `reasoning_content` thinking.

## Development

```bash
npm run typecheck   # tsc, main + renderer
npm run test        # vitest (tools, SSE parsing, loop)
npm run dev         # run the desktop app
npm run build       # production build to out/
```

## Security notes

- All agent file operations are sandboxed to the workspace root.
- Shell commands require explicit approval unless you enable auto-run.
- The API key is stored in `userData/settings.json` (or read from `OLLAMA_API_KEY` / `.env`).
- Reverted changes are also preserved on disk under `.meencode/checkpoints/<run>/`.