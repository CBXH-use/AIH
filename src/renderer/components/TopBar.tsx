import { Bot, Check, ChevronDown, HardDrive, MessageSquare, Plus, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react'
import { useAppStore, useCurrentSession, modelRefOf } from '../store'
import { useT } from '../i18n'
import { Dropdown, Spinner, AgentIcon } from './ui'
import type { PermissionMode } from '@shared/types'

const PERM_ORDER: PermissionMode[] = ['readonly', 'ask', 'auto-safe', 'full']

export function TopBar({ onRequestFullAccess }: { onRequestFullAccess: () => void }) {
  const t = useT()
  const session = useCurrentSession()
  const page = useAppStore((s) => s.page)
  const agents = useAppStore((s) => s.agents)
  const models = useAppStore((s) => s.models)
  const providers = useAppStore((s) => s.providers)
  const scanning = useAppStore((s) => s.scanning)
  const setPage = useAppStore((s) => s.setPage)
  const newSession = useAppStore((s) => s.newSession)
  const patchSession = useAppStore((s) => s.patchSession)
  const setPermission = useAppStore((s) => s.setPermission)
  const scanModels = useAppStore((s) => s.scanModels)

  const sessionMode = session?.mode || (page === 'chat' ? 'chat' : 'task')
  const isChat = sessionMode === 'chat'
  const agent = agents.find((a) => a.id === session?.agentId) || agents[0]
  const model = session?.model || null
  const perm = session?.permissionMode || 'ask'
  const matched = models.find((m) => m.providerId === model?.providerId && m.remoteId === model?.modelId)
  const modelBadge = matched?.parameterSize?.toUpperCase() || (model ? (providers.find((p) => p.id === model.providerId)?.isLocal ? 'LOCAL' : 'API') : '')
  const online = providers.some((p) => p.state === 'online')
  const providerName = (id: string) => providers.find((p) => p.id === id)?.name || id

  const chooseModel = async (m: (typeof models)[number]) => {
    const ref = modelRefOf(m)
    if (!session) {
      const created = await newSession({ mode: sessionMode })
      if (created) await patchSession(created.id, { model: ref })
    } else {
      await patchSession(session.id, { model: ref })
    }
  }

  const chooseAgent = async (id: string) => {
    if (session) await patchSession(session.id, { agentId: id })
    else await newSession({ agentId: id })
  }

  const choosePerm = async (mode: PermissionMode) => {
    if (mode === 'full') {
      onRequestFullAccess()
      return
    }
    await setPermission(mode)
  }

  return (
    <div className="topbar">
      <div className="topbar-left">
        <button
          className="icon-btn round"
          onClick={() => void newSession({ mode: sessionMode })}
          title={isChat ? t('top.newChat') : t('top.newTask')}
        >
          <Plus size={18} strokeWidth={2.2} />
        </button>
        <span className={`mode-chip ${isChat ? 'chat' : 'task'}`}>
          {isChat ? <MessageSquare size={11} /> : <Sparkles size={11} />}
          {isChat ? t('chat.modeChat') : t('chat.modeTask')}
        </span>
        {!isChat && (
          <>
            <div className="topbar-sep" />
            <Dropdown
              width={300}
              button={
                <button className={`top-pill ${perm === 'full' ? 'danger' : ''}`}>
                  <ShieldCheck size={15} />
                  <span>{t(`perm.${perm}`)}</span>
                  <ChevronDown size={14} className="chev" />
                </button>
              }
            >
              {(close) => (
                <div className="menu">
                  <div className="menu-label">{t('top.permissionHint')}</div>
                  {PERM_ORDER.map((mode) => (
                    <button
                      key={mode}
                      className={`menu-item ${mode === perm ? 'selected' : ''} ${mode === 'full' ? 'danger-text' : ''}`}
                      onClick={() => {
                        close()
                        void choosePerm(mode)
                      }}
                    >
                      <div className="menu-item-check">{mode === perm && <Check size={14} />}</div>
                      <div className="menu-item-body">
                        <div className="menu-item-title">
                          {t(`perm.${mode}`)}
                          {mode === 'full' && <span className="badge red tiny">{t('perm.fullBadge')}</span>}
                        </div>
                        <div className="menu-item-desc">{t(`perm.${mode}.d`)}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </Dropdown>

            <Dropdown
              width={320}
              button={
                <button className="top-pill">
                  <Bot size={15} />
                  <span>{agent?.name || t('top.agent')}</span>
                  <ChevronDown size={14} className="chev" />
                </button>
              }
            >
              {(close) => (
                <div className="menu">
                  <div className="menu-label">{t('top.switchAgent')}</div>
                  <div className="menu-scroll">
                    {agents.map((a) => (
                      <button
                        key={a.id}
                        className={`menu-item ${a.id === session?.agentId ? 'selected' : ''}`}
                        onClick={() => {
                          close()
                          void chooseAgent(a.id)
                        }}
                      >
                        <span className="menu-emoji">
                          <AgentIcon icon={a.icon} size={17} />
                        </span>
                        <div className="menu-item-body">
                          <div className="menu-item-title">{a.name}</div>
                          <div className="menu-item-desc">{a.description}</div>
                        </div>
                        {a.id === session?.agentId && <Check size={14} />}
                      </button>
                    ))}
                  </div>
                  <button
                    className="menu-footer"
                    onClick={() => {
                      close()
                      setPage('agents')
                    }}
                  >
                    <Sparkles size={14} /> {t('top.manageAgents')}
                  </button>
                </div>
              )}
            </Dropdown>
          </>
        )}
      </div>

      <div className="topbar-right">
        <Dropdown
          align="right"
          width={360}
          button={
            <button className={`model-pill ${!model ? 'muted' : ''}`}>
              {online && <span className="online-dot" />}
              <span className="model-name">{model?.label || t('top.noModel')}</span>
              {modelBadge && <span className="model-badge">{modelBadge}</span>}
              <ChevronDown size={14} className="chev" />
            </button>
          }
        >
          {(close) => (
            <div className="menu">
              <div className="menu-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{t('top.modelHint')}</span>
                <button className="mini-action" onClick={() => void scanModels({ quick: true })}>
                  {scanning ? <Spinner size={12} /> : <RefreshCw size={12} />}
                  {t('top.refreshModels')}
                </button>
              </div>
              <div className="menu-scroll" style={{ maxHeight: 360 }}>
                {models.filter((m) => m.providerId !== 'local-files').length === 0 && (
                  <div className="menu-empty">
                    <HardDrive size={18} />
                    <div>
                      <div>{t('chat.noModelHint')}</div>
                      <button
                        className="link-btn"
                        onClick={() => {
                          close()
                          setPage('models')
                        }}
                      >
                        {t('models.addApiShort')} →
                      </button>
                    </div>
                  </div>
                )}
                {models
                  .filter((m) => m.providerId !== 'local-files')
                  .map((m) => {
                  const active = m.providerId === model?.providerId && m.remoteId === model?.modelId
                  return (
                    <button
                      key={m.id}
                      className={`menu-item model-item ${active ? 'selected' : ''}`}
                      onClick={() => {
                        close()
                        void chooseModel(m)
                      }}
                    >
                      <div className="model-avatar">{m.name.slice(0, 1).toUpperCase()}</div>
                      <div className="menu-item-body">
                        <div className="menu-item-title">{m.name}</div>
                        <div className="menu-item-desc">
                          {providerName(m.providerId)}
                          {m.parameterSize ? ` · ${m.parameterSize}` : ''}
                          {m.quantization ? ` · ${m.quantization}` : ''}
                        </div>
                      </div>
                      {active && <Check size={14} />}
                    </button>
                  )
                })}
              </div>
              <button
                className="menu-footer"
                onClick={() => {
                  close()
                  setPage('models')
                }}
              >
                <HardDrive size={14} /> {t('top.manageModels')}
              </button>
            </div>
          )}
        </Dropdown>
      </div>
    </div>
  )
}
