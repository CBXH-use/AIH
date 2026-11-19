import { useEffect, useState } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import { useAppStore } from '../store'
import { useT } from '../i18n'

export function WindowTitleBar() {
  const t = useT()
  const projects = useAppStore((s) => s.projects)
  const activeProjectId = useAppStore((s) => s.activeProjectId)
  const assistantAvatar = useAppStore((s) => s.settings.ui?.assistantAvatar)
  const [maximized, setMaximized] = useState(false)
  const project = projects.find((p) => p.id === activeProjectId)

  useEffect(() => {
    void window.aih.isWindowMaximized().then(setMaximized)
    return window.aih.onWindowMaximized(setMaximized)
  }, [])

  return (
    <div
      className="titlebar"
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('.titlebar-controls')) return
        void window.aih.windowToggleMaximize()
      }}
    >
      <div className="titlebar-brand">
        <span className="titlebar-mark">{assistantAvatar ? <img src={assistantAvatar} alt="" /> : 'A'}</span>
        <strong>AIH</strong>
        <span className="titlebar-sub">AI HOUSE</span>
      </div>
      <div className="titlebar-center">
        {project ? `${project.name} · ${project.path}` : t('app.tagline')}
      </div>
      <div className="titlebar-controls">
        <button onClick={() => void window.aih.windowMinimize()} title={t('window.minimize')}>
          <Minus size={14} />
        </button>
        <button onClick={() => void window.aih.windowToggleMaximize()} title={maximized ? t('window.restore') : t('window.maximize')}>
          {maximized ? <Copy size={12} /> : <Square size={11} />}
        </button>
        <button className="close" onClick={() => void window.aih.windowClose()} title={t('window.close')}>
          <X size={15} />
        </button>
      </div>
    </div>
  )
}
