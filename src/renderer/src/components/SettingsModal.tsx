import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { Icon } from './ui'

export function SettingsModal() {
  const open = useStore((s) => s.settingsModalOpen)
  const set = useStore((s) => s.set)
  const settings = useStore((s) => s.settings)
  const [apiKey, setApiKey] = useState(settings?.apiKey ?? '')
  const [baseUrl, setBaseUrl] = useState(settings?.baseUrl ?? 'https://ollama.com')
  const [model, setModel] = useState(settings?.model ?? 'glm-5.3-flash')
  const [fastModel, setFastModel] = useState(settings?.fastModel ?? settings?.model ?? 'glm-5.3-flash')
  const [maxIter, setMaxIter] = useState(settings?.maxIterations ?? 30)
  const [autoRun, setAutoRun] = useState(settings?.autoRunCommands ?? false)
  const [showKey, setShowKey] = useState(false)
  const [saved, setSaved] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [loadingModels, setLoadingModels] = useState(false)
  const [subModels, setSubModels] = useState<Record<string, string>>(settings?.subAgentModels ?? {})
  const [mcpServers, setMcpServers] = useState<import('../../../shared/types').MCPServerConfig[]>(settings?.mcpServers ?? [])

  useEffect(() => {
    if (!open) return
    setApiKey(settings?.apiKey ?? '')
    setBaseUrl(settings?.baseUrl ?? 'https://ollama.com')
    setModel(settings?.model ?? 'glm-5.3-flash')
    setFastModel(settings?.fastModel || settings?.model || 'glm-5.3-flash')
    setMaxIter(settings?.maxIterations ?? 30)
    setAutoRun(settings?.autoRunCommands ?? false)
    setSubModels(settings?.subAgentModels ?? {})
    setMcpServers(settings?.mcpServers ?? [])
  }, [open, settings])

  const loadModels = async () => {
    setLoadingModels(true)
    setModelsError(null)
    const r = await window.meencode.models.list()
    setLoadingModels(false)
    if (r.ok) {
      setModels(r.models)
    } else {
      setModelsError(r.error)
    }
  }

  useEffect(() => {
    if (open && apiKey) void loadModels()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  const save = async () => {
    await window.meencode.settings.update({ apiKey, baseUrl, model, fastModel, subAgentModels: subModels, maxIterations: maxIter, autoRunCommands: autoRun, mcpServers })
    const s = await window.meencode.settings.get()
    set('settings', s)
    setSaved(true)
    setTimeout(() => { setSaved(false); set('settingsModalOpen', false) }, 600)
  }

  return (
    <div className="overlay" onClick={() => set('settingsModalOpen', false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span><Icon name="settings" size={14} /> Settings</span>
          <button className="icon-btn" onClick={() => set('settingsModalOpen', false)}>
            <Icon name="x" size={12} />
          </button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>
              Ollama Cloud API key
              <a className="field-link" onClick={() => void window.meencode.openExternal('https://ollama.com/sign-in')}>
                Get a key <Icon name="external" size={10} />
              </a>
            </label>
            <div className="key-row">
              <input
                type={showKey ? 'text' : 'password'}
                placeholder="Paste your Ollama Cloud key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <button className="icon-btn" onClick={() => setShowKey(!showKey)} title={showKey ? 'Hide' : 'Show'}>
                <Icon name={showKey ? 'eyeOff' : 'eye'} size={14} />
              </button>
            </div>
            <div className="field-hint">Also read from the OLLAMA_API_KEY environment variable or a .env file.</div>
          </div>
          <div className="field">
            <label>Base URL</label>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.ollama.com" />
            <div className="field-hint">OpenAI-compatible /v1/chat/completions endpoint of Ollama Cloud.</div>
          </div>
          <div className="field">
            <label>
              Model
              <button className="field-link" onClick={() => void loadModels()} title="Fetch available models from Ollama Cloud">
                <Icon name="refresh" size={10} /> {loadingModels ? 'Loading…' : 'Refresh list'}
              </button>
            </label>
            {modelsError && <div className="field-hint error">{modelsError}</div>}
            {models.length > 0 ? (
              <select value={models.includes(model) ? model : '__custom'} onChange={(e) => setModel(e.target.value === '__custom' ? model : e.target.value)}>
                {models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
                <option value="__custom">custom…</option>
              </select>
            ) : (
              <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="model:tag" />
            )}
            {models.length > 0 && !models.includes(model) && (
              <input className="custom-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="model:tag" />
            )}
            <div className="field-hint">The big model powers the coder/debugger and final answers.</div>
          </div>
          <div className="field">
            <label>Fast model (planner · researcher · reviewer · autocomplete)</label>
            {models.length > 0 ? (
              <select value={models.includes(fastModel) ? fastModel : '__custom'} onChange={(e) => setFastModel(e.target.value === '__custom' ? fastModel : e.target.value)}>
                {models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
                <option value="__custom">custom…</option>
              </select>
            ) : (
              <input value={fastModel} onChange={(e) => setFastModel(e.target.value)} placeholder="model:tag" />
            )}
            {models.length > 0 && !models.includes(fastModel) && (
              <input className="custom-model" value={fastModel} onChange={(e) => setFastModel(e.target.value)} placeholder="model:tag" />
            )}
            <div className="field-hint">A small fast model (e.g. glm-5.3-flash, gpt-oss:20b) makes the agent dramatically quicker. Defaults to the main model if unset.</div>
          </div>
          <div className="field">
            <label>Max agent iterations per message</label>
            <div className="slider-row">
              <input type="range" min="5" max="60" value={maxIter} onChange={(e) => setMaxIter(Number(e.target.value))} />
              <span className="slider-val">{maxIter}</span>
            </div>
          </div>
          <div className="field toggle-field">
            <label className="toggle">
              <input type="checkbox" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} />
              <span className="toggle-track"><span className="toggle-thumb" /></span>
              <span>
                Auto-run commands without approval
                <span className="field-hint">
                  If off, every shell command the agent wants to run requires your approval in chat.
                </span>
              </span>
            </label>
          </div>

          <div className="field">
            <label>Per-agent models (optional)</label>
            <div className="field-hint">Override which model each agent uses. Leave blank to inherit the main or fast model.</div>
            {['orchestrator', 'planner', 'coder', 'reviewer', 'debugger', 'researcher'].map((agent) => (
              <div key={agent} className="subagent-model-row">
                <span className="subagent-model-name">{agent}</span>
                <input
                  placeholder={agent === 'coder' || agent === 'debugger' || agent === 'orchestrator' ? model : fastModel}
                  value={subModels[agent] ?? ''}
                  onChange={(e) => setSubModels({ ...subModels, [agent]: e.target.value })}
                />
              </div>
            ))}
          </div>

          <div className="field">
            <label>MCP servers</label>
            <div className="field-hint">Add Model Context Protocol servers (e.g. Playwright, Chrome DevTools) to give the agent browser/UI tools.</div>
            {mcpServers.map((srv, i) => (
              <div key={srv.id} className="mcp-row">
                <input
                  placeholder="Name"
                  value={srv.name}
                  onChange={(e) => {
                    const next = [...mcpServers]
                    next[i] = { ...srv, name: e.target.value }
                    setMcpServers(next)
                  }}
                />
                <input
                  placeholder="Command (e.g. npx @anthropic-ai/mcp-playwright)"
                  value={srv.command}
                  onChange={(e) => {
                    const next = [...mcpServers]
                    next[i] = { ...srv, command: e.target.value }
                    setMcpServers(next)
                  }}
                />
                <label className="toggle mini">
                  <input type="checkbox" checked={srv.enabled} onChange={(e) => {
                    const next = [...mcpServers]
                    next[i] = { ...srv, enabled: e.target.checked }
                    setMcpServers(next)
                  }} />
                  <span className="toggle-track"><span className="toggle-thumb" /></span>
                </label>
                <button className="icon-btn" onClick={() => setMcpServers(mcpServers.filter((_, idx) => idx !== i))} title="Remove">
                  <Icon name="x" size={12} />
                </button>
              </div>
            ))}
            <div className="preset-row">
              <button className="btn" onClick={() => setMcpServers([...mcpServers, { id: Math.random().toString(36).slice(2, 10), name: '', command: '', enabled: true, args: [], env: {}, timeout: 30000 }])}>
                <Icon name="plus" size={12} /> Add MCP server
              </button>
              <button className="btn" onClick={() => {
                const next = [...mcpServers]
                if (!next.some((s) => s.name === 'playwright')) {
                  next.push({ id: Math.random().toString(36).slice(2, 10), name: 'playwright', command: 'npx', args: ['-y', '@anthropic-ai/mcp-playwright'], enabled: true, env: {}, timeout: 60000 })
                }
                setMcpServers(next)
              }}>
                <Icon name="plus" size={12} /> Add Playwright preset
              </button>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className={`btn primary ${saved ? 'saved' : ''}`} onClick={() => void save()}>
            {saved ? <><Icon name="check" size={12} /> Saved</> : 'Save settings'}
          </button>
        </div>
      </div>
    </div>
  )
}