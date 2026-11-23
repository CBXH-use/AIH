import { existsSync, promises as fsp } from 'fs'
import { homedir } from 'os'
import { basename, extname, join, normalize, sep } from 'path'
import type { ModelInfo, Provider, ScanEvent } from '@shared/types'
import { listProviderModels } from './llmClient'
import {
  findOllamaBinary,
  findOllamaModelDirs,
  fixedDrives,
  guessGgufMeta,
  listOllamaDiskModels
} from './discovery'
import { readGgufMeta } from './gguf'
import { formatParamCount } from '@shared/gguf'

const OLLAMA_BASE = 'http://127.0.0.1:11434'
const LMSTUDIO_BASE = 'http://127.0.0.1:1234'
const LLAMACPP_PORTS = [8080, 8081, 11435]

export interface ScanOptions {
  quick?: boolean
  includeLooseGguf?: boolean
  /** AIH 自己的模型目录，散落 GGUF 扫描时跳过，避免和内置运行时重复 */
  modelsDir?: string
}

type Emit = (e: ScanEvent) => void

function firstExisting(paths: string[]): string | null {
  for (const p of paths) {
    try {
      if (p && existsSync(p)) return p
    } catch {
      /* ignore */
    }
  }
  return null
}

async function getJson<T>(url: string, timeoutMs = 3000, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

interface OllamaTag {
  name: string
  size?: number
  capabilities?: string[]
  details?: {
    family?: string
    families?: string[]
    parameter_size?: string
    quantization_level?: string
    context_length?: number
  }
}

interface OllamaTagsResponse {
  models?: OllamaTag[]
}

interface OllamaShowResponse {
  capabilities?: string[]
  model_info?: Record<string, unknown>
}

async function parseOllamaTag(tag: OllamaTag, enrich: boolean): Promise<ModelInfo> {
  let contextLength: number | undefined = tag.details?.context_length
  let supportsTools: boolean | undefined = Array.isArray(tag.capabilities) ? tag.capabilities.includes('tools') : undefined
  let supportsThinking: boolean | undefined = Array.isArray(tag.capabilities) ? tag.capabilities.includes('thinking') : undefined
  if (enrich && (contextLength === undefined || supportsTools === undefined || supportsThinking === undefined)) {
    const show = await getJson<OllamaShowResponse>(`${OLLAMA_BASE}/api/show`, 5000, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: tag.name })
    })
    if (show) {
      if (supportsTools === undefined) supportsTools = Array.isArray(show.capabilities) ? show.capabilities.includes('tools') : undefined
      if (supportsThinking === undefined) {
        supportsThinking = Array.isArray(show.capabilities) ? show.capabilities.includes('thinking') : undefined
      }
      const info = show.model_info || {}
      for (const [k, v] of Object.entries(info)) {
        if (contextLength === undefined && k.endsWith('.context_length') && typeof v === 'number') contextLength = v
      }
    }
  }
  return {
    id: `ollama::${tag.name}`,
    remoteId: tag.name,
    providerId: 'ollama',
    providerKind: 'ollama',
    name: tag.name,
    family: tag.details?.family,
    parameterSize: tag.details?.parameter_size,
    quantization: tag.details?.quantization_level,
    sizeBytes: tag.size,
    contextLength,
    supportsTools,
    supportsThinking,
    status: 'ready'
  }
}

function looksLikeModelFolder(name: string): boolean {
  return /(model|qwen|llama|deepseek|gemma|phi|mistral|mixtral|yi|codestral|granite|glm|internlm|baichuan|minicpm|nomic|bge|embed)/i.test(name)
}

export class ModelScanner {
  private cancelled = false
  private seen = new Set<string>()

  cancel() {
    this.cancelled = true
  }

  get isCancelled() {
    return this.cancelled
  }

  private emit: Emit = () => {}

  async scan(opts: ScanOptions, emit: Emit): Promise<ModelInfo[]> {
    this.emit = emit
    this.cancelled = false
    this.seen = new Set()
    const models: ModelInfo[] = []
    const pushModel = (m: ModelInfo) => {
      if (this.seen.has(m.id)) return
      this.seen.add(m.id)
      models.push(m)
      this.emit({ type: 'model', model: m })
    }
    const pushProvider = (p: Provider) => {
      this.emit({ type: 'provider', provider: p })
    }

    // API 接入的反馈要快，先扫描用户配置的云端/自定义服务
    await this.scanCustomProviders(pushProvider, pushModel)
    if (this.cancelled) return models
    await this.scanOllama(pushProvider, pushModel)
    if (this.cancelled) return models
    await this.scanLmStudio(pushProvider, pushModel)
    if (this.cancelled) return models
    await this.scanLlamaCpp(pushProvider, pushModel)
    if (this.cancelled) return models
    if (!opts.quick && opts.includeLooseGguf !== false) {
      await this.scanLooseGguf(pushModel, opts.modelsDir)
    }
    return models
  }

  private async scanOllama(pushProvider: (p: Provider) => void, pushModel: (m: ModelInfo) => void) {
    const binary = findOllamaBinary()
    const version = await getJson<{ version?: string }>(`${OLLAMA_BASE}/api/version`, 2500)
    const online = !!version
    const modelDirs = findOllamaModelDirs(binary)

    // 服务没启动时，直接读磁盘上的 manifests/blobs，不依赖 Ollama 进程
    const diskModels: ModelInfo[] = []
    if (binary) {
      for (const dir of modelDirs) {
        if (this.cancelled) break
        const found = await listOllamaDiskModels(dir)
        for (const model of found) {
          if (!diskModels.some((m) => m.id === model.id)) diskModels.push(model)
        }
      }
    }

    const provider: Provider = {
      id: 'ollama',
      name: 'Ollama',
      kind: 'ollama',
      baseUrl: OLLAMA_BASE,
      isLocal: true,
      enabled: true,
      state: online ? 'online' : binary ? 'offline' : 'not-installed',
      version: version?.version,
      binaryPath: binary || undefined,
      modelsDir: modelDirs[0] || join(homedir(), '.ollama', 'models'),
      note: online
        ? '本地推理服务运行中'
        : binary
          ? diskModels.length
            ? `已检测到 ${diskModels.length} 个模型文件，点击启动服务即可使用`
            : '已安装但服务未启动，可一键启动'
          : '未检测到 Ollama；AIH 内置运行时也能直接运行 GGUF 模型'
    }
    pushProvider(provider)
    if (this.cancelled) return

    if (!online) {
      for (const model of diskModels) {
        if (this.cancelled) return
        pushModel(model)
      }
      return
    }

    const tags = await getJson<OllamaTagsResponse>(`${OLLAMA_BASE}/api/tags`, 6000)
    const list = tags?.models || []
    let enrichBudget = 16
    const enriched = await Promise.all(
      list.map(async (tag) => {
        const canEnrich = enrichBudget-- > 0
        if (this.cancelled) return null
        return parseOllamaTag(tag, canEnrich)
      })
    )
    const apiIds = new Set<string>()
    for (const m of enriched) {
      if (m && !this.cancelled) {
        apiIds.add(m.id)
        pushModel(m)
      }
    }
    // 如果服务目录之外还有其他磁盘模型，也保留展示，方便用户发现
    for (const model of diskModels) {
      if (!apiIds.has(model.id) && !this.cancelled) pushModel(model)
    }
  }

  private async scanLmStudio(pushProvider: (p: Provider) => void, pushModel: (m: ModelInfo) => void) {
    const installCandidates: string[] = [
      join(process.env.LOCALAPPDATA || '', 'Programs', 'LM Studio'),
      join(process.env.LOCALAPPDATA || '', 'LM-Studio'),
      join(process.env.LOCALAPPDATA || '', 'lm-studio')
    ]
    for (const drive of fixedDrives()) {
      installCandidates.push(
        join(drive, 'LM Studio'),
        join(drive, 'LM-Studio'),
        join(drive, 'Program Files', 'LM Studio'),
        join(drive, 'AI', 'LM Studio')
      )
    }
    const installDir = firstExisting(installCandidates)
    const modelsDir = firstExisting([join(homedir(), '.lmstudio', 'models'), join(homedir(), '.cache', 'lm-studio', 'models')])
    const online = !!(await getJson<{ data?: unknown[] }>(`${LMSTUDIO_BASE}/v1/models`, 2000))
    if (!online && !installDir && !modelsDir) return
    const provider: Provider = {
      id: 'lmstudio',
      name: 'LM Studio',
      kind: 'lmstudio',
      baseUrl: LMSTUDIO_BASE,
      isLocal: true,
      enabled: true,
      state: online ? 'online' : 'offline',
      binaryPath: installDir || undefined,
      modelsDir: modelsDir || undefined,
      note: online ? '本地服务器运行中' : '检测到 LM Studio，请启动应用并打开本地服务器（端口 1234）'
    }
    pushProvider(provider)
    if (!online) return
    try {
      const data = await getJson<{ data?: { id: string }[] }>(`${LMSTUDIO_BASE}/v1/models`, 5000)
      for (const item of data?.data || []) {
        if (this.cancelled) return
        pushModel({
          id: `lmstudio::${item.id}`,
          remoteId: item.id,
          providerId: 'lmstudio',
          providerKind: 'lmstudio',
          name: item.id,
          status: 'ready'
        })
      }
    } catch {
      /* ignore */
    }
  }

  private async scanLlamaCpp(pushProvider: (p: Provider) => void, pushModel: (m: ModelInfo) => void) {
    for (const port of LLAMACPP_PORTS) {
      if (this.cancelled) return
      const base = `http://127.0.0.1:${port}`
      const data = await getJson<{ data?: { id: string }[] }>(`${base}/v1/models`, 1200)
      if (!data) continue
      const id = `llamacpp-${port}`
      pushProvider({
        id,
        name: `llama.cpp (${port})`,
        kind: 'llamacpp',
        baseUrl: base,
        isLocal: true,
        enabled: true,
        state: 'online',
        note: 'llama.cpp 兼容服务器'
      })
      for (const item of data.data || []) {
        pushModel({
          id: `${id}::${item.id}`,
          remoteId: item.id,
          providerId: id,
          providerKind: 'llamacpp',
          name: item.id,
          status: 'ready'
        })
      }
      break
    }
  }

  private async scanCustomProviders(pushProvider: (p: Provider) => void, pushModel: (m: ModelInfo) => void) {
    try {
      const { getStore } = await import('../store')
      const providers = getStore().settings.modelSettings.providers || []
      // 并行探测，避免某个不可达的 API 拖慢本地模型扫描
      await Promise.all(
        providers.map(async (provider) => {
          if (this.cancelled) return
          if (provider.kind === 'openai' || provider.kind === 'custom') {
            let state: Provider['state'] = 'offline'
            let remote: string[] = []
            try {
              remote = await listProviderModels(provider, 5000)
              state = 'online'
            } catch {
              state = 'offline'
            }
            // 服务未暴露 /models 时，仍允许使用用户手动填写的模型名
            const names = Array.from(
              new Set([...(provider.models || []), ...remote].map((s) => String(s).trim()).filter(Boolean))
            )
            const manualOnly = state !== 'online' && (provider.models || []).length > 0
            pushProvider({
              ...provider,
              state: state === 'online' || manualOnly ? 'online' : 'offline',
              note:
                state === 'online'
                  ? provider.note
                  : manualOnly
                    ? '无法读取模型列表，使用手动填写的模型名'
                    : provider.note
            })
            for (const name of names) {
              pushModel({
                id: `${provider.id}::${name}`,
                remoteId: name,
                providerId: provider.id,
                providerKind: provider.kind,
                name,
                status: 'ready',
                supportsTools: true
              })
            }
          } else {
            // 用户手动覆盖的本地服务地址
            try {
              const remote = await listProviderModels(provider, 4000)
              pushProvider({ ...provider, state: 'online' })
              for (const name of remote) {
                pushModel({
                  id: `${provider.id}::${name}`,
                  remoteId: name,
                  providerId: provider.id,
                  providerKind: provider.kind,
                  name,
                  status: 'ready'
                })
              }
            } catch {
              pushProvider({ ...provider, state: 'offline' })
            }
          }
        })
      )
    } catch {
      /* store not ready in tests */
    }
  }

  private async scanLooseGguf(pushModel: (m: ModelInfo) => void, modelsDir?: string) {
    const roots = [
      join(homedir(), '.lmstudio', 'models'),
      join(homedir(), '.cache', 'lm-studio', 'models'),
      join(homedir(), 'Downloads'),
      join(homedir(), 'Desktop'),
      join(homedir(), 'Documents'),
      join(homedir(), 'models'),
      join(homedir(), 'Models'),
      'D:\\models',
      'D:\\AI',
      'D:\\LLM',
      'D:\\ollama',
      'C:\\models'
    ]
    // 其他盘也检查常见模型目录；不遍历整个磁盘，避免扫描过慢
    for (const drive of fixedDrives()) {
      roots.push(
        join(drive, 'models'),
        join(drive, 'Models'),
        join(drive, 'AI'),
        join(drive, 'LLM'),
        join(drive, 'ollama'),
        join(drive, 'Ollama')
      )
    }
    const normalizedModelsDir = modelsDir ? normalize(modelsDir).toLowerCase() : ''
    const modelsDirPrefix = normalizedModelsDir
      ? normalizedModelsDir.endsWith(sep)
        ? normalizedModelsDir
        : `${normalizedModelsDir}${sep}`
      : ''
    const uniqueRoots = [...new Set(roots.map((p) => normalize(p)))].filter((p) => existsSync(p))

    const started = Date.now()
    let entries = 0
    let found = 0
    // 解析真实元数据比较耗 IO：限制数量和总时间，剩余文件按文件名猜测
    let parsedMeta = 0
    const META_PARSE_LIMIT = 30
    const META_PARSE_BUDGET_MS = 6000
    const skip = new Set([
      'node_modules',
      '.git',
      'dist',
      'out',
      'AppData',
      'Windows',
      'Program Files',
      'Program Files (x86)',
      'ProgramData',
      '$Recycle.Bin',
      'System Volume Information',
      'Recovery',
      'AIH Models'
    ])

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (this.cancelled || depth > 5 || entries > 20000 || found >= 200) return
      if (Date.now() - started > 15000) return
      if (modelsDirPrefix && `${normalize(dir).toLowerCase()}${sep}`.startsWith(modelsDirPrefix)) return
      let dirents
      try {
        dirents = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      const subdirs: string[] = []
      for (const d of dirents) {
        entries++
        if (entries > 20000) return
        if (this.cancelled) return
        const full = join(dir, d.name)
        if (d.isDirectory()) {
          if (skip.has(d.name) || d.name.startsWith('.') || d.name.startsWith('$')) continue
          if (depth < 5) {
            const isModelTree = /\.(lmstudio|cache)$/i.test(dir) || looksLikeModelFolder(d.name)
            if (isModelTree || depth < 3) subdirs.push(full)
          }
        } else if (extname(d.name).toLowerCase() === '.gguf') {
          found++
          const size = await fsp.stat(full).then((s) => s.size).catch(() => 0)
          const modelName = basename(d.name, extname(d.name))
          const guessed = guessGgufMeta(d.name)
          let meta = null
          if (parsedMeta < META_PARSE_LIMIT && Date.now() - started < META_PARSE_BUDGET_MS) {
            parsedMeta++
            meta = readGgufMeta(full)
          }
          pushModel({
            id: `local-files::${normalize(full)}`,
            remoteId: modelName,
            providerId: 'local-files',
            providerKind: 'llamacpp',
            name: modelName,
            family: meta?.architecture,
            parameterSize: formatParamCount(meta?.parameterCount) || guessed.parameterSize,
            quantization: meta?.quantization || guessed.quantization,
            sizeBytes: size,
            contextLength: meta?.contextLength,
            supportsTools: meta?.supportsTools,
            supportsThinking: meta?.supportsThinking,
            supportsVision: meta?.supportsVision,
            parameterCount: meta?.parameterCount,
            gguf: meta ?? undefined,
            status: 'ready',
            filePath: full
          })
        }
      }
      for (const sub of subdirs) {
        if (this.cancelled) return
        await walk(sub, depth + 1)
      }
    }

    for (const root of uniqueRoots) {
      if (this.cancelled) break
      await walk(root, 0)
    }
  }
}

export function modelDisplayMeta(m: ModelInfo): { size: string; params: string; quant: string } {
  const size = m.sizeBytes ? formatBytes(m.sizeBytes) : ''
  return { size, params: m.parameterSize || '', quant: m.quantization || '' }
}

export function formatBytes(bytes: number): string {
  if (!bytes) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`
}

export function splitPath(p: string): string {
  return p.split(sep).join('/')
}
