import { useMemo, useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  BookOpen,
  Bot,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Home,
  ListChecks,
  MessageSquare,
  Plus,
  Puzzle,
  Search,
  Settings,
  Trash2,
  WifiOff
} from 'lucide-react'
import { useAppStore, type Page } from '../store'
import { useT } from '../i18n'
import { AgentIcon, Modal } from './ui'

const NAV: { page: Page; icon: typeof MessageSquare; label: string }[] = [
  { page: 'chat', icon: MessageSquare, label: 'sidebar.chat' },
  { page: 'task', icon: ListChecks, label: 'sidebar.tasks' },
  { page: 'plugins', icon: Puzzle, label: 'sidebar.plugins' },
  { page: 'models', icon: HardDrive, label: 'sidebar.models' },
  { page: 'knowledge', icon: BookOpen, label: 'sidebar.knowledge' },
  { page: 'agents', icon: Bot, label: 'sidebar.agents' }
]

function timeLabel(ts: number, t: (k: string, v?: Record<string, string | number>) => string): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return t('sidebar.justNow')
  if (diff < 3_600_000) return t('sidebar.minutesAgo', { n: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t('sidebar.hoursAgo', { n: Math.floor(diff / 3_600_000) })
  if (diff < 7 * 86_400_000) return t('sidebar.daysAgo', { n: Math.floor(diff / 86_400_000) })
  return new Date(ts).toLocaleDateString()
}

export function Sidebar() {
  const t = useT()
  const sessions = useAppStore((s) => s.sessions)
  const projects = useAppStore((s) => s.projects)
  const currentId = useAppStore((s) => s.currentId)
  const activeProjectId = useAppStore((s) => s.activeProjectId)
  const showArchived = useAppStore((s) => s.showArchived)
  const page = useAppStore((s) => s.page)
  const agents = useAppStore((s) => s.agents)
  const providers = useAppStore((s) => s.providers)
  const assistantAvatar = useAppStore((s) => s.settings.ui?.assistantAvatar)
  const setPage = useAppStore((s) => s.setPage)
  const selectSession = useAppStore((s) => s.selectSession)
  const selectProject = useAppStore((s) => s.selectProject)
  const setShowArchived = useAppStore((s) => s.setShowArchived)
  const newSession = useAppStore((s) => s.newSession)
  const deleteSession = useAppStore((s) => s.deleteSession)
  const archiveSession = useAppStore((s) => s.archiveSession)
  const createProject = useAppStore((s) => s.createProject)
  const archiveProject = useAppStore((s) => s.archiveProject)
  const openProjectFolder = useAppStore((s) => s.openProjectFolder)
  const [query, setQuery] = useState('')
  const [projectModal, setProjectModal] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [projectDesc, setProjectDesc] = useState('')
  const [projectPath, setProjectPath] = useState('')
  const [showArchivedProjects, setShowArchivedProjects] = useState(false)

  const activeProject = projects.find((p) => p.id === activeProjectId) || projects.find((p) => !p.archived)
  const visibleProjects = projects.filter((p) => !p.archived)
  const archivedProjects = projects.filter((p) => p.archived)
  const listMode = page === 'chat' ? 'chat' : 'task'

  const projectSessions = useMemo(
    () =>
      sessions
        .filter(
          (s) =>
            s.projectId === activeProjectId &&
            (s.mode === 'chat' ? 'chat' : 'task') === listMode &&
            (showArchived ? s.archived : !s.archived)
        )
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions, activeProjectId, showArchived, listMode]
  )

  const filtered = useMemo(() => {
    if (!query.trim()) return projectSessions
    const q = query.toLowerCase()
    return projectSessions.filter((s) => s.title.toLowerCase().includes(q))
  }, [projectSessions, query])

  const onlineCount = providers.filter((p) => p.state === 'online').length
  const countFor = (id: string) => sessions.filter((s) => s.projectId === id && !s.archived).length

  const submitProject = async () => {
    if (!projectName.trim()) return
    const project = await createProject({
      name: projectName.trim(),
      description: projectDesc.trim(),
      path: projectPath.trim() || undefined
    })
    if (project) {
      setProjectModal(false)
      setProjectName('')
      setProjectDesc('')
      setProjectPath('')
      await newSession({ projectId: project.id })
    }
  }

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">{assistantAvatar ? <img src={assistantAvatar} alt="AIH" /> : 'A'}</div>
        <div className="brand-text">
          <strong>AIH</strong>
          <span>AI HOUSE</span>
        </div>
      </div>

      <button className="new-task" onClick={() => void newSession({ mode: 'task' })}>
        <Plus size={16} strokeWidth={2.4} />
        <span>{t('sidebar.newTask')}</span>
        <kbd>Ctrl N</kbd>
      </button>

      <nav className="side-nav">
        {NAV.map((item) => {
          const Icon = item.icon
          const active = page === item.page
          return (
            <button
              key={item.page}
              className={`side-nav-item ${active ? 'active' : ''}`}
              onClick={() => {
                if (item.page === 'chat' || item.page === 'task') {
                  const current = sessions.find((s) => s.id === currentId)
                  const currentMode = current?.mode === 'chat' ? 'chat' : 'task'
                  if (!current || currentMode !== item.page) {
                    const first = sessions
                      .filter(
                        (s) =>
                          s.projectId === activeProjectId &&
                          !s.archived &&
                          (s.mode === 'chat' ? 'chat' : 'task') === item.page
                      )
                      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
                    if (first) selectSession(first.id)
                    else useAppStore.setState({ currentId: null, page: item.page })
                  } else {
                    setPage(item.page)
                  }
                  return
                }
                setPage(item.page)
              }}
            >
              <Icon size={16} />
              <span>{t(item.label)}</span>
              {item.page === 'plugins' && <span className="nav-dot" />}
            </button>
          )
        })}
      </nav>

      <div className="side-section projects-section">
        <div className="side-section-head">
          <span>{t('sidebar.projects')}</span>
          <button className="side-add" title={t('sidebar.newProject')} onClick={() => setProjectModal(true)}>
            <FolderPlus size={13} />
          </button>
        </div>
        <div className="project-list">
          {visibleProjects.map((p) => (
            <div
              key={p.id}
              className={`project-item ${p.id === activeProjectId ? 'active' : ''}`}
              onClick={() => selectProject(p.id)}
              title={p.path}
            >
              <span className="project-ico">{p.id === 'default' ? <Home size={13} /> : <FolderOpen size={13} />}</span>
              <span className="project-name">{p.id === 'default' ? t('sidebar.defaultProject') : p.name}</span>
              <span className="project-count">{countFor(p.id)}</span>
              <span className="project-actions">
                <button
                  title={t('sidebar.openFolder')}
                  onClick={(e) => {
                    e.stopPropagation()
                    void openProjectFolder(p.id)
                  }}
                >
                  <FolderOpen size={12} />
                </button>
                {p.id !== 'default' && (
                  <button
                    title={t('sidebar.archiveProject')}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (window.confirm(t('project.archiveConfirm', { name: p.name }))) void archiveProject(p.id, true)
                    }}
                  >
                    <Archive size={12} />
                  </button>
                )}
              </span>
            </div>
          ))}
          {archivedProjects.length > 0 && (
            <button className="archived-toggle" onClick={() => setShowArchivedProjects((v) => !v)}>
              <Archive size={12} />
              {t('sidebar.archivedProjects')} ({archivedProjects.length})
            </button>
          )}
          {showArchivedProjects &&
            archivedProjects.map((p) => (
              <div className="project-item archived" key={p.id} title={p.path}>
                <span className="project-ico">
                  <Archive size={12} />
                </span>
                <span className="project-name">{p.name}</span>
                <button
                  className="restore-btn"
                  title={t('sidebar.restoreProject')}
                  onClick={() => void archiveProject(p.id, false)}
                >
                  <ArchiveRestore size={12} />
                </button>
              </div>
            ))}
        </div>
      </div>

      <div className="side-section">
        <div className="side-section-head">
          <span>
            {showArchived
              ? t('sidebar.archived')
              : listMode === 'chat'
                ? t('sidebar.recentChats')
                : t('sidebar.recentTasks')}
          </span>
          <span className="side-head-right">
            <span className="side-count">{projectSessions.length}</span>
            {listMode === 'chat' && !showArchived && (
              <button
                className="side-add"
                title={t('sidebar.newChat')}
                onClick={() => void newSession({ mode: 'chat' })}
              >
                <Plus size={13} />
              </button>
            )}
            <button
              className={`side-add ${showArchived ? 'active' : ''}`}
              title={showArchived ? t('sidebar.hideArchived') : t('sidebar.showArchived')}
              onClick={() => setShowArchived(!showArchived)}
            >
              <Archive size={13} />
            </button>
          </span>
        </div>
        <div className="side-search">
          <Search size={13} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('common.search')} />
        </div>
      </div>

      <div className="session-list">
        {filtered.length === 0 && (
          <div className="side-empty">
            {showArchived
              ? t('sidebar.noArchived')
              : listMode === 'chat'
                ? t('sidebar.emptyChats')
                : t('sidebar.emptyTasks')}
          </div>
        )}
        {filtered.map((s) => (
          <div
            key={s.id}
            className={`session-item ${s.id === currentId && (page === 'chat' || page === 'task') ? 'active' : ''}`}
            onClick={() => selectSession(s.id)}
          >
            <span className="session-icon">
              {s.mode === 'chat' ? (
                <MessageSquare size={13} />
              ) : (
                <AgentIcon icon={agents.find((a) => a.id === s.agentId)?.icon || '✳️'} size={14} />
              )}
            </span>
            <div className="session-main">
              <div className="session-title">{s.title || t('sidebar.newTask')}</div>
              <div className="session-meta">
                {s.status === 'running' && <span className="pulse-dot" />}
                {s.status === 'waiting-approval' && <span className="pulse-dot amber" />}
                {s.status === 'error' && <span className="pulse-dot red" />}
                <span>{timeLabel(s.updatedAt, t)}</span>
                <span className="session-mode-tag">{s.mode === 'chat' ? t('chat.modeChat') : t('chat.modeTask')}</span>
              </div>
            </div>
            <button
              className="session-del"
              onClick={(e) => {
                e.stopPropagation()
                void archiveSession(s.id, !s.archived)
              }}
              title={s.archived ? t('sidebar.restoreSession') : t('sidebar.archiveSession')}
            >
              {s.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
            </button>
            <button
              className="session-del"
              onClick={(e) => {
                e.stopPropagation()
                if (window.confirm(t('sidebar.deleteConfirm', { title: s.title }))) void deleteSession(s.id)
              }}
              title={t('common.delete')}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>

      <div className="side-footer">
        <button className="provider-chip" onClick={() => setPage('models')}>
          <span className={`state-dot ${onlineCount ? 'on' : 'off'}`} />
          {onlineCount ? (
            <span>{t('sidebar.servicesOnline', { n: onlineCount })}</span>
          ) : (
            <>
              <WifiOff size={12} />
              <span>{t('sidebar.localFirst')}</span>
            </>
          )}
        </button>
        <button className="side-nav-item" onClick={() => setPage('settings')}>
          <Settings size={16} />
          <span>{t('sidebar.settings')}</span>
        </button>
      </div>

      <Modal open={projectModal} onClose={() => setProjectModal(false)} width={500}>
        <h2 className="modal-title">{t('project.createTitle')}</h2>
        <p className="modal-desc">{t('project.createDesc')}</p>
        <div className="form">
          <label>
            <span>{t('project.name')}</span>
            <input
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder={t('project.namePlaceholder')}
              autoFocus
            />
          </label>
          <label>
            <span>{t('project.description')}</span>
            <input value={projectDesc} onChange={(e) => setProjectDesc(e.target.value)} placeholder={t('common.optional')} />
          </label>
          <label>
            <span>{t('project.folder')}</span>
            <div className="input-with-button">
              <input value={projectPath} onChange={(e) => setProjectPath(e.target.value)} placeholder={t('project.folderPlaceholder')} />
              <button
                className="btn ghost sm"
                onClick={async () => {
                  const folder = await window.aih.pickFolder()
                  if (folder) setProjectPath(folder)
                }}
              >
                <FolderOpen size={13} />
              </button>
            </div>
            <em>{t('project.folderHint')}</em>
          </label>
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => setProjectModal(false)}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" onClick={() => void submitProject()} disabled={!projectName.trim()}>
            <FolderPlus size={14} /> {t('project.create')}
          </button>
        </div>
      </Modal>
    </aside>
  )
}
