import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BrainCircuit,
  Cpu,
  Database,
  FolderOpen,
  FlaskConical,
  History,
  ImagePlus,
  Info,
  Layers,
  Palette,
  Plug,
  Save,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  RotateCcw,
  Sparkles,
  Trash2
} from 'lucide-react'
import type { EvalEvent, EvalReport, EvalTaskInfo } from '@shared/eval'
import type { HarnessConfig, PermissionMode, ThinkingConfig } from '@shared/types'
import type { UpdateCheckResult, UpdatePhase } from '@shared/ipc'
import { useAppStore } from '../store'
import { useT } from '../i18n'
import { Badge, imageFileToDataUrl, PageHeader, Switch } from '../components/ui'

type Section = 'general' | 'harness' | 'context' | 'safety' | 'eval' | 'data' | 'snapshots' | 'about'

export function SettingsPage() {
  const t = useT()
  const settings = useAppStore((s) => s.settings)
  const info = useAppStore((s) => s.info)
  const hardware = useAppStore((s) => s.hardware)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const saveSnapshot = useAppStore((s) => s.saveSnapshot)
  const restoreSnapshot = useAppStore((s) => s.restoreSnapshot)
  const setPermission = useAppStore((s) => s.setPermission)
  const updateProject = useAppStore((s) => s.updateProject)
  const setPage = useAppStore((s) => s.setPage)
  const session = useAppStore((s) => s.sessions.find((x) => x.id === s.currentId) || null)
  const toast = useAppStore((s) => s.toast)

  const [section, setSection] = useState<Section>('general')
  const [draft, setDraft] = useState<HarnessConfig>(settings.harness)
  const [raw, setRaw] = useState(() => JSON.stringify(settings.harness, null, 2))
  const [snapshotLabel, setSnapshotLabel] = useState('')
  const [saving, setSaving] = useState(false)
  const [rawOpen, setRawOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const [update, setUpdate] = useState<UpdateCheckResult | null>(null)
  const [updatePhase, setUpdatePhase] = useState<UpdatePhase | 'idle'>('idle')
  const [updateProgress, setUpdateProgress] = useState(0)
  const [updateNote, setUpdateNote] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [evalTasks, setEvalTasks] = useState<EvalTaskInfo[]>([])
  const [evalRunning, setEvalRunning] = useState(false)
  const [evalProgress, setEvalProgress] = useState({ index: 0, total: 0 })
  const [evalReport, setEvalReport] = useState<EvalReport | null>(null)
  const [evalNote, setEvalNote] = useState<string | null>(null)
  const avatarInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void window.aih
      .listEvalTasks()
      .then((tasks) => setEvalTasks(tasks))
      .catch(() => undefined)
    const off = window.aih.onEvalEvent((e: EvalEvent) => {
      if (e.phase === 'start') {
        setEvalRunning(true)
        setEvalReport(null)
        setEvalProgress({ index: 0, total: e.total || 0 })
        setEvalNote(null)
      } else if (e.phase === 'task-start') {
        setEvalProgress({ index: e.index || 0, total: e.total || 0 })
        setEvalNote(e.title ? `${e.taskId} · ${e.title}` : null)
      } else if (e.phase === 'done' || e.phase === 'cancelled') {
        setEvalRunning(false)
        if (e.report) setEvalReport(e.report)
        if (e.message) setEvalNote(e.message)
      } else if (e.phase === 'error') {
        setEvalRunning(false)
        setEvalNote(e.message || null)
      }
    })
    return off
  }, [])

  const runEval = async () => {
    setEvalRunning(true)
    setEvalReport(null)
    setEvalNote(null)
    const res = await window.aih.runEval()
    if (!res.ok) {
      setEvalRunning(false)
      setEvalNote(res.error || t('settings.evalFailed'))
    } else if (res.data) {
      setEvalReport(res.data)
      setEvalRunning(false)
    }
  }

  const cancelEval = async () => {
    await window.aih.cancelEval()
  }

  useEffect(() => {
    let alive = true
    void window.aih
      .checkUpdate(false)
      .then((res) => {
        if (!alive || !res.ok || !res.data) return
        setUpdate(res.data)
        setUpdatePhase(res.data.hasUpdate ? 'available' : 'none')
      })
      .catch(() => undefined)
    const off = window.aih.onUpdateEvent((e) => {
      if (e.result) setUpdate(e.result)
      setUpdatePhase(e.phase)
      if (typeof e.progress === 'number') setUpdateProgress(e.progress)
      if (e.phase === 'error') setUpdateNote(e.message || null)
      else if (e.message) setUpdateNote(e.message)
      if (e.phase === 'installing') setInstalling(true)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  const checkUpdate = async (force = true) => {
    setChecking(true)
    setUpdateNote(null)
    try {
      const res = await window.aih.checkUpdate(force)
      if (!res.ok || !res.data) {
        setUpdateNote(res.error || t('settings.checkFailed'))
        setUpdatePhase('error')
        return
      }
      setUpdate(res.data)
      setUpdatePhase(res.data.hasUpdate ? 'available' : 'none')
      setUpdateNote(
        res.data.hasUpdate
          ? t('settings.updateFound', { version: res.data.latest })
          : t('settings.upToDate', { version: res.data.current })
      )
    } finally {
      setChecking(false)
    }
  }

  const downloadUpdate = async () => {
    setUpdateNote(null)
    const res = await window.aih.downloadUpdate()
    if (!res.ok) setUpdateNote(t('settings.updateFailed', { error: res.error || '' }))
  }

  const installUpdate = async () => {
    setInstalling(true)
    setUpdateNote(t('settings.updateInstalling'))
    const res = await window.aih.installUpdate()
    if (!res.ok) {
      setInstalling(false)
      setUpdateNote(t('settings.updateFailed', { error: res.error || '' }))
    }
  }

  useEffect(() => {
    setDraft(settings.harness)
    setRaw(JSON.stringify(settings.harness, null, 2))
  }, [settings.harness])

  const ui = settings.ui || {}
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(settings.harness), [draft, settings.harness])

  const patchDraft = (patch: Partial<HarnessConfig>) => setDraft((d) => ({ ...d, ...patch }))
  const thinking: ThinkingConfig = draft.thinking || {
    mode: 'auto',
    adaptive: true,
    budgetTokens: 2048,
    simpleTaskMaxChars: 60
  }
  const patchThinking = (patch: Partial<ThinkingConfig>) => patchDraft({ thinking: { ...thinking, ...patch } })
  const patchContext = (patch: Partial<HarnessConfig['context']>) =>
    setDraft((d) => ({ ...d, context: { ...d.context, ...patch } }))
  const patchSafety = (patch: Partial<HarnessConfig['safety']>) =>
    setDraft((d) => ({ ...d, safety: { ...d.safety, ...patch } }))

  const save = async () => {
    setSaving(true)
    try {
      await updateSettings({ harness: draft })
      toast(t('settings.saved'), 'success')
    } finally {
      setSaving(false)
    }
  }

  const patchUi = (patch: typeof ui) => void updateSettings({ ui: { ...ui, ...patch } })

  const pickAvatar = async (file?: File) => {
    if (!file) return
    try {
      const dataUrl = await imageFileToDataUrl(file, 256)
      patchUi({ assistantAvatar: dataUrl })
      toast(t('settings.avatarUpdated'), 'success')
    } catch {
      toast(t('settings.avatarFailed'), 'error')
    }
  }

  const chooseDefaultWorkspace = async () => {
    const folder = await window.aih.pickFolder()
    if (!folder) return
    await updateSettings({ defaultWorkspaceDir: folder })
    await updateProject('default', { path: folder })
    toast(t('settings.saved'), 'success')
  }

  const applyRaw = () => {
    try {
      const parsed = JSON.parse(raw) as HarnessConfig
      if (!parsed.context || !parsed.safety || typeof parsed.maxSteps !== 'number') throw new Error('invalid')
      setDraft(parsed)
      setRawOpen(false)
      toast(t('settings.jsonApplied'), 'success')
    } catch {
      toast(t('settings.invalidJson'), 'error')
    }
  }

  const rawHarness = JSON.stringify(draft, null, 2)

  const nav: { id: Section; icon: typeof SlidersHorizontal; label: string }[] = [
    { id: 'general', icon: SlidersHorizontal, label: t('settings.nav.general') },
    { id: 'harness', icon: BrainCircuit, label: t('settings.nav.harness') },
    { id: 'context', icon: Layers, label: t('settings.nav.context') },
    { id: 'safety', icon: ShieldCheck, label: t('settings.nav.safety') },
    { id: 'eval', icon: FlaskConical, label: t('settings.nav.eval') },
    { id: 'data', icon: Database, label: t('settings.nav.data') },
    { id: 'snapshots', icon: History, label: t('settings.nav.snapshots') },
    { id: 'about', icon: Info, label: t('settings.nav.about') }
  ]

  const saveBar = (
    <div className="save-row">
      <span className={`dirty-dot ${dirty ? 'on' : ''}`} />
      <span className="muted small">{dirty ? t('settings.unsaved') : t('common.saved')}</span>
      <span className="spacer" />
      <button
        className="btn ghost"
        onClick={() => {
          setDraft(settings.harness)
          setRaw(JSON.stringify(settings.harness, null, 2))
        }}
        disabled={!dirty}
      >
        <RotateCcw size={13} /> {t('settings.revert')}
      </button>
      <button className="btn primary" onClick={() => void save()} disabled={!dirty || saving}>
        <Save size={13} /> {t('common.save')}
      </button>
    </div>
  )

  return (
    <div className="page settings-page">
      <PageHeader title={t('settings.title')} subtitle={t('app.tagline')} />

      <div className="settings-layout">
        <aside className="settings-nav">
          {nav.map((n) => {
            const Icon = n.icon
            return (
              <button
                key={n.id}
                className={`settings-nav-item ${section === n.id ? 'active' : ''}`}
                onClick={() => setSection(n.id)}
              >
                <Icon size={15} />
                <span>{n.label}</span>
              </button>
            )
          })}
          <div className="settings-nav-foot">
            <span className="state-dot on" />
            AIH {info?.version || '0.1.0'}
          </div>
        </aside>

        <div className="settings-content">
          {section === 'general' && (
            <>
              <section className="card">
                <div className="card-head">
                  <Palette size={16} />
                  <h2>{t('settings.appearance')}</h2>
                </div>
                <div className="form grid2">
                  <label>
                    <span>{t('settings.language')}</span>
                    <select
                      value={settings.language}
                      onChange={(e) => void updateSettings({ language: e.target.value as 'zh' | 'en' })}
                    >
                      <option value="zh">简体中文</option>
                      <option value="en">English</option>
                    </select>
                  </label>
                  <label>
                    <span>{t('settings.theme')}</span>
                    <select value={settings.theme} onChange={(e) => void updateSettings({ theme: e.target.value as 'light' | 'dark' })}>
                      <option value="light">{t('settings.light')}</option>
                      <option value="dark">{t('settings.dark')}</option>
                    </select>
                  </label>
                  <label>
                    <span>{t('settings.fontSize')}</span>
                    <select value={ui.fontSize || 'normal'} onChange={(e) => patchUi({ fontSize: e.target.value as 'small' | 'normal' | 'large' })}>
                      <option value="small">{t('settings.fontSmall')}</option>
                      <option value="normal">{t('settings.fontNormal')}</option>
                      <option value="large">{t('settings.fontLarge')}</option>
                    </select>
                  </label>
                  <label>
                    <span>{t('settings.accent')}</span>
                    <select
                      value={ui.accent || 'sage'}
                      onChange={(e) =>
                        patchUi({
                          accent: e.target.value as NonNullable<typeof ui.accent>
                        })
                      }
                    >
                      <option value="sage">{t('settings.accent.sage')}</option>
                      <option value="blue">{t('settings.accent.blue')}</option>
                      <option value="violet">{t('settings.accent.violet')}</option>
                      <option value="amber">{t('settings.accent.amber')}</option>
                      <option value="rose">{t('settings.accent.rose')}</option>
                      <option value="graphite">{t('settings.accent.graphite')}</option>
                    </select>
                  </label>
                  <label className="span2">
                    <span>{t('settings.assistantAvatar')}</span>
                    <div className="settings-avatar-row">
                      <div className="settings-avatar-preview">
                        {ui.assistantAvatar ? <img src={ui.assistantAvatar} alt="AIH" /> : <span>A</span>}
                      </div>
                      <button className="btn ghost sm" onClick={() => avatarInputRef.current?.click()}>
                        <ImagePlus size={13} /> {t('settings.uploadAvatar')}
                      </button>
                      {ui.assistantAvatar && (
                        <button className="btn ghost sm" onClick={() => patchUi({ assistantAvatar: '' })}>
                          <Trash2 size={13} /> {t('settings.resetAvatar')}
                        </button>
                      )}
                      <input
                        ref={avatarInputRef}
                        type="file"
                        accept="image/*"
                        hidden
                        onChange={(e) => {
                          void pickAvatar(e.target.files?.[0])
                          e.target.value = ''
                        }}
                      />
                    </div>
                    <em>{t('settings.assistantAvatarHint')}</em>
                  </label>
                  <label className="switch-line">
                    <span>{t('settings.compactSidebar')}</span>
                    <Switch checked={!!ui.compactSidebar} onChange={(v) => patchUi({ compactSidebar: v })} />
                  </label>
                  <label className="switch-line">
                    <span>{t('settings.showReasoning')}</span>
                    <Switch checked={ui.showReasoning !== false} onChange={(v) => patchUi({ showReasoning: v })} />
                  </label>
                  <label className="switch-line">
                    <span>{t('settings.showToken')}</span>
                    <Switch checked={ui.showTokenUsage !== false} onChange={(v) => patchUi({ showTokenUsage: v })} />
                  </label>
                  <label className="switch-line span2">
                    <span>{t('settings.sendOnEnter')}</span>
                    <Switch checked={ui.sendOnEnter !== false} onChange={(v) => patchUi({ sendOnEnter: v })} />
                  </label>
                </div>
              </section>

              <section className="card">
                <div className="card-head">
                  <Sparkles size={16} />
                  <h2>{t('settings.workflow')}</h2>
                </div>
                <div className="form grid2">
                  <label>
                    <span>{t('settings.defaultPermission')}</span>
                    <select
                      value={settings.defaultPermissionMode || 'ask'}
                      onChange={(e) => void updateSettings({ defaultPermissionMode: e.target.value as PermissionMode })}
                    >
                      <option value="readonly">{t('perm.readonly')}</option>
                      <option value="ask">{t('perm.ask')}</option>
                      <option value="auto-safe">{t('perm.auto-safe')}</option>
                      <option value="full">{t('perm.full')}</option>
                    </select>
                  </label>
                  <label className="switch-line">
                    <span>{t('settings.autoTitle')}</span>
                    <Switch checked={draft.autoTitle !== false} onChange={(v) => patchDraft({ autoTitle: v })} />
                  </label>
                  <label className="span2">
                    <span>{t('settings.defaultWorkspace')}</span>
                    <div className="input-with-button">
                      <input value={settings.defaultWorkspaceDir || ''} readOnly placeholder={t('settings.defaultWorkspace')} />
                      <button className="btn ghost sm" onClick={() => void chooseDefaultWorkspace()}>
                        <FolderOpen size={13} /> {t('settings.pickFolder')}
                      </button>
                    </div>
                    <em>{t('settings.defaultWorkspaceHint')}</em>
                  </label>
                </div>
                {dirty && <div className="inline-tip">{t('settings.unsaved')} · {t('common.save')}</div>}
                {saveBar}
              </section>

              <section className="card">
                <div className="card-head">
                  <Cpu size={16} />
                  <h2>{t('settings.defaultModel')}</h2>
                </div>
                <div className="settings-inline-row">
                  <div>
                    <strong>{settings.lastModel?.label || t('common.notSet')}</strong>
                    <span className="muted small">{t('settings.manageModels')}</span>
                  </div>
                  <button className="btn ghost sm" onClick={() => setPage('models')}>
                    {t('settings.manageModels')} →
                  </button>
                </div>
              </section>
            </>
          )}

          {section === 'harness' && (
            <section className="card">
              <div className="card-head">
                <BrainCircuit size={16} />
                <h2>{t('settings.harness')}</h2>
                <span className="muted small">{t('settings.harnessDesc')}</span>
              </div>
              <div className="form grid2">
                <label>
                  <span>{t('settings.toolMode')}</span>
                  <select value={draft.toolMode} onChange={(e) => patchDraft({ toolMode: e.target.value as HarnessConfig['toolMode'] })}>
                    <option value="auto">{t('settings.toolAuto')}</option>
                    <option value="native">{t('settings.toolNative')}</option>
                    <option value="prompt">{t('settings.toolPrompt')}</option>
                  </select>
                </label>
                <label>
                  <span>{t('settings.maxSteps')}</span>
                  <input type="number" min={4} max={200} value={draft.maxSteps} onChange={(e) => patchDraft({ maxSteps: Number(e.target.value) || 40 })} />
                </label>
                <label>
                  <span>{t('settings.temperature')}</span>
                  <input type="number" min={0} max={2} step={0.1} value={draft.temperature} onChange={(e) => patchDraft({ temperature: Number(e.target.value) })} />
                </label>
                <label>
                  <span>{t('settings.retryCount')}</span>
                  <input type="number" min={0} max={5} value={draft.retryCount ?? 1} onChange={(e) => patchDraft({ retryCount: Number(e.target.value) || 0 })} />
                </label>
                <label className="switch-line">
                  <span>{t('settings.parallel')}</span>
                  <Switch checked={draft.parallelTools} onChange={(v) => patchDraft({ parallelTools: v })} />
                </label>
                <label>
                  <span>{t('settings.loopGuard')}</span>
                  <input type="number" min={2} max={10} value={draft.loopGuard} onChange={(e) => patchDraft({ loopGuard: Number(e.target.value) || 3 })} />
                </label>
                <label>
                  <span>{t('settings.maxToolOutput')}</span>
                  <input type="number" min={2000} max={200000} step={1000} value={draft.maxToolOutputChars ?? 24000} onChange={(e) => patchDraft({ maxToolOutputChars: Number(e.target.value) || 24000 })} />
                </label>
                <label>
                  <span>{t('settings.toolTimeout')}</span>
                  <input type="number" min={5} max={3600} value={draft.toolTimeoutSec ?? 180} onChange={(e) => patchDraft({ toolTimeoutSec: Number(e.target.value) || 180 })} />
                </label>
                <label>
                  <span>{t('settings.thinkingMode')}</span>
                  <select value={thinking.mode} onChange={(e) => patchThinking({ mode: e.target.value as ThinkingConfig['mode'] })}>
                    <option value="auto">{t('settings.thinkingAuto')}</option>
                    <option value="always">{t('settings.thinkingAlways')}</option>
                    <option value="never">{t('settings.thinkingNever')}</option>
                  </select>
                </label>
                <label>
                  <span>{t('settings.thinkingBudget')}</span>
                  <input
                    type="number"
                    min={0}
                    max={32768}
                    step={256}
                    value={thinking.budgetTokens}
                    onChange={(e) => patchThinking({ budgetTokens: Math.max(0, Number(e.target.value) || 0) })}
                  />
                  <em>{t('settings.thinkingBudgetHint')}</em>
                </label>
                <label className="switch-line">
                  <span>{t('settings.thinkingAdaptive')}</span>
                  <Switch checked={thinking.adaptive} onChange={(v) => patchThinking({ adaptive: v })} />
                </label>
                <label>
                  <span>{t('settings.thinkingSimpleMax')}</span>
                  <input
                    type="number"
                    min={10}
                    max={400}
                    value={thinking.simpleTaskMaxChars}
                    disabled={!thinking.adaptive || thinking.mode !== 'auto'}
                    onChange={(e) => patchThinking({ simpleTaskMaxChars: Number(e.target.value) || 60 })}
                  />
                  <em>{t('settings.thinkingSimpleMaxHint')}</em>
                </label>
                <label className="span2">
                  <span>{t('settings.systemSuffix')}</span>
                  <textarea rows={4} value={draft.systemSuffix} onChange={(e) => patchDraft({ systemSuffix: e.target.value })} placeholder={t('settings.systemSuffixHint')} />
                </label>
              </div>

              <div className="raw-json">
                <button
                  className="raw-toggle"
                  onClick={() => {
                    if (!rawOpen) setRaw(JSON.stringify(draft, null, 2))
                    setRawOpen((v) => !v)
                  }}
                >
                  {t('settings.advancedJson')} {rawOpen ? '−' : '+'}
                </button>
                {rawOpen && (
                  <>
                    <textarea className="mono" rows={14} value={raw} onChange={(e) => setRaw(e.target.value)} />
                    <div className="raw-actions">
                      <button className="btn ghost sm" onClick={() => setRaw(rawHarness)}>
                        <RotateCcw size={12} /> {t('settings.resetJson')}
                      </button>
                      <button className="btn subtle sm" onClick={applyRaw}>
                        {t('settings.applyJson')}
                      </button>
                    </div>
                  </>
                )}
              </div>
              {saveBar}
            </section>
          )}

          {section === 'context' && (
            <section className="card">
              <div className="card-head">
                <Layers size={16} />
                <h2>{t('settings.nav.context')}</h2>
                <span className="muted small">{t('settings.harnessDesc')}</span>
              </div>
              <div className="notice info">
                <Layers size={14} />
                <span>{t('settings.speedHint')}</span>
              </div>
              <div className="form grid2">
                <label>
                  <span>{t('settings.contextWindow')}</span>
                  <input type="number" min={2048} max={262144} step={1024} value={draft.context.window} onChange={(e) => patchContext({ window: Number(e.target.value) || 8192 })} />
                  <em>{t('settings.contextWindowHint')}</em>
                </label>
                <label>
                  <span>{t('settings.maxOutputTokens')}</span>
                  <input type="number" min={256} max={32768} step={256} value={draft.maxOutputTokens ?? 4096} onChange={(e) => patchDraft({ maxOutputTokens: Number(e.target.value) || 4096 })} />
                  <em>{t('settings.maxOutputTokensHint')}</em>
                </label>
                <label>
                  <span>{t('settings.keepAlive')}</span>
                  <input type="number" min={0} max={1440} value={draft.keepAliveMin ?? 30} onChange={(e) => patchDraft({ keepAliveMin: Number(e.target.value) || 0 })} />
                  <em>{t('settings.keepAliveHint')}</em>
                </label>
                <label>
                  <span>{t('settings.compressMode')}</span>
                  <select value={draft.context.compressMode} onChange={(e) => patchContext({ compressMode: e.target.value as 'summary' | 'truncate' })}>
                    <option value="summary">{t('settings.summary')}</option>
                    <option value="truncate">{t('settings.truncate')}</option>
                  </select>
                </label>
                <label className="switch-line">
                  <span>{t('settings.compress')}</span>
                  <Switch checked={draft.context.compressEnabled} onChange={(v) => patchContext({ compressEnabled: v })} />
                </label>
                <label>
                  <span>{t('settings.threshold')}</span>
                  <input type="number" min={30} max={95} value={draft.context.thresholdPct} onChange={(e) => patchContext({ thresholdPct: Number(e.target.value) || 75 })} />
                </label>
                <label>
                  <span>{t('settings.keepRecent')}</span>
                  <input type="number" min={2} max={40} value={draft.context.keepRecentMessages} onChange={(e) => patchContext({ keepRecentMessages: Number(e.target.value) || 8 })} />
                </label>
                <label className="switch-line">
                  <span>{t('settings.periodic')}</span>
                  <Switch checked={draft.context.periodic} onChange={(v) => patchContext({ periodic: v })} />
                </label>
                <label>
                  <span>{t('settings.periodicEvery')}</span>
                  <input type="number" min={2} max={100} value={draft.context.periodicEveryTurns} onChange={(e) => patchContext({ periodicEveryTurns: Number(e.target.value) || 10 })} disabled={!draft.context.periodic} />
                </label>
              </div>
              {saveBar}
            </section>
          )}

          {section === 'safety' && (
            <>
              <section className="card">
                <div className="card-head">
                  <ShieldCheck size={16} />
                  <h2>{t('settings.safety')}</h2>
                </div>
                <div className="form grid2">
                  <label className="switch-line">
                    <span>{t('settings.workspaceOnly')}</span>
                    <Switch checked={draft.safety.workspaceOnly} onChange={(v) => patchSafety({ workspaceOnly: v })} />
                  </label>
                  <label className="switch-line">
                    <span>{t('settings.backup')}</span>
                    <Switch checked={draft.safety.backupBeforeWrite} onChange={(v) => patchSafety({ backupBeforeWrite: v })} />
                  </label>
                  <label>
                    <span>{t('settings.shellTimeout')}</span>
                    <input type="number" min={5} max={3600} value={draft.safety.shellTimeoutSec} onChange={(e) => patchSafety({ shellTimeoutSec: Number(e.target.value) || 120 })} />
                  </label>
                  <label>
                    <span>{t('settings.backupRetention')}</span>
                    <input type="number" min={0} max={365} value={draft.safety.backupRetentionDays ?? 7} onChange={(e) => patchSafety({ backupRetentionDays: Number(e.target.value) })} />
                  </label>
                  <label className="span2">
                    <span>{t('settings.denyPatterns')}</span>
                    <textarea rows={4} className="mono" value={draft.safety.denyPatterns.join('\n')} onChange={(e) => patchSafety({ denyPatterns: e.target.value.split(/\r?\n/).filter(Boolean) })} />
                  </label>
                </div>
                {saveBar}
              </section>

              <section className="card">
                <div className="card-head">
                  <h2>{t('settings.fullAccess')}</h2>
                  {settings.fullAccessAcknowledged ? <Badge tone="red">{t('settings.confirmed')}</Badge> : <Badge tone="green">{t('settings.safe')}</Badge>}
                </div>
                <p className="muted">{t('settings.fullAccessDesc')}</p>
                {settings.fullAccessAcknowledged ? (
                  <div className="inline-warning">
                    <ShieldAlert size={16} />
                    <span>{t('full.warning')}</span>
                    <button
                      className="btn subtle sm"
                      onClick={async () => {
                        await updateSettings({ fullAccessAcknowledged: false })
                        if (session?.permissionMode === 'full') await setPermission('auto-safe')
                        toast(t('settings.revokeDone'), 'success')
                      }}
                    >
                      {t('settings.revokeFull')}
                    </button>
                  </div>
                ) : (
                  <div className="inline-ok">
                    <ShieldCheck size={16} />
                    <span>{t('settings.fullOff')}</span>
                  </div>
                )}
              </section>
            </>
          )}

          {section === 'eval' && (
            <>
              <section className="card">
                <div className="card-head">
                  <FlaskConical size={16} />
                  <h2>{t('settings.eval')}</h2>
                  <span className="muted small">{t('settings.evalDesc')}</span>
                </div>
                <div className="settings-inline-row" style={{ flexWrap: 'wrap', gap: 8 }}>
                  <button className="btn primary sm" onClick={() => void runEval()} disabled={evalRunning || !settings.lastModel}>
                    {evalRunning ? t('settings.evalRunning', { done: evalProgress.index, total: evalProgress.total }) : t('settings.evalRun')}
                  </button>
                  {evalRunning && (
                    <button className="btn ghost sm" onClick={() => void cancelEval()}>
                      {t('common.cancel')}
                    </button>
                  )}
                  {evalReport?.reportPath && (
                    <button className="btn ghost sm" onClick={() => void window.aih.openPath(evalReport.reportPath!)}>
                      {t('settings.evalOpenReport')}
                    </button>
                  )}
                  <span className="muted small">
                    {t('settings.evalModel')}: {settings.lastModel?.label || t('common.notSet')}
                  </span>
                </div>
                {!settings.lastModel && <p className="muted small">{t('settings.evalNoModel')}</p>}
                {evalRunning && (
                  <div className="deploy-bar update-bar">
                    <div className="bar">
                      <span
                        style={{
                          width: `${evalProgress.total ? Math.max(2, Math.round((evalProgress.index / evalProgress.total) * 100)) : 4}%`
                        }}
                      />
                    </div>
                    <div className="deploy-bar-row">
                      <small>{evalNote || t('settings.evalPreparing')}</small>
                    </div>
                  </div>
                )}
                {!evalRunning && evalNote && <p className="muted small">{evalNote}</p>}
                {evalReport && (
                  <>
                    <div className="about-grid" style={{ marginTop: 12 }}>
                      <div>
                        <span>{t('settings.evalSuccess')}</span>
                        <strong>
                          {evalReport.summary.passed}/{evalReport.summary.total} · {evalReport.summary.successRate}%
                        </strong>
                      </div>
                      <div>
                        <span>{t('settings.evalAvgTime')}</span>
                        <strong>{evalReport.summary.avgDurationMs} ms</strong>
                      </div>
                      <div>
                        <span>{t('settings.evalAvgTokens')}</span>
                        <strong>{evalReport.summary.avgTokens}</strong>
                      </div>
                      <div>
                        <span>{t('settings.evalThinking')}</span>
                        <strong>{evalReport.summary.totalThinkingChars}</strong>
                      </div>
                    </div>
                    <div className="eval-table">
                      {evalReport.tasks.map((task) => (
                        <div className={`eval-row ${task.ok ? 'pass' : 'fail'}`} key={task.id}>
                          <Badge tone={task.ok ? 'green' : 'red'}>{task.ok ? 'PASS' : 'FAIL'}</Badge>
                          <div className="eval-row-main">
                            <strong>{task.title}</strong>
                            <span>
                              {task.id} · {task.durationMs}ms · {task.tokens} tok · {task.toolCalls} tools
                            </span>
                            {!task.ok && task.reason && <em>{task.reason}</em>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                <p className="muted small">{t('settings.evalHint')}</p>
              </section>

              <section className="card">
                <div className="card-head">
                  <h2>{t('settings.evalTaskList')}</h2>
                  <span className="muted small">{evalTasks.length}</span>
                </div>
                <div className="eval-task-grid">
                  {evalTasks.map((task) => (
                    <div key={task.id}>
                      <span>{task.id}</span>
                      <strong>{task.title}</strong>
                      <em>{task.category}</em>
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}

          {section === 'data' && (
            <>
              <section className="card">
                <div className="card-head">
                  <Plug size={16} />
                  <h2>{t('settings.pluginSource')}</h2>
                  <span className="muted small">{t('settings.pluginAndData')}</span>
                </div>
                <div className="form">
                  <label>
                    <span>{t('settings.pluginUrl')}</span>
                    <input
                      value={settings.pluginCatalogUrl || ''}
                      onChange={(e) => void updateSettings({ pluginCatalogUrl: e.target.value })}
                      placeholder={t('settings.pluginUrlPlaceholder')}
                    />
                    <em>{t('settings.pluginSourceHint')}</em>
                  </label>
                </div>
                <div className="settings-inline-row">
                  <div>
                    <strong>
                      {settings.pluginCatalogUrl?.trim()
                        ? t('plugins.sourceRemote', { url: settings.pluginCatalogUrl })
                        : t('plugins.sourceBuiltin')}
                    </strong>
                    <span className="muted small">{t('plugins.sourceHint')}</span>
                  </div>
                  <button className="btn ghost sm" onClick={() => setPage('plugins')}>
                    {t('settings.openPluginPage')} →
                  </button>
                </div>
              </section>

              <section className="card">
                <div className="card-head">
                  <Cpu size={16} />
                  <h2>{t('settings.hardware')}</h2>
                </div>
                <div className="hardware-grid">
                  <div>
                    <span>{t('settings.cpu')}</span>
                    <strong>{hardware?.cpu || '—'}</strong>
                  </div>
                  <div>
                    <span>{t('settings.ram')}</span>
                    <strong>
                      {hardware
                        ? `${hardware.totalRamGb} GB · ${t('models.freeRam', { n: hardware.freeRamGb })}`
                        : '—'}
                    </strong>
                  </div>
                  <div>
                    <span>{t('settings.gpu')}</span>
                    <strong>{hardware?.gpuName || t('settings.noGpu')}{hardware?.vramGb ? ` · ${hardware.vramGb} GB` : ''}</strong>
                  </div>
                  <div>
                    <span>{t('settings.comfyui')}</span>
                    <strong className={hardware?.comfyuiOnline ? 'ok-text' : 'muted'}>
                      {hardware?.comfyuiOnline ? t('settings.comfyOnline') : t('settings.comfyOffline')}
                    </strong>
                  </div>
                </div>
                <p className="muted small">{t('settings.hardwareHint')}</p>
                <div className="about-actions">
                  <button className="btn ghost sm" onClick={() => setPage('models')}>
                    {t('settings.manageModels')} →
                  </button>
                </div>
              </section>

              <section className="card">
                <div className="card-head">
                  <Database size={16} />
                  <h2>{t('settings.dataDir')}</h2>
                </div>
                <div className="about-grid">
                  <div>
                    <span>{t('settings.dataDir')}</span>
                    <strong className="mono path">{info?.userDataDir || '—'}</strong>
                  </div>
                </div>
                <p className="muted small">{t('settings.dataDirHint')}</p>
                <p className="muted small">{t('settings.auditHint')}</p>
                <div className="about-actions">
                  <button className="btn ghost sm" onClick={() => info && void window.aih.openPath(info.userDataDir)}>
                    <FolderOpen size={13} /> {t('settings.openDataDir')}
                  </button>
                  <button className="btn ghost sm" onClick={() => void updateSettings({ onboardingDone: false })}>
                    <Database size={13} /> {t('settings.reset')}
                  </button>
                </div>
              </section>
            </>
          )}

          {section === 'snapshots' && (
            <section className="card">
              <div className="card-head">
                <History size={16} />
                <h2>{t('settings.snapshots')}</h2>
                <span className="muted small">{t('settings.snapshotsDesc')}</span>
              </div>
              <div className="snapshot-save">
                <input value={snapshotLabel} onChange={(e) => setSnapshotLabel(e.target.value)} placeholder={t('settings.snapshotName')} />
                <button
                  className="btn subtle"
                  onClick={async () => {
                    await saveSnapshot(snapshotLabel || t('settings.snapshotDefault', { time: new Date().toLocaleString() }))
                    setSnapshotLabel('')
                  }}
                >
                  <Save size={13} /> {t('settings.saveSnapshot')}
                </button>
              </div>
              <div className="snapshot-list">
                {settings.harnessSnapshots.length === 0 && <span className="muted small">{t('settings.noSnapshots')}</span>}
                {settings.harnessSnapshots.map((s) => (
                  <div className="snapshot-row" key={s.id}>
                    <div>
                      <strong>{s.label}</strong>
                      <span>{new Date(s.createdAt).toLocaleString()}</span>
                    </div>
                    <button className="btn ghost sm" onClick={() => void restoreSnapshot(s.id)}>
                      <RotateCcw size={12} /> {t('settings.restore')}
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {section === 'about' && (
            <section className="card">
              <div className="card-head">
                <Info size={16} />
                <h2>{t('settings.about')}</h2>
              </div>
              <div className="about-grid">
                <div>
                  <span>{t('settings.version')}</span>
                  <strong>AIH {info?.version || '—'}</strong>
                </div>
                <div>
                  <span>{t('settings.dataDir')}</span>
                  <strong className="mono path">{info?.userDataDir || '—'}</strong>
                </div>
              </div>
              <div className="shortcuts">
                <span>{t('settings.shortcuts')}</span>
                <kbd>{t('settings.shortcutNew')}</kbd>
                <kbd>{t('settings.shortcutSend')}</kbd>
                <kbd>{t('settings.shortcutStop')}</kbd>
              </div>
              <div className="settings-inline-row" style={{ flexWrap: 'wrap', gap: 8 }}>
                <button
                  className="btn ghost sm"
                  onClick={() => void checkUpdate()}
                  disabled={checking || updatePhase === 'downloading'}
                >
                  {checking ? t('settings.checkingUpdate') : t('settings.checkUpdate')}
                </button>
                {update?.hasUpdate && update.canAutoInstall && !update.downloadedPath && (
                  <button
                    className="btn primary sm"
                    onClick={() => void downloadUpdate()}
                    disabled={updatePhase === 'downloading' || installing}
                  >
                    {updatePhase === 'downloading'
                      ? t('settings.updateDownloading', { progress: updateProgress })
                      : t('settings.updateDownload')}
                  </button>
                )}
                {update?.hasUpdate && update.downloadedPath && (
                  <button className="btn primary sm" onClick={() => void installUpdate()} disabled={installing}>
                    {installing ? t('settings.updateInstalling') : t('settings.updateInstall')}
                  </button>
                )}
                {update?.hasUpdate && update.url && (
                  <button className="btn ghost sm" onClick={() => void window.aih.openExternal(update.url)}>
                    {t('settings.updateManual')}
                  </button>
                )}
                <button className="btn ghost sm" onClick={() => void window.aih.openDataDir()}>
                  {t('settings.openDataDir')}
                </button>
                <button
                  className="btn ghost sm"
                  onClick={() => void window.aih.openExternal('https://github.com/CBXH-use/AIH')}
                >
                  {t('settings.github')}
                </button>
                <button
                  className="btn ghost sm"
                  onClick={() => void window.aih.openExternal('https://cbxh-use.github.io/AIH/')}
                >
                  {t('settings.website')}
                </button>
                <button
                  className="btn ghost sm"
                  onClick={() => void window.aih.openExternal('https://github.com/CBXH-use/AIH/issues')}
                >
                  {t('settings.feedback')}
                </button>
              </div>
              {(updatePhase === 'downloading' || updatePhase === 'verifying') && (
                <div className="deploy-bar update-bar">
                  <div className="bar">
                    <span style={{ width: `${Math.max(2, updateProgress)}%` }} />
                  </div>
                  <div className="deploy-bar-row">
                    <small>
                      {updatePhase === 'verifying'
                        ? t('settings.updateVerifying')
                        : t('settings.updateDownloading', { progress: updateProgress })}
                    </small>
                  </div>
                </div>
              )}
              {update?.downloadedPath && (
                <div className="inline-ok">
                  <ShieldCheck size={14} />
                  <span>{t('settings.updateReady')}</span>
                </div>
              )}
              {updateNote && <p className="muted small">{updateNote}</p>}
              {update?.hasUpdate && update.notes && (
                <details className="update-notes">
                  <summary>{t('settings.updateNotes')}</summary>
                  <pre>{update.notes}</pre>
                </details>
              )}
              <label className="switch-line">
                <span>{t('settings.updateAutoCheck')}</span>
                <Switch
                  checked={settings.autoUpdateCheck !== false}
                  onChange={(v) => void updateSettings({ autoUpdateCheck: v })}
                />
              </label>
              <p className="muted small">{t('settings.updateAutoCheckHint')}</p>
              <p className="muted small">{t('settings.aboutThanks')}</p>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
