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

  useEffect(() => {
    if (!open) return
    setApiKey(settings?.apiKey ?? '')
    setBaseUrl(settings?.baseUrl ?? 'https://ollama.com')
    setModel(settings?.model ?? 'glm-5.3-flash')
    setFastModel(settings?.fastModel || settings?.model || 'glm-5.3-flash')
    setMaxIter(settings?.maxIterations ?? 30)
    setAutoRun(settings?.autoRunCommands ?? false)
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
    await window.meencode.settings.update({ apiKey, baseUrl, model, fastModel, maxIterations: maxIter, autoRunCommands: autoRun })
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