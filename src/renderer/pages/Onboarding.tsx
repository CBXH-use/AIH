import { useEffect, useMemo, useState } from 'react'
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Cpu,
  Download,
  HardDrive,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  WifiOff,
  Zap
} from 'lucide-react'
import type { ModelInfo, ModelRef, RecommendedModel } from '@shared/types'
import { useAppStore, modelRefOf } from '../store'
import { useT } from '../i18n'
import { Spinner } from '../components/ui'

function fmt(bytes?: number): string {
  if (!bytes) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`
}

function pathEndsWith(filePath: string | undefined, fileName: string): boolean {
  return !!filePath && filePath.replace(/\\/g, '/').toLowerCase().endsWith(`/${fileName.toLowerCase()}`)
}

export function Onboarding() {
  const t = useT()
  const settings = useAppStore((s) => s.settings)
  const models = useAppStore((s) => s.models)
  const providers = useAppStore((s) => s.providers)
  const scanning = useAppStore((s) => s.scanning)
  const deploy = useAppStore((s) => s.deploy)
  const info = useAppStore((s) => s.info)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const scanModels = useAppStore((s) => s.scanModels)
  const cancelScan = useAppStore((s) => s.cancelScan)
  const startProvider = useAppStore((s) => s.startProvider)
  const deployModel = useAppStore((s) => s.deployModel)
  const newSession = useAppStore((s) => s.newSession)
  const patchSession = useAppStore((s) => s.patchSession)
  const toast = useAppStore((s) => s.toast)

  const [step, setStep] = useState<'welcome' | 'detect' | 'finish'>('welcome')
  const [selected, setSelected] = useState<ModelRef | null>(null)
  const [recommended, setRecommended] = useState<RecommendedModel[]>([])
  const [busyProvider, setBusyProvider] = useState<string | null>(null)
  const [startedScan, setStartedScan] = useState(false)
  const [showRecommend, setShowRecommend] = useState(false)

  useEffect(() => {
    void window.aih.recommendedModels().then(setRecommended)
  }, [])

  useEffect(() => {
    if (step === 'detect' && !startedScan) {
      setStartedScan(true)
      void scanModels({ quick: false })
    }
  }, [step, startedScan, scanModels])

  useEffect(() => {
    if (selected) return
    for (const [id, ev] of Object.entries(deploy)) {
      if (ev.status !== 'done') continue
      if (id.startsWith('ollama::')) {
        const tag = id.slice('ollama::'.length)
        const found = models.find((m) => m.remoteId === tag)
        if (found) setSelected(modelRefOf(found))
        else setSelected({ providerId: 'ollama', modelId: tag, label: tag })
      } else if (id.startsWith('aih::')) {
        const rec = recommended.find((r) => `aih::${r.id}` === id)
        const file = rec?.gguf?.file.toLowerCase()
        const found = file
          ? models.find((m) => m.providerId === 'aih-runtime' && pathEndsWith(m.filePath, file))
          : undefined
        if (found) setSelected(modelRefOf(found))
      } else if (id.startsWith('local-files::')) {
        const path = id.slice('local-files::'.length)
        const found = models.find(
          (m) => m.providerId === 'aih-runtime' && m.filePath && m.filePath.toLowerCase() === path.toLowerCase()
        )
        if (found) setSelected(modelRefOf(found))
      }
    }
  }, [deploy, models, recommended, selected])

  const ollama = providers.find((p) => p.id === 'ollama')
  const online = info?.online !== false
  const readyModels = models.filter((m) => m.providerId !== 'local-files')
  const ggufModels = models.filter((m) => m.providerId === 'local-files')
  const scanFinished = !scanning && startedScan
  const ollamaUsable = ollama && (ollama.state === 'online' || ollama.state === 'offline')

  useEffect(() => {
    if (scanFinished && readyModels.length === 0) setShowRecommend(true)
  }, [scanFinished, readyModels.length])

  const recommendedChat = recommended
    .filter((r) => !r.modes.includes('video'))
    .sort((a, b) => (ollamaUsable ? 0 : Number(!!b.gguf) - Number(!!a.gguf)))

  const featureList = [
    { icon: Cpu, text: t('onboard.feature1') },
    { icon: WifiOff, text: t('onboard.feature2') },
    { icon: Sparkles, text: t('onboard.feature3') }
  ]

  const pickModel = async (m: ModelInfo) => {
    if (scanning) await cancelScan()
    setSelected(modelRefOf(m))
  }

  const bootProvider = async (id: string) => {
    setBusyProvider(id)
    await startProvider(id)
    setBusyProvider(null)
    await scanModels({ quick: true })
  }

  const finish = async () => {
    const chosen = selected || (readyModels[0] ? modelRefOf(readyModels[0]) : null)
    await updateSettings({
      onboardingDone: true,
      ...(chosen ? { lastModel: chosen } : {})
    })
    const created = await newSession()
    if (created && chosen) await patchSession(created.id, { model: chosen })
  }

  const skipDetect = async () => {
    await cancelScan()
    setStep('finish')
  }

  const deployRecommended = async (r: RecommendedModel) => {
    if (r.modes.includes('video') || r.runtime === 'comfyui' || r.runtime === 'diffusers') {
      await window.aih.openExternal(r.downloadUrl)
      toast(t('models.videoDeployHint'), 'info')
      return
    }
    // 没装 Ollama 也能一键下载：用 AIH 内置运行时直接运行 GGUF
    if (r.gguf && !ollamaUsable) {
      await deployModel(`aih::${r.id}`)
      return
    }
    if (!ollamaUsable) {
      await window.aih.openExternal(r.downloadUrl)
      toast(t('onboard.downloadOpened'), 'info')
      return
    }
    await deployModel(`ollama::${r.ollamaTag || r.id}`)
  }

  return (
    <div className="onboarding">
      <div className="onboard-bg" />
      <div className={`onboard-card step-${step}`}>
        <div className="onboard-brand">
          <div className="brand-mark large">A</div>
          <div>
            <strong>AIH</strong>
            <span>AI HOUSE</span>
          </div>
          <span className="onboard-step">
            {step === 'welcome' ? t('onboard.step', { n: 1 }) : step === 'detect' ? t('onboard.step', { n: 2 }) : t('onboard.step', { n: 3 })}
          </span>
        </div>

        {step === 'welcome' && (
          <div className="onboard-body welcome">
            <h1>{t('onboard.welcome')}</h1>
            <p className="lead">{t('onboard.welcomeDesc')}</p>
            <div className="feature-grid">
              {featureList.map((f, i) => {
                const Icon = f.icon
                return (
                  <div className="feature" key={i}>
                    <span className="feature-icon">
                      <Icon size={17} />
                    </span>
                    <span>{f.text}</span>
                  </div>
                )
              })}
            </div>
            <div className="onboard-actions">
              <button className="skip-link" onClick={() => void finish()}>
                {t('onboard.skipAndStart')}
              </button>
              <button className="btn primary lg" onClick={() => setStep('detect')}>
                {t('onboard.continue')} <ArrowRight size={16} />
              </button>
            </div>
          </div>
        )}

        {step === 'detect' && (
          <div className="onboard-body detect">
            <div className="detect-head">
              <div>
                <h1>{t('onboard.detectTitle')}</h1>
                <p className="lead">{t('onboard.detectDesc')}</p>
              </div>
              <div className="scan-state">
                {scanning ? <Spinner size={15} /> : <CheckCircle2 size={16} />}
                <span>{scanning ? t('onboard.scanning') : t('onboard.scanDone')}</span>
                <small>{t('onboard.found', { n: readyModels.length })}</small>
              </div>
            </div>

            {providers.length > 0 && (
              <div className="provider-strip">
                {providers.map((p) => (
                  <div className={`provider-mini ${p.state}`} key={p.id}>
                    <span className={`state-dot ${p.state === 'online' ? 'on' : p.state === 'offline' ? 'idle' : 'off'}`} />
                    <div>
                      <strong>{p.name}</strong>
                      <span>
                        {p.state === 'online'
                          ? p.version
                            ? `v${p.version}`
                            : t('models.providerOnline')
                          : p.state === 'offline'
                            ? t('onboard.providerOffline')
                            : p.id === 'aih-runtime'
                              ? t('onboard.builtinAvailable')
                              : t('onboard.notInstalled')}
                      </span>
                    </div>
                    {p.state === 'offline' && (
                      <button className="mini-action" onClick={() => void bootProvider(p.id)} disabled={busyProvider === p.id}>
                        {busyProvider === p.id ? <Spinner size={11} /> : <Play size={11} />}
                        {t('onboard.startService')}
                      </button>
                    )}
                    {p.state === 'not-installed' && p.id === 'ollama' && (
                      <span className="tiny-muted">{t('onboard.builtinAvailable')}</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {readyModels.length > 0 ? (
              <div className="model-cards">
                {readyModels.map((m) => {
                  const active = selected?.providerId === m.providerId && selected?.modelId === m.remoteId
                  return (
                    <div className={`model-card ${active ? 'selected' : ''}`} key={m.id}>
                      <div className="model-card-head">
                        <div className="model-avatar lg">{m.name.slice(0, 1).toUpperCase()}</div>
                        <div className="model-card-title">
                          <strong>{m.name}</strong>
                          <span>
                            {providers.find((p) => p.id === m.providerId)?.name || m.providerId}
                            {m.sizeBytes ? ` · ${fmt(m.sizeBytes)}` : ''}
                          </span>
                        </div>
                        {active && <span className="picked"><Check size={13} /></span>}
                      </div>
                      <div className="model-tags">
                        {m.parameterSize && <span className="badge neutral tiny">{m.parameterSize}</span>}
                        {m.quantization && <span className="badge neutral tiny">{m.quantization}</span>}
                        {m.supportsTools === true && <span className="badge green tiny">{t('onboard.toolCall')}</span>}
                        {m.supportsTools === false && <span className="badge amber tiny">{t('onboard.textProtocol')}</span>}
                        {m.contextLength && <span className="badge neutral tiny">{t('onboard.contextSuffix', { n: Math.round(m.contextLength / 1024) })}</span>}
                      </div>
                      <button className={`btn ${active ? 'subtle' : 'primary'} full`} onClick={() => void pickModel(m)}>
                        {active ? t('onboard.selected') : t('onboard.use')}
                      </button>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="scan-empty">
                {scanning ? (
                  <>
                    <div className="scan-skeleton" />
                    <div className="scan-skeleton short" />
                    <span className="muted">{t('onboard.scanning')}</span>
                  </>
                ) : (
                  <div className="empty-hint">
                    <HardDrive size={20} />
                    <span>{t('onboard.foundNone')}</span>
                  </div>
                )}
              </div>
            )}

            {ggufModels.length > 0 && (
              <div className="gguf-strip">
                <span>{t('models.ggufHint', { n: ggufModels.length })}</span>
                {ggufModels.slice(0, 3).map((m) => (
                  <div className="gguf-item" key={m.id}>
                    <span>{m.name}</span>
                    {deploy[m.id]?.status === 'progress' || deploy[m.id]?.status === 'starting' ? (
                      <span className="deploy-progress-text">
                        <Spinner size={11} /> {t('onboard.deploying', { n: deploy[m.id]?.progress || 0 })}
                      </span>
                    ) : (
                      <button className="mini-action" onClick={() => void deployModel(m.id)}>
                        <Download size={11} /> {t('models.importGguf')}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {scanFinished && !showRecommend && (
              <button className="recommend-toggle" onClick={() => setShowRecommend(true)}>
                <Download size={12} /> {t('onboard.noSuitable')}
              </button>
            )}

            {scanFinished && showRecommend && (
              <div className="recommend-block">
                <div className="recommend-head">
                  <h2>{t('onboard.recommendTitle')}</h2>
                  <p>{t('onboard.recommendDesc')}</p>
                  <button className="link-btn" onClick={() => setShowRecommend(false)}>
                    {t('onboard.collapse')}
                  </button>
                </div>
                {!online && (
                  <div className="notice warn">
                    <WifiOff size={14} />
                    <span>{t('onboard.offlineWarn')}</span>
                  </div>
                )}
                <div className="recommend-grid">
                  {recommendedChat.slice(0, 4).map((r) => {
                    const ollamaId = `ollama::${r.ollamaTag || r.id}`
                    const runtimeId = `aih::${r.id}`
                    const useRuntime = !!r.gguf && !ollamaUsable
                    const ev = deploy[useRuntime ? runtimeId : ollamaId] || deploy[ollamaId]
                    const installed =
                      models.find((m) => m.providerId === 'ollama' && m.remoteId === (r.ollamaTag || r.id)) ||
                      (r.gguf
                        ? models.find(
                            (m) => m.providerId === 'aih-runtime' && pathEndsWith(m.filePath, r.gguf!.file)
                          )
                        : undefined)
                    return (
                      <div className="rec-card" key={r.id}>
                        <div className="rec-top">
                          <strong>{r.name}</strong>
                          <span className="badge neutral tiny">{r.params}</span>
                        </div>
                        <p>{r.description}</p>
                        <div className="rec-meta">
                          <span>{fmt(r.sizeBytes)}</span>
                          <span>{t('onboard.needs', { ram: r.minRamGb })}</span>
                        </div>
                        {installed ? (
                          <button
                            className="btn subtle full"
                            onClick={() => {
                              setSelected(modelRefOf(installed))
                            }}
                          >
                            {t('onboard.use')}
                          </button>
                        ) : ev && (ev.status === 'progress' || ev.status === 'starting') ? (
                          <div className="deploy-bar">
                            <div className="bar">
                              <span style={{ width: `${ev.progress || 3}%` }} />
                            </div>
                            <small>{ev.message || t('onboard.deploying', { n: ev.progress || 0 })}</small>
                          </div>
                        ) : ev?.status === 'done' ? (
                          <div className="deploy-done">
                            <CheckCircle2 size={14} /> {t('onboard.deployDone')}
                          </div>
                        ) : (
                          <div className="rec-actions">
                            <button className="btn primary full" onClick={() => void deployRecommended(r)}>
                              <Download size={13} />{' '}
                              {useRuntime || ollamaUsable ? t('models.deployOneClick') : t('onboard.downloadManual')}
                            </button>
                            {r.mirrorUrl && (
                              <button className="link-btn" onClick={() => void window.aih.openExternal(r.mirrorUrl!)}>
                                {t('onboard.mirror')}
                              </button>
                            )}
                          </div>
                        )}
                        {ev?.status === 'error' && <span className="error-text">{ev.message || t('onboard.deployFailed')}</span>}
                      </div>
                    )
                  })}
                </div>
                {!ollamaUsable && <p className="tiny-muted">{t('onboard.noOllamaHint')}</p>}
              </div>
            )}

            <div className="onboard-actions detect-actions">
              <button className="skip-link" onClick={() => void skipDetect()}>
                {t('onboard.skipDetect')}
              </button>
              <span className="spacer" />
              <button className="btn ghost" onClick={() => setStep('welcome')}>
                {t('common.back')}
              </button>
              <button className="btn primary" onClick={() => setStep('finish')} disabled={scanning && !selected}>
                {selected ? t('common.next') : t('onboard.chooseLater')} <ArrowRight size={15} />
              </button>
            </div>
          </div>
        )}

        {step === 'finish' && (
          <div className="onboard-body finish">
            <div className="finish-icon">
              <Check size={34} strokeWidth={2.4} />
            </div>
            <h1>{t('onboard.finishTitle')}</h1>
            <p className="lead">{t('onboard.finishDesc')}</p>
            {selected ? (
              <div className="finish-model">
                <Zap size={14} />
                <span>{t('onboard.modelReady', { name: selected.label })}</span>
              </div>
            ) : (
              <div className="finish-model muted">
                <Cpu size={14} />
                <span>{t('onboard.chooseLater')}</span>
              </div>
            )}
            <div className="assurance">
              <ShieldCheck size={15} />
              <span>{t('onboard.assurance')}</span>
            </div>
            <div className="onboard-actions">
              <button className="link-btn" onClick={() => setStep('detect')}>
                <RefreshCw size={12} /> {t('common.back')}
              </button>
              <span className="spacer" />
              <button className="btn primary lg" onClick={() => void finish()}>
                {t('onboard.startExp')} <ArrowRight size={16} />
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="onboard-foot">AIH · {settings.language === 'zh' ? '本地优先，数据留在你的电脑上' : 'Local-first. Your data stays on your machine.'}</div>
    </div>
  )
}
