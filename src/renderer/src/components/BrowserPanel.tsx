import { useEffect, useRef, useState } from 'react'
import { Icon } from './ui'

export function BrowserPanel({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState('https://ollama.com')
  const [current, setCurrent] = useState('https://ollama.com')
  const webviewRef = useRef<Electron.WebviewTag>(null)

  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    const onNav = () => setCurrent(wv.getURL())
    wv.addEventListener('did-navigate', onNav)
    wv.addEventListener('did-navigate-in-page', onNav)
    return () => {
      wv.removeEventListener('did-navigate', onNav)
      wv.removeEventListener('did-navigate-in-page', onNav)
    }
  }, [])

  const go = (u: string) => {
    const target = normalizeUrl(u)
    setUrl(target)
    setCurrent(target)
    if (webviewRef.current) webviewRef.current.src = target
  }

  return (
    <div className="browser-panel">
      <div className="browser-toolbar">
        <div className="browser-nav">
          <button className="icon-btn" title="Back" onClick={() => webviewRef.current?.goBack()}>
            <Icon name="chevronLeft" size={13} />
          </button>
          <button className="icon-btn" title="Forward" onClick={() => webviewRef.current?.goForward()}>
            <Icon name="chevronRight" size={13} />
          </button>
          <button className="icon-btn" title="Reload" onClick={() => webviewRef.current?.reload()}>
            <Icon name="refresh" size={12} />
          </button>
        </div>
        <input
          className="browser-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') go(url) }}
          placeholder="Enter a URL or search…"
          spellCheck={false}
        />
        <button className="btn" onClick={() => go(url)}>Go</button>
        <button className="icon-btn" title="Open in system browser" onClick={() => void window.meencode.openExternal(current)}>
          <Icon name="external" size={13} />
        </button>
        <button className="icon-btn" title="Close browser (Ctrl+Alt+B)" onClick={onClose}>
          <Icon name="x" size={13} />
        </button>
      </div>
      <webview
        ref={webviewRef}
        src={normalizeUrl(current)}
        className="browser-webview"
        partition="meencode-browser"
        allowpopups={'true' as any}
      />
    </div>
  )
}

function normalizeUrl(input: string): string {
  const t = input.trim()
  if (!t) return 'https://ollama.com'
  if (/^https?:\/\//i.test(t)) return t
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(t)) return `https://${t}`
  return `https://duckduckgo.com/?q=${encodeURIComponent(t)}`
}