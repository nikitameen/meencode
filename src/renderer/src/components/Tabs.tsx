import { useStore } from '../store'
import { languageFor } from '../store'
import { Icon } from './ui'

export function Tabs() {
  const tabs = useStore((s) => s.tabs)
  const activeTab = useStore((s) => s.activeTab)
  const setActiveTab = useStore((s) => s.setActiveTab)
  const closeTab = useStore((s) => s.closeTab)
  const markDirty = useStore((s) => s.markDirty)
  const saveActiveTab = useStore((s) => s.saveActiveTab)

  return (
    <div className="tabs">
      <div className="tab-strip">
        {tabs.map((t) => (
          <div
            key={t.path}
            className={`tab ${activeTab === t.path ? 'active' : ''}`}
            onClick={() => setActiveTab(t.path)}
            onAuxClick={(e) => { if (e.button === 1) closeTab(t.path) }}
          >
            <span className={`lang-dot lang-${languageFor(t.path)}`} />
            <span className="tab-name" title={t.path}>
              {t.path.split('/').pop()}
            </span>
            {t.dirty && <span className="tab-dirty" title="Unsaved — Ctrl+S">•</span>}
            <button
              className="tab-close"
              onClick={(e) => { e.stopPropagation(); closeTab(t.path) }}
            >
              <Icon name="x" size={10} />
            </button>
          </div>
        ))}
      </div>
      <div className="tab-actions">
        {activeTab && (
          <>
            <button className="icon-btn" title="Save (Ctrl+S)" onClick={() => void saveActiveTab()}>
              <Icon name="check" />
            </button>
            <button
              className="icon-btn"
              title="Reveal in file explorer"
              onClick={() => void window.meencode.fs.reveal(activeTab)}
            >
              <Icon name="external" />
            </button>
          </>
        )}
      </div>
    </div>
  )
}