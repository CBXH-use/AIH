import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useAppStore, useCurrentSession } from './store'
import { useT } from './i18n'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { WindowTitleBar } from './components/WindowTitleBar'
import { ChatView } from './components/ChatView'
import { FullAccessModal } from './components/Approval'
import { Toasts } from './components/ui'
import { Onboarding } from './pages/Onboarding'
import { ModelsPage } from './pages/ModelsPage'
import { PluginsPage } from './pages/PluginsPage'
import { KnowledgePage } from './pages/KnowledgePage'
import { AgentsPage } from './pages/AgentsPage'
import { SettingsPage } from './pages/SettingsPage'

export default function App() {
  const t = useT()
  const ready = useAppStore((s) => s.ready)
  const page = useAppStore((s) => s.page)
  const settings = useAppStore((s) => s.settings)
  const init = useAppStore((s) => s.init)
  const newSession = useAppStore((s) => s.newSession)
  const session = useCurrentSession()
  const [fullOpen, setFullOpen] = useState(false)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    const offChat = window.aih.onChatEvent((e) => useAppStore.getState().handleChatEvent(e))
    const offScan = window.aih.onScanEvent((e) => useAppStore.getState().handleScanEvent(e))
    const offDeploy = window.aih.onDeployEvent((e) => useAppStore.getState().handleDeployEvent(e))
    const offApproval = window.aih.onApproval((req) => useAppStore.setState({ approval: req }))
    const offSettings = window.aih.onSettings((s) => useAppStore.setState({ settings: s }))
    return () => {
      offChat()
      offScan()
      offDeploy()
      offApproval()
      offSettings()
    }
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme || 'light'
    document.documentElement.lang = settings.language || 'zh'
    document.documentElement.dataset.fontsize = settings.ui?.fontSize || 'normal'
    document.documentElement.dataset.sidebar = settings.ui?.compactSidebar ? 'compact' : 'normal'
    document.documentElement.dataset.accent = settings.ui?.accent || 'sage'
  }, [
    settings.theme,
    settings.language,
    settings.ui?.fontSize,
    settings.ui?.compactSidebar,
    settings.ui?.accent
  ])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        const mode = e.shiftKey ? 'chat' : 'task'
        void newSession({ mode })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newSession])

  if (!ready) {
    return (
      <div className="app-shell">
        <WindowTitleBar />
        <div className="splash">
          <div className="brand-mark large">A</div>
          <div className="splash-name">AIH</div>
          <div className="splash-hint">AI HOUSE</div>
        </div>
      </div>
    )
  }

  if (!settings.onboardingDone) {
    return (
      <div className="app-shell">
        <WindowTitleBar />
        <Onboarding />
        <Toasts />
      </div>
    )
  }

  return (
    <div className="app-shell">
      <WindowTitleBar />
      <div className="app">
        <Sidebar />
        <main className="main">
          {(page === 'chat' || page === 'task') && (
            <>
              <TopBar onRequestFullAccess={() => setFullOpen(true)} />
              {session?.permissionMode === 'full' && session.mode !== 'chat' && (
                <div className="full-banner">
                  <AlertTriangle size={13} />
                  <span>{t('full.warning')}</span>
                  <button className="link-btn" onClick={() => setFullOpen(true)}>
                    {t('full.viewDetails')}
                  </button>
                </div>
              )}
              <ChatView />
            </>
          )}
          {page === 'models' && <ModelsPage />}
          {page === 'plugins' && <PluginsPage />}
          {page === 'knowledge' && <KnowledgePage />}
          {page === 'agents' && <AgentsPage />}
          {page === 'settings' && <SettingsPage />}
        </main>
      </div>
      <FullAccessModal open={fullOpen} onClose={() => setFullOpen(false)} />
      <Toasts />
    </div>
  )
}
