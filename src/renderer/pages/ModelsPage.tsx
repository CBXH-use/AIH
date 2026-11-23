import { useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2,
  Cloud,
  Cpu,
  Download,
  ExternalLink,
  HardDrive,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  WifiOff,
  XCircle,
  Zap
} from 'lucide-react'
import type { ModelInfo, Provider, RecommendedModel } from '@shared/types'
import { useAppStore, modelRefOf } from '../store'
import { useT } from '../i18n'
import { Badge, ConfirmModal, Modal, PageHeader, Spinner } from '../components/ui'

const API_PRESETS = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o'] },
  { id: 'dashscope', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max'] },
  { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-plus', 'glm-4-flash'] },
  { id: 'moonshot', name: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k'] },
  { id: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', models: [] as string[] },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: [] as string[] },
  { id: 'custom', name: '自定义', baseUrl: '', models: [] as string[] }
]

const RUNTIME_ID = 'aih-runtime'

function fmt(bytes?: number): string {
  if (!bytes) return '—'
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

export function ModelsPage() {
  const t = useT()
  const models = useAppStore((s) => s.models)
  const providers = useAppStore((s) => s.providers)
  const scanning = useAppStore((s) => s.scanning)
  const deploy = useAppStore((s) => s.deploy)
  const settings = useAppStore((s) => s.settings)
  const hardware = useAppStore((s) => s.hardware)
  const scanModels = useAppStore((s) => s.scanModels)
  const deployModel = useAppStore((s) => s.deployModel)
  const cancelDeploy = useAppStore((s) => s.cancelDeploy)
  const removeModel = useAppStore((s) => s.removeModel)
  const startProvider = useAppStore((s) => s.startProvider)
  const testProvider = useAppStore((s) => s.testProvider)
  const saveProvider = useAppStore((s) => s.saveProvider)
  const removeProvider = useAppStore((s) => s.removeProvider)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const newSession = useAppStore((s) => s.newSession)
  const patchSession = useAppStore((s) => s.patchSession)
  const toast = useAppStore((s) => s.toast)

  const [recommended, setRecommended] = useState<RecommendedModel[]>([])
  const [addOpen, setAddOpen] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [busyProvider, setBusyProvider] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<ModelInfo | null>(null)
  const [form, setForm] = useState({
    id: '',
    name: '',
    kind: 'openai' as Provider['kind'],
    baseUrl: '',
    apiKey: '',
    models: ''
  })

  useEffect(() => {
    void window.aih.recommendedModels().then(setRecommended)
  }, [])

  const ollama = providers.find((p) => p.id === 'ollama')
  const installedRemote = useMemo(() => new Set(models.map((m) => `${m.providerId}::${m.remoteId}`)), [models])
  const gguf = models.filter((m) => m.providerId === 'local-files')
  const ready = models.filter((m) => m.providerId !== 'local-files')
  const ollamaUsable = !!ollama && ollama.state !== 'not-installed'
  const modelsDir = settings.modelSettings.modelsDir
  const defaultId = settings.lastModel ? `${settings.lastModel.providerId}::${settings.lastModel.modelId}` : ''
  const chatRecommended = recommended
    .filter((r) => !r.modes.includes('video'))
    .sort((a, b) => (ollamaUsable ? 0 : Number(!!b.gguf) - Number(!!a.gguf)))
  const videoRecommended = recommended.filter((r) => r.modes.includes('video'))
  const fitTone = (fit?: 'great' | 'ok' | 'heavy') => (fit === 'great' ? 'green' : fit === 'heavy' ? 'red' : 'neutral')
  const runtimeLabel = (r: RecommendedModel) => {
    if (r.modes.includes('video')) {
      return t(r.runtime === 'comfyui' ? 'models.runtimeComfy' : 'models.runtimeDiffusers')
    }
    if (r.gguf && !ollamaUsable) return t('models.runtimeBuiltin')
    if (!ollamaUsable) return t('models.runtimeNeedOllama')
    return t('models.runtimeOllama')
  }

  const apiProviders = providers.filter((p) => p.kind === 'openai' || p.kind === 'custom')
  const localProviders = providers.filter((p) => !(p.kind === 'openai' || p.kind === 'custom'))

  const openApiForm = (preset?: (typeof API_PRESETS)[number]) => {
    setForm({
      id: '',
      name: preset?.name || '',
      kind: 'openai',
      baseUrl: preset?.baseUrl || '',
      apiKey: '',
      models: preset?.models.join(', ') || ''
    })
    setAddOpen(true)
  }

  const openEditProvider = (p: Provider) => {
    setForm({
      id: p.id,
      name: p.name,
      kind: p.kind,
      baseUrl: p.baseUrl,
      apiKey: '',
      models: (p.models || []).join(', ')
    })
    setAddOpen(true)
  }

  const renderProviderCard = (p: Provider) => (
    <div className="provider-card" key={p.id}>
      <div className="provider-top">
        <div className="provider-ico">{p.kind === 'openai' || p.kind === 'custom' ? <Cloud size={16} /> : <Server size={16} />}</div>
        <div className="provider-title">
          <strong>{p.name}</strong>
          <span>{p.baseUrl}</span>
        </div>
        <span className={`state-dot ${p.state === 'online' ? 'on' : p.state === 'offline' ? 'idle' : 'off'}`} />
      </div>
      <div className="provider-note">
        {p.note || (p.state === 'online' ? t('models.providerOnline') : t('models.providerOffline'))}
      </div>
      {p.apiKey && (
        <div className="provider-note">
          {t('models.apiKey')}: {p.apiKey.slice(0, 4)}••••{p.apiKey.slice(-4)}
        </div>
      )}
      {p.models && p.models.length > 0 && (
        <div className="api-models-list">
          {p.models.slice(0, 6).map((m) => (
            <span className="api-model-pill" key={m} title={m}>
              {m}
            </span>
          ))}
        </div>
      )}
      <div className="provider-actions">
        {p.state === 'offline' && p.kind !== 'openai' && p.kind !== 'custom' && (
          <button
            className="btn subtle sm"
            disabled={busyProvider === p.id}
            onClick={async () => {
              setBusyProvider(p.id)
              await startProvider(p.id)
              setBusyProvider(null)
            }}
          >
            {busyProvider === p.id ? <Spinner size={11} /> : <Zap size={12} />} {t('models.start')}
          </button>
        )}
        <button
          className="btn ghost sm"
          disabled={testing === p.id}
          onClick={async () => {
            setTesting(p.id)
            await testProvider(p.id)
            setTesting(null)
          }}
        >
          {testing === p.id ? <Spinner size={11} /> : <RefreshCw size={12} />} {t('models.test')}
        </button>
        {(p.kind === 'openai' || p.kind === 'custom') && (
          <>
            <button className="btn ghost sm" onClick={() => openEditProvider(p)}>
              <Pencil size={12} /> {t('common.edit')}
            </button>
            <button
              className="icon-btn sm danger-hover"
              onClick={() => {
                if (window.confirm(t('models.removeProviderConfirm'))) void removeProvider(p.id)
              }}
            >
              <Trash2 size={12} />
            </button>
          </>
        )}
      </div>
    </div>
  )

  const openVideoModel = (r: RecommendedModel) => {
    void window.aih.openExternal(r.downloadUrl)
    toast(t('models.videoDeployHint'), 'info')
  }

  const renderRecommended = (r: RecommendedModel) => {
    const isVideo = r.modes.includes('video')
    const tag = r.ollamaTag || r.id
    const ollamaId = `ollama::${tag}`
    const runtimeId = `aih::${r.id}`
    const useRuntime = !!r.gguf && !ollamaUsable
    const installed =
      installedRemote.has(ollamaId) ||
      (!!r.gguf &&
        models.some(
          (m) => m.providerId === RUNTIME_ID && pathEndsWith(m.filePath, r.gguf!.file)
        ))
    const actionId = useRuntime ? runtimeId : ollamaId
    const ev = deploy[actionId] || deploy[ollamaId]
    return (
      <div className="rec-card" key={r.id}>
        <div className="rec-top">
          <strong>{r.name}</strong>
          <span className="rec-badges">
            <span className="badge neutral tiny">{r.params}</span>
            {r.fit && <Badge tone={fitTone(r.fit) as 'green' | 'red' | 'neutral'}>{t(`models.fit.${r.fit}`)}</Badge>}
          </span>
        </div>
        <p>{r.description}</p>
        <div className="rec-tags">
          {r.tags.map((tagName) => (
            <span className="tag" key={tagName}>
              {tagName}
            </span>
          ))}
        </div>
        <div className="rec-meta">
          <span>{fmt(r.sizeBytes)}</span>
          <span>{t('models.memoryHint', { ram: r.minRamGb })}</span>
          {r.vramGb ? <span>{t('models.vram')} {r.vramGb}GB</span> : null}
          <span>{runtimeLabel(r)}</span>
        </div>
        {isVideo ? (
          <div className="rec-actions">
            <button className="btn primary full" onClick={() => openVideoModel(r)}>
              <ExternalLink size={13} /> {t('models.openModelPage')}
            </button>
            {r.mirrorUrl && (
              <button className="link-btn" onClick={() => void window.aih.openExternal(r.mirrorUrl!)}>
                {t('onboard.mirror')}
              </button>
            )}
          </div>
        ) : installed ? (
          <div className="deploy-done">
            <CheckCircle2 size={14} /> {t('common.installed')}
          </div>
        ) : ev && (ev.status === 'progress' || ev.status === 'starting') ? (
          <div className="deploy-bar">
            <div className="bar">
              <span style={{ width: `${ev.progress || 3}%` }} />
            </div>
            <div className="deploy-bar-row">
              <small>{ev.message || t('models.deploying', { n: ev.progress || 0 })}</small>
              <button className="link-btn" onClick={() => void cancelDeploy(actionId)}>
                {t('models.cancelDeploy')}
              </button>
            </div>
          </div>
        ) : (
          <div className="rec-actions">
            <button
              className="btn primary full"
              onClick={() => {
                if (useRuntime) {
                  void deployModel(runtimeId)
                } else if (ollamaUsable) {
                  void deployModel(ollamaId)
                } else {
                  void window.aih.openExternal(r.downloadUrl)
                  toast(t('models.noRuntimeHint'), 'info')
                }
              }}
            >
              <Download size={13} />{' '}
              {useRuntime ? t('models.deployOneClick') : ollamaUsable ? t('models.deploy') : t('onboard.downloadManual')}
            </button>
            {r.mirrorUrl && (
              <button className="link-btn" onClick={() => void window.aih.openExternal(r.mirrorUrl!)}>
                {t('onboard.mirror')}
              </button>
            )}
          </div>
        )}
        {ev?.status === 'error' && (
          <span className="error-text">
            <XCircle size={11} /> {ev.message || t('onboard.deployFailed')}
          </span>
        )}
      </div>
    )
  }

  const importGguf = async () => {
    const files = await window.aih.pickFiles(['gguf'])
    if (!files[0]) return
    toast(t('models.importing'), 'info')
    const res = await window.aih.importGguf(files[0])
    if (res.ok) {
      toast(t('models.importDone'), 'success')
      await scanModels({ quick: true })
    } else toast(res.error || t('models.importFailed'), 'error')
  }

  const useModel = async (m: ModelInfo) => {
    const ref = modelRefOf(m)
    const created = await newSession({ mode: 'chat' })
    if (created) {
      await patchSession(created.id, { model: ref })
      toast(t('models.deployDone'), 'success')
    }
  }

  return (
    <div className="page">
      <PageHeader
        title={t('models.title')}
        subtitle={t('models.subtitle')}
        actions={
          <>
            <button className="btn ghost" onClick={() => void importGguf()}>
              <Download size={14} /> {t('models.importGguf')}
            </button>
            <button className="btn primary" onClick={() => void scanModels({ quick: false })} disabled={scanning}>
              {scanning ? <Spinner size={13} /> : <RefreshCw size={14} />}
              {scanning ? t('models.scanning') : t('models.scan')}
            </button>
          </>
        }
      />

      {!ollamaUsable && (
        <div className="banner">
          <Cpu size={18} />
          <div>
            <strong>{t('models.noOllama')}</strong>
            <span>{t('models.noOllamaDesc')}</span>
          </div>
        </div>
      )}

      <section className="api-section">
        <div className="api-section-head">
          <div>
            <h2>
              <Cloud size={16} /> {t('models.apiSection')}
            </h2>
            <p>{t('models.apiSectionDesc')}</p>
          </div>
          <button className="btn primary sm" onClick={() => openApiForm()}>
            <Plus size={13} /> {t('models.addApi')}
          </button>
        </div>
        <div className="api-preset-row">
          {API_PRESETS.map((preset) => (
            <button key={preset.id} className="api-preset" onClick={() => openApiForm(preset)}>
              {preset.name}
            </button>
          ))}
        </div>
        {apiProviders.length === 0 ? (
          <div className="api-empty">
            <Cloud size={18} />
            <span>{t('models.apiEmpty')}</span>
          </div>
        ) : (
          <div className="provider-grid">{apiProviders.map(renderProviderCard)}</div>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <h2>{t('models.services')}</h2>
          <span className="muted small">{t('models.localServicesHint')}</span>
        </div>
        <div className="provider-grid">
          {localProviders.length === 0 && <div className="muted small">{t('models.scanning')}</div>}
          {localProviders.map(renderProviderCard)}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>{t('models.localModels')}</h2>
          <span className="muted small">{t('models.count', { n: ready.length })}</span>
          {modelsDir && (
            <button className="link-btn" onClick={() => void window.aih.openPath(modelsDir)}>
              {t('models.openModelsDir')} →
            </button>
          )}
        </div>
        {ready.length === 0 ? (
          <div className="empty-strip">
            <HardDrive size={18} />
            <span>{t('models.noModels')}</span>
          </div>
        ) : (
          <div className="model-list">
            {ready.map((m) => {
              const isDefault = defaultId === `${m.providerId}::${m.remoteId}`
              const provider = providers.find((p) => p.id === m.providerId)
              return (
                <div className="model-row" key={m.id}>
                  <div className="model-avatar">{m.name.slice(0, 1).toUpperCase()}</div>
                  <div className="model-info">
                    <div className="model-row-title">
                      <strong>{m.name}</strong>
                      {isDefault && <Badge tone="green">{t('models.default')}</Badge>}
                      {m.supportsTools === true && <Badge tone="blue">{t('models.tools')}</Badge>}
                      {m.supportsTools === false && <Badge tone="amber">{t('models.textProtocol')}</Badge>}
                      {m.fit && (
                        <span title={m.fit.reason}>
                          <Badge
                            tone={m.fit.level === 'great' ? 'green' : m.fit.level === 'heavy' ? 'red' : 'neutral'}
                          >
                            {t(`models.fit.${m.fit.level}`)}
                          </Badge>
                        </span>
                      )}
                      {m.supportsThinking === true && <Badge tone="blue">{t('models.thinking')}</Badge>}
                      {m.supportsVision === true && <Badge tone="neutral">{t('models.vision')}</Badge>}
                    </div>
                    <div className="model-meta">
                      <span>{provider?.name || m.providerId}</span>
                      {m.parameterSize && <span>{m.parameterSize}</span>}
                      {m.quantization && <span>{m.quantization}</span>}
                      <span>{fmt(m.sizeBytes)}</span>
                      {m.contextLength && <span>{Math.round(m.contextLength / 1024)}K ctx</span>}
                      {m.fit && <span title={m.fit.reason}>{t('models.fit.ram', { gb: m.fit.requiredRamGb })}</span>}
                    </div>
                  </div>
                  <div className="model-row-actions">
                    <button className="btn subtle sm" onClick={() => void useModel(m)}>
                      {t('models.useNow')}
                    </button>
                    <button
                      className="btn ghost sm"
                      disabled={isDefault}
                      onClick={async () => {
                        await updateSettings({ lastModel: modelRefOf(m) })
                        toast(t('models.setDefault'), 'success')
                      }}
                    >
                      {t('models.setDefault')}
                    </button>
                    <button className="icon-btn sm danger-hover" onClick={() => setRemoveTarget(m)}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
        {gguf.length > 0 && (
          <div className="gguf-box">
            <div className="gguf-box-head">
              <Download size={14} />
              <span>{t('models.ggufHint', { n: gguf.length })}</span>
            </div>
            {gguf.slice(0, 6).map((m) => (
              <div className="gguf-line" key={m.id}>
                <div>
                  <strong>{m.name}</strong>
                  <span>{m.filePath}</span>
                </div>
                <div className="gguf-actions">
                  <span className="muted small">{fmt(m.sizeBytes)}</span>
                  {deploy[m.id]?.status === 'progress' ? (
                    <span className="small">
                      <Spinner size={11} /> {t('models.deploying', { n: deploy[m.id]?.progress || 0 })}
                    </span>
                  ) : (
                    <button className="btn subtle sm" onClick={() => void deployModel(m.id)}>
                      {ollamaUsable ? t('models.importGguf') : t('models.addToAih')}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <h2>{t('models.recommended')}</h2>
          <span className="muted small">{t('models.recommendedBasis')}</span>
        </div>
        {hardware && (
          <div className="hardware-strip">
            <Cpu size={16} />
            <div>
              <strong>{t('models.hardwareTitle')}</strong>
              <span>
                {hardware.cpu} · {hardware.totalRamGb}GB {t('models.ram')}
                {hardware.gpuName ? ` · ${hardware.gpuName}` : ''}
                {hardware.vramGb ? ` ${hardware.vramGb}GB ${t('models.vram')}` : ''}
              </span>
            </div>
            <span className={`badge ${hardware.comfyuiOnline ? 'green' : 'neutral'}`}>
              {hardware.comfyuiOnline ? t('models.comfyOnline') : t('models.comfyOffline')}
            </span>
          </div>
        )}
        <div className="recommend-grid wide">
          {chatRecommended.map(renderRecommended)}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>{t('models.videoModels')}</h2>
          <span className="muted small">{t('models.videoHint')}</span>
          {hardware?.comfyuiOnline && (
            <button className="link-btn" onClick={() => void window.aih.openExternal('http://127.0.0.1:8188')}>
              {t('models.openComfy')} →
            </button>
          )}
        </div>
        {hardware && !hardware.comfyuiOnline && (
          <div className="notice warn">
            <HardDrive size={14} />
            <span>{t('models.comfyOffline')}</span>
          </div>
        )}
        <div className="recommend-grid wide video-grid">
          {videoRecommended.map(renderRecommended)}
        </div>
      </section>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} width={520}>
        <h2 className="modal-title">{form.id ? t('models.editProvider') : t('models.addApi')}</h2>
        <p className="modal-desc">{t('models.apiNote')}</p>
        <div className="form">
          <label>
            <span>{t('models.providerName')}</span>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('models.namePlaceholder')} autoFocus />
          </label>
          <label>
            <span>{t('models.kind')}</span>
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Provider['kind'] })}>
              <option value="openai">{t('models.kindOpenai')}</option>
              <option value="custom">{t('models.kindCustom')}</option>
            </select>
          </label>
          <label>
            <span>{t('models.baseUrl')}</span>
            <input
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              placeholder={t('models.urlPlaceholder')}
            />
          </label>
          <label>
            <span>
              {t('models.apiKey')} <em>{t('common.optional')}</em>
            </span>
            <input
              type="password"
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              placeholder={form.id ? t('models.apiKeyKeep') : 'sk-…'}
            />
          </label>
          <label>
            <span>{t('models.modelIds')}</span>
            <textarea
              rows={3}
              value={form.models}
              onChange={(e) => setForm({ ...form, models: e.target.value })}
              placeholder={t('models.modelIdsPlaceholder')}
            />
            <em>{t('models.modelIdsHint')}</em>
          </label>
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => setAddOpen(false)}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            disabled={!form.name.trim() || !form.baseUrl.trim()}
            onClick={async () => {
              const parsed = form.models
                .split(/[\n,，]+/)
                .map((s) => s.trim())
                .filter(Boolean)
              const ok = await saveProvider({
                id: form.id || undefined,
                name: form.name,
                kind: form.kind,
                baseUrl: form.baseUrl,
                apiKey: form.apiKey || undefined,
                models: parsed
              })
              if (ok) {
                setAddOpen(false)
                setForm({ id: '', name: '', kind: 'openai', baseUrl: '', apiKey: '', models: '' })
              }
            }}
          >
            {t('models.saveProvider')}
          </button>
        </div>
      </Modal>

      <ConfirmModal
        open={!!removeTarget}
        title={t('models.removeModel')}
        message={removeTarget?.providerId === RUNTIME_ID ? t('models.removeRuntimeConfirm') : t('models.removeConfirm')}
        danger
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => {
          if (removeTarget) void removeModel(removeTarget.id)
          setRemoveTarget(null)
        }}
      />
    </div>
  )
}
