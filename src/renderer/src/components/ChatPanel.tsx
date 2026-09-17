import React, { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { Icon, AGENT_COLORS, AGENT_LABELS, TOOL_LABELS, isMCPTool } from './ui'
import { SessionHistoryPanel } from './SessionHistoryPanel'

export function ChatPanel() {
  const sessions = useStore((s) => s.sessions)
  const activeSessionId = useStore((s) => s.activeSessionId)
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? sessions[0] ?? makeSession()
  const feed = activeSession.feed
  const busy = activeSession.busy
  const send = useStore((s) => s.send)
  const stop = useStore((s) => s.stop)
  const switchSession = useStore((s) => s.switchSession)
  const newSession = useStore((s) => s.newSession)
  const closeSession = useStore((s) => s.closeSession)
  const settings = useStore((s) => s.settings)
  const activeTab = useStore((s) => s.activeTab)
  const files = useStore((s) => s.files)
  const [text, setText] = useState('')
  const [attach, setAttach] = useState(false)
  const [images, setImages] = useState<{ name: string; dataUrl: string }[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null)
  const [mentionSel, setMentionSel] = useState(0)
  const [showAllTabs, setShowAllTabs] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  // ---- Ctrl+V image paste ----
  const onPaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const blob = item.getAsFile()
        if (!blob) continue
        const reader = new FileReader()
        reader.onload = () => {
          setImages((prev) => [...prev.slice(0, 3), { name: blob.name || `pasted-${Date.now()}.png`, dataUrl: String(reader.result) }])
        }
        reader.readAsDataURL(blob)
      }
      if (item.kind === 'string' && item.type === 'text/plain') {
        item.getAsString(async (s) => {
          const m = s.match(/^[a-zA-Z]:[\\/].*\.(png|jpe?g|gif|webp|bmp)$/i)
          if (m) {
            try {
              const img = await window.meencode.images.read(m[0])
              setImages((prev) => [...prev.slice(0, 3), { name: img.name, dataUrl: img.dataUrl }])
            } catch { /* not in workspace — ignore */ }
          }
        })
      }
    }
  }

  // ---- drag & drop images ----
  const onDrop = async (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer?.files ?? [])
    const imgs = files.filter((f) => f.type.startsWith('image/'))
    if (imgs.length === 0) return
    e.preventDefault()
    setDragOver(false)
    for (const f of imgs.slice(0, 4)) {
      const reader = new FileReader()
      reader.onload = () => setImages((prev) => [...prev.slice(0, 3), { name: f.name, dataUrl: String(reader.result) }])
      reader.readAsDataURL(f)
    }
  }

  const pickImages = async () => {
    try {
      const picked = await window.meencode.images.pick()
      setImages((prev) => [...prev, ...picked].slice(0, 4))
    } catch (e: any) {
      alert(e?.message ?? 'Could not read image')
    }
  }

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [feed])

  useEffect(() => {
    const onPrefill = (e: Event) => {
      const detail = (e as CustomEvent).detail as string
      setText(detail)
      taRef.current?.focus()
    }
    document.addEventListener('meencode:prefill-chat', onPrefill)
    return () => document.removeEventListener('meencode:prefill-chat', onPrefill)
  }, [])

  const mentionResults = mention
    ? files
        .filter((f) => f.toLowerCase().includes(mention.query.toLowerCase()))
        .slice(0, 8)
    : []

  const onChange = (v: string) => {
    setText(v)
    const ta = taRef.current
    const caret = ta?.selectionStart ?? v.length
    const upto = v.slice(0, caret)
    const m = upto.match(/@([\w./-]*)$/)
    if (m) {
      setMention({ query: m[1], start: caret - m[0].length })
      setMentionSel(0)
    } else {
      setMention(null)
    }
  }

  const pickMention = (file: string) => {
    if (!mention) return
    const before = text.slice(0, mention.start)
    const after = text.slice((taRef.current?.selectionStart ?? text.length))
    setText(`${before}@${file} ${after}`)
    setMention(null)
    requestAnimationFrame(() => {
      const pos = (before + `@${file} `).length
      taRef.current?.focus()
      taRef.current?.setSelectionRange(pos, pos)
    })
  }

  const submit = () => {
    if (!text.trim() || busy) return
    const t = text
    const imgs = images
    setText('')
    setImages([])
    setMention(null)
    void send(t, attach, imgs)
  }

  const visibleTabs = showAllTabs ? sessions : sessions.slice(0, 8)
  const hiddenCount = sessions.length - visibleTabs.length

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span className="chat-title">
          <Icon name="sparkle" size={13} /> Meencode Agent
        </span>
        <div className="chat-header-right">
          <span className="chat-model">{settings?.model ?? ''}</span>
          <button
            className={`icon-btn chat-history-btn ${useStore.getState().historyOpen ? 'on' : ''}`}
            title="Chat history (Ctrl+Alt+H)"
            onClick={() => useStore.getState().toggleHistory()}
          >
            <Icon name="revert" size={13} />
          </button>
        </div>
      </div>

      <div className="chat-tabs-bar">
        <div className={`chat-tabs ${showAllTabs ? 'expanded' : ''}`}>
          {visibleTabs.map((sess) => (
            <div
              key={sess.id}
              className={`chat-tab ${sess.id === activeSessionId ? 'active' : ''} ${sess.busy ? 'busy' : ''}`}
              onClick={() => switchSession(sess.id)}
              title={sess.title}
            >
              <span className="chat-tab-dot" />
              <span className="chat-tab-title">{sess.title || 'Chat'}</span>
              {sessions.length > 1 && (
                <button
                  className="chat-tab-close"
                  onClick={(e) => { e.stopPropagation(); closeSession(sess.id) }}
                  title="Close session"
                >
                  <Icon name="x" size={10} />
                </button>
              )}
            </div>
          ))}
          {hiddenCount > 0 && !showAllTabs && (
            <button className="chat-tab more" onClick={() => setShowAllTabs(true)} title={`${hiddenCount} more sessions`}>
              +{hiddenCount}
            </button>
          )}
          {showAllTabs && (
            <button className="chat-tab more" onClick={() => setShowAllTabs(false)} title="Collapse tabs">
              <Icon name="chevronLeft" size={10} />
            </button>
          )}
        </div>
        <button className="chat-new-tab" title="New chat session" onClick={() => { newSession(); setText(''); setImages([]) }}>
          <Icon name="plus" size={12} />
        </button>
      </div>

      <div className="chat-body">
        <div className="chat-list" ref={listRef}>
          {feed.length === 0 && <Welcome />}
          {feed.map((item) => (
            <FeedItemView key={item.id} item={item} />
          ))}
        </div>
        <SessionHistoryPanel />
      </div>
      <div className="chat-input-wrap" onDragOver={(e) => { e.preventDefault(); setDragOver(true) }} onDragLeave={() => setDragOver(false)} onDrop={(e) => void onDrop(e)}>
        {dragOver && <div className="drop-overlay">Drop images to attach…</div>}
        {images.length > 0 && (
          <div className="image-chips">
            {images.map((img, i) => (
              <div key={i} className="image-chip">
                <img src={img.dataUrl} alt={img.name} />
                <button
                  className="image-chip-x"
                  title="Remove"
                  onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                >
                  ×
                </button>
                <span className="image-chip-name">{img.name}</span>
              </div>
            ))}
          </div>
        )}
        {mention && mentionResults.length > 0 && (
          <div className="mention-pop">
            {mentionResults.map((f, i) => (
              <div
                key={f}
                className={`mention-item ${i === mentionSel ? 'sel' : ''}`}
                onMouseEnter={() => setMentionSel(i)}
                onClick={() => pickMention(f)}
              >
                <Icon name="file" size={11} />
                {f}
              </div>
            ))}
            <div className="mention-hint">@ attaches the file as context</div>
          </div>
        )}
        <div className="chat-input">
          <textarea
            ref={taRef}
            placeholder={busy ? 'Agent is working…' : 'Ask Meencode… paste or drop images, @file to attach, @codebase to search'}
            value={text}
            rows={Math.min(Math.max(1, text.split('\n').length), 6)}
            onPaste={(e) => void onPaste(e)}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (mention && mentionResults.length > 0) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setMentionSel((s) => Math.min(s + 1, mentionResults.length - 1)); return }
                if (e.key === 'ArrowUp') { e.preventDefault(); setMentionSel((s) => Math.max(s - 1, 0)); return }
                if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mentionResults[mentionSel]); return }
                if (e.key === 'Escape') { setMention(null); return }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            disabled={false}
          />
          <div className="chat-input-actions">
            <button className="chip-btn" title="Attach images (Ctrl+V or drag-drop)" onClick={() => void pickImages()}>
              <Icon name="attach" size={12} />
              Image
            </button>
            <button
              className={`chip-btn ${attach && activeTab ? 'on' : ''}`}
              title={activeTab ? `Attach ${activeTab} as context` : 'Open a file to attach it'}
              disabled={!activeTab}
              onClick={() => setAttach(!attach)}
            >
              <Icon name="attach" size={12} />
              {attach && activeTab ? activeTab.split('/').pop() : 'Attach file'}
            </button>
            <div className="send-group">
              {busy && (
                <button className="stop-btn" title="Stop" onClick={() => void stop()}>
                  <Icon name="stop" size={12} /> Stop
                </button>
              )}
              <button className="send-btn" title="Send (Enter)" onClick={submit} disabled={!text.trim() || busy}>
                <Icon name="send" size={13} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function makeSession(): import('../store').ChatSession {
  const now = Date.now()
  return { id: Math.random().toString(36).slice(2, 10), title: 'New chat', feed: [], changes: [], terminal: [], plan: [], currentAssistantId: null, busy: false, approvalsPending: 0, createdAt: now, updatedAt: now }
}

function Welcome() {
  const send = useStore((s) => s.send)
  const settings = useStore((s) => s.settings)
  const suggestions = [
    ['Explain this codebase', 'Research this codebase and give me a concise overview: structure, main components, and how they connect.'],
    ['Plan a feature', 'I want to add a new feature. First explore the codebase, then propose an implementation plan with steps.'],
    ['Find bugs', 'Investigate this codebase for likely bugs or fragile code and report concrete findings with file:line references.'],
    ['Write tests', 'Explore the codebase and write a focused test suite for the most important logic.'],
    ['Review last commit', 'Read the git log and review the most recent commit for correctness, regressions, and style.'],
    ['Refactor complexity', 'Find the most complex or hard-to-maintain file and propose a focused refactor plan.'],
  ]
  return (
    <div className="welcome">
      <div className="welcome-logo-wrap">
        <div className="welcome-logo"><Icon name="sparkle" size={26} /></div>
      </div>
      <div className="welcome-title">Hi, I'm Meencode</div>
      <div className="welcome-sub">
        An autonomous coding agent — I plan, code, review and debug with sub-agents, right in your workspace.
      </div>
      {settings?.workspace && (
        <div className="welcome-ws">
          <Icon name="folder" size={11} />
          <span>{settings.workspace.split(/[/\\]/).pop()}</span>
        </div>
      )}
      <div className="welcome-chips">
        {suggestions.map(([label, prompt]) => (
          <button key={label} className="chip" onClick={() => void send(prompt, false)}>
            {label}
          </button>
        ))}
      </div>
      <div className="welcome-kbd-hints">
        <span><kbd>⌃K</kbd> inline edit</span>
        <span><kbd>@file</kbd> attach context</span>
        <span><kbd>@codebase</kbd> search</span>
        <span><kbd>⌃⇧P</kbd> commands</span>
      </div>
    </div>
  )
}

function FeedItemView({ item }: { item: import('../store').FeedItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg user msg-enter">
          <div className="msg-bubble user-bubble">{item.text}</div>
        </div>
      )
    case 'assistant':
      return (
        <div className="msg assistant msg-enter">
          {item.thinking && <Thinking text={item.thinking} />}
          <div className="msg-bubble assistant-bubble">
            <MarkdownRenderer text={item.text} />
            {item.streaming && <span className="caret" />}
          </div>
          {!item.streaming && item.text && <FeedbackBar item={item} />}
        </div>
      )
    case 'tool':
      return <ToolItem {...item} />
    case 'subagent':
      return <SubagentItem {...item} />
    case 'plan':
      return <PlanCard steps={item.steps} />
    case 'change':
      return <ChangeCard path={item.change.path} kind={item.change.kind} />
    case 'approval':
      return <ApprovalCard {...item} />
    case 'error':
      return <ErrorCard text={item.text} />
    default:
      return null
  }
}

function FeedbackBar({ item }: { item: import('../store').FeedItem & { kind: 'assistant' } }) {
  const feedback = useStore((s) => s.feedback)
  const [sent, setSent] = useState<'positive' | 'negative' | null>(item.feedback ?? null)
  const [showComment, setShowComment] = useState(false)
  const [comment, setComment] = useState('')

  const sendFeedback = async (kind: 'positive' | 'negative') => {
    if (sent) return
    setSent(kind)
    await feedback(item.id, item.runId ?? '', kind, comment || undefined)
    setShowComment(false)
  }

  if (sent) {
    return (
      <div className="feedback-bar">
        <span className={`feedback-sent ${sent}`}>
          <Icon name={sent === 'positive' ? 'thumbUp' : 'thumbDown'} size={11} />
          {sent === 'positive' ? 'Thanks!' : 'Noted'}
        </span>
      </div>
    )
  }

  return (
    <div className="feedback-bar">
      <button className="feedback-btn up" title="Good response" onClick={() => void sendFeedback('positive')}>
        <Icon name="thumbUp" size={11} />
      </button>
      <button className="feedback-btn down" title="Bad response" onClick={() => setShowComment(!showComment)}>
        <Icon name="thumbDown" size={11} />
      </button>
      {showComment && (
        <div className="feedback-comment-row">
          <input
            autoFocus
            className="feedback-comment-input"
            placeholder="What was wrong? (optional)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void sendFeedback('negative')
              if (e.key === 'Escape') setShowComment(false)
            }}
          />
          <button className="btn" onClick={() => void sendFeedback('negative')}>Send</button>
        </div>
      )}
    </div>
  )
}

function ErrorCard({ text }: { text: string }) {
  const send = useStore((s) => s.send)
  const sessions = useStore((s) => s.sessions)
  const activeSessionId = useStore((s) => s.activeSessionId)
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? sessions[0]

  // Find the last user message to offer retry
  const lastUserMsg = [...(activeSession?.feed ?? [])].reverse().find((f) => f.kind === 'user')
  const isNetworkErr = /connection|network|timeout|ECONNRESET|stream/i.test(text)

  return (
    <div className="error-card-wrap">
      <div className="error-card">
        <Icon name="alert" size={13} />
        <span className="error-card-text">{text}</span>
      </div>
      <div className="error-actions">
        {lastUserMsg && lastUserMsg.kind === 'user' && (
          <button
            className="btn retry-btn"
            title="Retry the last request"
            onClick={() => void send(lastUserMsg.text, false)}
          >
            <Icon name="refresh" size={11} /> Fix this
          </button>
        )}
        {isNetworkErr && (
          <span className="error-hint">Network error — check your connection and API key</span>
        )}
      </div>
    </div>
  )
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="thinking-wrap">
      <button className="thinking-toggle" onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={10} />
        Thinking
      </button>
      {open && <pre className="thinking-body">{text}</pre>}
    </div>
  )
}

// ─── Full Markdown Renderer ──────────────────────────────────────────────────

function MarkdownRenderer({ text }: { text: string }) {
  const nodes = parseMarkdown(text)
  return <div className="msg-md">{nodes.map((n, i) => renderNode(n, i))}</div>
}

type MdNode =
  | { type: 'paragraph'; inlines: MdInline[] }
  | { type: 'heading'; level: 1 | 2 | 3; inlines: MdInline[] }
  | { type: 'code'; lang: string; content: string }
  | { type: 'blockquote'; inlines: MdInline[] }
  | { type: 'ul'; items: MdInline[][] }
  | { type: 'ol'; items: MdInline[][] }
  | { type: 'hr' }
  | { type: 'table'; head: string[]; rows: string[][] }

type MdInline =
  | { type: 'text'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'italic'; value: string }
  | { type: 'code'; value: string }
  | { type: 'link'; href: string; label: string }

function parseMarkdown(text: string): MdNode[] {
  const lines = text.split('\n')
  const nodes: MdNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // fenced code block
    const fenceMatch = line.match(/^```(\w*)/)
    if (fenceMatch) {
      const lang = fenceMatch[1] || ''
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      i++ // consume closing ```
      nodes.push({ type: 'code', lang, content: codeLines.join('\n') })
      continue
    }

    // heading
    const hMatch = line.match(/^(#{1,3})\s+(.+)/)
    if (hMatch) {
      nodes.push({ type: 'heading', level: hMatch[1].length as 1 | 2 | 3, inlines: parseInlines(hMatch[2]) })
      i++; continue
    }

    // hr
    if (/^[-*_]{3,}$/.test(line.trim())) {
      nodes.push({ type: 'hr' })
      i++; continue
    }

    // blockquote
    if (line.startsWith('> ')) {
      nodes.push({ type: 'blockquote', inlines: parseInlines(line.slice(2)) })
      i++; continue
    }

    // table (simple: | col | col |)
    if (/^\|.+\|/.test(line)) {
      const headerCells = line.split('|').slice(1, -1).map((c) => c.trim())
      let j = i + 1
      // skip separator row
      if (j < lines.length && /^\|[-| :]+\|$/.test(lines[j])) j++
      const rows: string[][] = []
      while (j < lines.length && /^\|.+\|/.test(lines[j])) {
        rows.push(lines[j].split('|').slice(1, -1).map((c) => c.trim()))
        j++
      }
      nodes.push({ type: 'table', head: headerCells, rows })
      i = j; continue
    }

    // unordered list
    if (/^[-*+] /.test(line)) {
      const items: MdInline[][] = []
      while (i < lines.length && /^[-*+] /.test(lines[i])) {
        items.push(parseInlines(lines[i].slice(2)))
        i++
      }
      nodes.push({ type: 'ul', items })
      continue
    }

    // ordered list
    if (/^\d+\. /.test(line)) {
      const items: MdInline[][] = []
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(parseInlines(lines[i].replace(/^\d+\. /, '')))
        i++
      }
      nodes.push({ type: 'ol', items })
      continue
    }

    // blank line — skip
    if (line.trim() === '') { i++; continue }

    // paragraph
    const paraLines: string[] = []
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].startsWith('#') && !lines[i].startsWith('```') && !/^[-*+] /.test(lines[i]) && !/^\d+\. /.test(lines[i]) && !lines[i].startsWith('> ') && !/^\|.+\|/.test(lines[i])) {
      paraLines.push(lines[i])
      i++
    }
    if (paraLines.length > 0) {
      nodes.push({ type: 'paragraph', inlines: parseInlines(paraLines.join('\n')) })
    }
  }
  return nodes
}

function parseInlines(text: string): MdInline[] {
  const out: MdInline[] = []
  // handle bold, italic, inline code, links
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|__[^_]+__|_[^_]+_|\[([^\]]+)\]\(([^)]+)\))/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) })
    const tok = m[0]
    if (tok.startsWith('`')) {
      out.push({ type: 'code', value: tok.slice(1, -1) })
    } else if (tok.startsWith('**') || tok.startsWith('__')) {
      out.push({ type: 'bold', value: tok.slice(2, -2) })
    } else if (tok.startsWith('*') || tok.startsWith('_')) {
      out.push({ type: 'italic', value: tok.slice(1, -1) })
    } else if (m[2] && m[3]) {
      out.push({ type: 'link', href: m[3], label: m[2] })
    }
    last = re.lastIndex
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) })
  return out
}

function renderInlines(inlines: MdInline[], key?: number): React.ReactNode {
  return inlines.map((il, i) => {
    const k = `${key ?? 0}-${i}`
    switch (il.type) {
      case 'text': return <span key={k}>{il.value}</span>
      case 'bold': return <strong key={k}>{il.value}</strong>
      case 'italic': return <em key={k}>{il.value}</em>
      case 'code': return <code key={k} className="md-inline-code">{il.value}</code>
      case 'link': return <a key={k} href={il.href} target="_blank" rel="noreferrer">{il.label}</a>
    }
  })
}

function renderNode(node: MdNode, key: number): React.ReactNode {
  switch (node.type) {
    case 'heading': {
      const content = renderInlines(node.inlines, key)
      if (node.level === 1) return <h1 key={key} className="md-h1">{content}</h1>
      if (node.level === 2) return <h2 key={key} className="md-h2">{content}</h2>
      return <h3 key={key} className="md-h3">{content}</h3>
    }
    case 'paragraph':
      return <p key={key} className="md-p">{renderInlines(node.inlines, key)}</p>
    case 'code':
      return <CodeBlock key={key} lang={node.lang} content={node.content} />
    case 'blockquote':
      return <blockquote key={key} className="md-blockquote">{renderInlines(node.inlines, key)}</blockquote>
    case 'ul':
      return (
        <ul key={key} className="md-ul">
          {node.items.map((item, i) => <li key={i} className="md-li">{renderInlines(item, i)}</li>)}
        </ul>
      )
    case 'ol':
      return (
        <ol key={key} className="md-ol">
          {node.items.map((item, i) => <li key={i} className="md-li">{renderInlines(item, i)}</li>)}
        </ol>
      )
    case 'hr':
      return <hr key={key} className="md-hr" />
    case 'table':
      return (
        <div key={key} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>{node.head.map((h, i) => <th key={i}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {node.rows.map((row, ri) => (
                <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{cell}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )
  }
}

function CodeBlock({ lang, content }: { lang: string; content: string }) {
  const [copied, setCopied] = useState(false)
  const lines = content.split('\n').length

  const copy = () => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    })
  }

  return (
    <div className={`msg-code-wrap lang-block-${lang || 'plain'}`}>
      <div className="msg-code-header">
        {lang && <span className="msg-code-lang">{lang}</span>}
        <span className="msg-code-lines">{lines} line{lines !== 1 ? 's' : ''}</span>
        <button className="code-copy-btn" onClick={copy} title="Copy code">
          {copied ? <><Icon name="check" size={11} /> Copied</> : <><Icon name="attach" size={11} /> Copy</>}
        </button>
      </div>
      <pre className="msg-code"><code>{content}</code></pre>
    </div>
  )
}

function ToolItem(props: { id: string; kind: 'tool'; agent: string; name: string; argsSummary: string; status: string; result?: string; ms?: number }) {
  const [open, setOpen] = useState(false)
  const color = AGENT_COLORS[props.agent] ?? 'var(--dim)'
  const isMcp = isMCPTool(props.name)
  const verb = TOOL_LABELS[props.name] ?? (isMcp ? props.name.split('.')[1] : props.name)
  const iconName: import('./ui').IconName = isMcp ? 'mcp' : 'tool'
  return (
    <div className={`tool-item ${isMcp ? 'mcp' : ''} tool-enter`} style={{ borderLeftColor: color }}>
      <button className="tool-row" onClick={() => setOpen(!open)}>
        {props.status === 'running' ? (
          <span className="tool-spinner"><Icon name="spinner" size={11} /></span>
        ) : props.status === 'ok' ? (
          <span className="tool-check"><Icon name="check" size={11} /></span>
        ) : (
          <span className="tool-error"><Icon name="x" size={11} /></span>
        )}
        <span className="tool-icon"><Icon name={iconName} size={11} /></span>
        <span className="tool-agent" style={{ color }}>{AGENT_LABELS[props.agent] ?? props.agent}</span>
        <span className="tool-verb">{verb}</span>
        <span className="tool-args" title={props.result}>{props.argsSummary}</span>
        {props.ms !== undefined && <span className="tool-ms">{props.ms}ms</span>}
        {props.result && <span className="tool-expand-hint">{open ? '▲' : '▼'}</span>}
      </button>
      {open && props.result && <pre className="tool-result">{props.result}</pre>}
    </div>
  )
}

function SubagentItem(props: { id: string; kind: 'subagent'; agent: string; task: string; state: 'start' | 'end'; summary?: string }) {
  const color = AGENT_COLORS[props.agent] ?? 'var(--dim)'
  if (props.state === 'start') {
    return (
      <div className="subagent-item start tool-enter" style={{ borderColor: color }}>
        <span className="tool-spinner"><Icon name="spinner" size={11} /></span>
        <span className="subagent-name" style={{ color }}>{AGENT_LABELS[props.agent] ?? props.agent}</span>
        <span className="subagent-task">{props.task}</span>
      </div>
    )
  }
  return (
    <div className="subagent-item end tool-enter" style={{ borderColor: color }}>
      <span className="tool-check"><Icon name="check" size={11} /></span>
      <span className="subagent-name" style={{ color }}>{AGENT_LABELS[props.agent] ?? props.agent}</span>
      <span className="subagent-summary">{props.summary}</span>
    </div>
  )
}

function PlanCard({ steps }: { steps: any[] }) {
  return (
    <div className="plan-card">
      <div className="plan-title">
        <Icon name="check" size={12} />
        Plan — {steps.filter((s) => s.status === 'done').length}/{steps.length} steps
      </div>
      {steps.map((s) => (
        <div key={s.id} className={`plan-step ${s.status}`}>
          <span className={`plan-check ${s.status}`}>
            {s.status === 'done' ? <Icon name="check" size={10} /> : <span className="plan-id">{s.id}</span>}
          </span>
          <div>
            <div className="plan-step-title">{s.title}</div>
            {s.detail && <div className="plan-step-detail">{s.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  )
}

function ChangeCard({ path, kind }: { path: string; kind: string }) {
  const openFile = useStore((s) => s.openFile)
  const revertChange = useStore((s) => s.revertChange)
  const set = useStore((s) => s.set)
  return (
    <div className="change-card" data-kind={kind}>
      <span className={`change-kind kind-${kind}`}>{kind}</span>
      <button className="change-path" title={path} onClick={() => void openFile(path)}>
        {path}
      </button>
      <span className="change-actions">
        <button className="mini-btn" title="Review diff" onClick={() => set('reviewModalOpen', true)}>
          <Icon name="review" size={11} />
        </button>
        <button className="mini-btn danger" title="Revert this file" onClick={() => void revertChange(path)}>
          <Icon name="revert" size={11} />
        </button>
      </span>
    </div>
  )
}

function ApprovalCard(props: { id: string; kind: 'approval'; command: string; state: 'pending' | 'approved' | 'denied' }) {
  const approve = useStore((s) => s.approve)
  if (props.state !== 'pending') {
    return (
      <div className={`approval-result ${props.state}`}>
        <Icon name={props.state === 'approved' ? 'check' : 'x'} size={11} />
        {props.state === 'approved' ? 'Approved' : 'Denied'}: <code>{props.command}</code>
      </div>
    )
  }
  return (
    <div className="approval-card">
      <div className="approval-title">
        <Icon name="alert" size={12} />
        Command approval
      </div>
      <pre className="approval-cmd">{props.command}</pre>
      <div className="approval-actions">
        <button className="btn approve" onClick={() => void approve(props.id, true)}>
          <Icon name="check" size={11} /> Approve
        </button>
        <button className="btn deny" onClick={() => void approve(props.id, false)}>
          <Icon name="x" size={11} /> Deny
        </button>
      </div>
    </div>
  )
}
