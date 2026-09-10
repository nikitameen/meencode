import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { Icon, AGENT_COLORS, AGENT_LABELS, TOOL_LABELS } from './ui'

export function ChatPanel() {
  const feed = useStore((s) => s.feed)
  const busy = useStore((s) => s.busy)
  const send = useStore((s) => s.send)
  const stop = useStore(() => window.meencode.agent.stop)
  const settings = useStore((s) => s.settings)
  const activeTab = useStore((s) => s.activeTab)
  const files = useStore((s) => s.files)
  const [text, setText] = useState('')
  const [attach, setAttach] = useState(false)
  const [images, setImages] = useState<{ name: string; dataUrl: string }[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null)
  const [mentionSel, setMentionSel] = useState(0)
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
      // pasting a file from the OS explorer arrives as text with a path
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
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [feed])

  // "Ask Agent about Selection" / Run menu prefill
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
    // detect @mention typing
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

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span className="chat-title">
          <Icon name="sparkle" size={13} /> Meencode Agent
        </span>
        <span className="chat-model">{settings?.model ?? ''}</span>
      </div>
      <div className="chat-list" ref={listRef}>
        {feed.length === 0 && <Welcome />}
        {feed.map((item) => (
          <FeedItemView key={item.id} item={item} />
        ))}
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

function Welcome() {
  const send = useStore((s) => s.send)
  const suggestions = [
    ['Explain this codebase', 'Research this codebase and give me a concise overview: structure, main components, and how they connect.'],
    ['Plan a feature', 'I want to add a new feature. First explore the codebase, then propose an implementation plan.'],
    ['Find potential bugs', 'Investigate this codebase for likely bugs or fragile code and report concrete findings with file:line references.'],
    ['Write tests', 'Explore the codebase and write a focused test suite for the most important logic.']
  ]
  return (
    <div className="welcome">
      <div className="welcome-logo"><Icon name="sparkle" size={22} /></div>
      <div className="welcome-title">Hi, I'm Meencode</div>
      <div className="welcome-sub">
        An autonomous coding agent. I plan, code, review and debug — with sub-agents, in your workspace.
      </div>
      <div className="welcome-chips">
        {suggestions.map(([label, prompt]) => (
          <button key={label} className="chip" onClick={() => void send(prompt, false)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}

function FeedItemView({ item }: { item: ReturnType<typeof useStore.getState>['feed'][number] }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg user">
          <div className="msg-bubble user-bubble">{item.text}</div>
        </div>
      )
    case 'assistant':
      return (
        <div className="msg assistant">
          {item.thinking && <Thinking text={item.thinking} />}
          <div className="msg-bubble assistant-bubble">
            <Markdownish text={item.text} />
            {item.streaming && <span className="caret" />}
          </div>
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
      return (
        <div className="error-card">
          <Icon name="alert" size={13} />
          <span>{item.text}</span>
        </div>
      )
    default:
      return null
  }
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

function Markdownish({ text }: { text: string }) {
  const parts: React.ReactNode[] = []
  const lines = text.split('\n')
  let inCode = false
  let codeLines: string[] = []
  let key = 0
  const flush = () => {
    if (codeLines.length > 0) {
      parts.push(<pre key={key++} className="msg-code">{codeLines.join('\n')}</pre>)
      codeLines = []
    }
  }
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCode) flush()
      inCode = !inCode
      continue
    }
    if (inCode) codeLines.push(line)
    else {
      if (line.trim() === '') continue
      const bolded = line.split(/\*\*(.+?)\*\*/g).map((seg, i) => (i % 2 === 1 ? <strong key={i}>{seg}</strong> : seg))
      parts.push(<p key={key++}>{bolded}</p>)
    }
  }
  flush()
  return <div className="msg-md">{parts}</div>
}

function ToolItem(props: { id: string; kind: 'tool'; agent: string; name: string; argsSummary: string; status: string; result?: string; ms?: number }) {
  const [open, setOpen] = useState(false)
  const color = AGENT_COLORS[props.agent] ?? 'var(--dim)'
  const verb = TOOL_LABELS[props.name] ?? props.name
  return (
    <div className="tool-item" style={{ borderLeftColor: color }}>
      <button className="tool-row" onClick={() => setOpen(!open)}>
        {props.status === 'running' ? (
          <span className="tool-spinner"><Icon name="spinner" size={11} /></span>
        ) : props.status === 'ok' ? (
          <span className="tool-check"><Icon name="check" size={11} /></span>
        ) : (
          <span className="tool-error"><Icon name="x" size={11} /></span>
        )}
        <span className="tool-agent" style={{ color }}>{AGENT_LABELS[props.agent] ?? props.agent}</span>
        <span className="tool-verb">{verb}</span>
        <span className="tool-args" title={props.result}>{props.argsSummary}</span>
        {props.ms !== undefined && <span className="tool-ms">{props.ms}ms</span>}
      </button>
      {open && props.result && <pre className="tool-result">{props.result}</pre>}
    </div>
  )
}

function SubagentItem(props: { id: string; kind: 'subagent'; agent: string; task: string; state: 'start' | 'end'; summary?: string }) {
  const color = AGENT_COLORS[props.agent] ?? 'var(--dim)'
  if (props.state === 'start') {
    return (
      <div className="subagent-item start" style={{ borderColor: color }}>
        <span className="tool-spinner"><Icon name="spinner" size={11} /></span>
        <span className="subagent-name" style={{ color }}>{AGENT_LABELS[props.agent] ?? props.agent}</span>
        <span className="subagent-task">{props.task}</span>
      </div>
    )
  }
  return (
    <div className="subagent-item end" style={{ borderColor: color }}>
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