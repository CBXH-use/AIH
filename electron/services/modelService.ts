import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, promises as fsp } from 'fs'
import { homedir, tmpdir } from 'os'
import { basename, join, normalize } from 'path'
import type { ApiResult } from '@shared/ipc'
import type { DeployEvent, HardwareInfo, ModelInfo, ModelRef, Provider, RecommendedModel, ScanEvent } from '@shared/types'
import { RECOMMENDED_MODELS } from '@shared/defaults'
import { Store } from './store'
import { listProviderModels, probeProviderChat } from './models/llmClient'
import { ModelScanner, type ScanOptions } from './models/scanner'
import { findOllamaBinary, resolveAihModelsDir } from './models/discovery'
import { downloadToFile, formatSpeed } from './models/download'
import { BUILTIN_RUNTIME_ID, RuntimeService } from './runtimeService'
import { scoreModelFit } from './models/fit'

const OLLAMA_BASE = 'http://127.0.0.1:11434'

function ollamaBinary(): string | null {
  const detected = findOllamaBinary()
  return detected && existsSync(detected) ? detected : null
}

function run(cmd: string, args: string[], timeoutMs = 120000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
    }, timeoutMs)
    child.stdout?.on('data', (d) => (stdout += d.toString()))
    child.stderr?.on('data', (d) => (stderr += d.toString()))
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: String(err) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

function parsePercent(line: string): number | null {
  const m = line.match(/(\d{1,3})%/)
  if (m) return Math.min(100, Math.max(0, Number(m[1])))
  return null
}

function safeName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || `model-${Date.now()}`
}

export class ModelService {
  private scanner = new ModelScanner()
  private runtime: RuntimeService
  private providers: Provider[] = []
  private models: ModelInfo[] = []
  private pulling = new Map<string, ChildProcess>()
  private downloading = new Map<string, AbortController>()
  private warmed = new Map<string, number>()
  private store: Store
  private hardware: HardwareInfo | null = null
  private emitScan: (e: ScanEvent) => void
  private emitDeploy: (e: DeployEvent) => void

  constructor(store: Store, emitScan: (e: ScanEvent) => void, emitDeploy: (e: DeployEvent) => void) {
    this.store = store
    this.emitScan = emitScan
    this.emitDeploy = emitDeploy
    this.runtime = new RuntimeService(store, this.resolveModelsDir())
  }

  /** 首次启动时选择剩余空间最大的磁盘保存模型，避免把 C 盘塞满。 */
  private resolveModelsDir(): string {
    const settings = this.store.settings.modelSettings
    let dir = resolveAihModelsDir(settings.modelsDir)
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      dir = join(homedir(), 'AIH Models')
      try {
        mkdirSync(dir, { recursive: true })
      } catch {
        /* 目录不可写时，下载阶段会给出明确错误 */
      }
    }
    if (!settings.modelsDir) {
      this.store.updateSettings({
        modelSettings: { ...settings, modelsDir: dir }
      })
    }
    return dir
  }

  getProviders(): Provider[] {
    return this.providers
  }

  getModels(): ModelInfo[] {
    return this.models
  }

  /** 硬件探测完成后调用：给现有模型补上适配评分（bootstrap 之后到达也能刷新 UI） */
  setHardware(hw: HardwareInfo): ModelInfo[] {
    this.hardware = hw
    this.applyFit()
    return this.models
  }

  private applyFit() {
    if (!this.hardware) return
    for (const model of this.models) {
      try {
        model.fit = scoreModelFit(model, this.hardware)
      } catch {
        model.fit = undefined
      }
    }
  }

  recommended(hardware?: HardwareInfo): RecommendedModel[] {
    const hw = hardware
    const rank: Record<'great' | 'ok' | 'heavy', number> = { great: 0, ok: 1, heavy: 2 }
    return RECOMMENDED_MODELS.map((m) => {
      let fit: 'great' | 'ok' | 'heavy' = 'ok'
      if (hw) {
        const ramOk = hw.totalRamGb >= m.minRamGb
        const vramOk = !m.vramGb || (hw.vramGb || 0) >= m.vramGb
        if (!ramOk || !vramOk) fit = 'heavy'
        else if (hw.totalRamGb >= m.minRamGb + 8 && (!m.vramGb || (hw.vramGb || 0) >= m.vramGb + 4)) fit = 'great'
        else fit = 'ok'
      }
      return { ...m, fit }
    }).sort((a, b) => rank[a.fit || 'ok'] - rank[b.fit || 'ok'] || a.sizeBytes - b.sizeBytes)
  }

  cancelScan() {
    this.scanner.cancel()
  }

  async scan(opts: ScanOptions = {}): Promise<ModelInfo[]> {
    this.providers = []
    this.models = []
    const models = await this.scanner.scan(
      { ...opts, modelsDir: this.runtime.dir },
      (e) => {
        if (e.type === 'provider' && e.provider) {
          const existing = this.providers.findIndex((p) => p.id === e.provider!.id)
          if (existing >= 0) this.providers[existing] = e.provider
          else this.providers.push(e.provider)
        }
        if (e.type === 'model' && e.model) {
          if (!this.models.find((m) => m.id === e.model!.id)) this.models.push(e.model)
        }
        this.emitScan(e)
      }
    )
    this.models = models

    // 已经交给内置运行时使用的 GGUF，不再在「磁盘 GGUF」里重复展示
    const externalUsed = new Set(
      (this.store.settings.modelSettings.runtimeGgufPaths || []).map((p) => normalize(p).toLowerCase())
    )
    this.models = this.models.filter(
      (m) => !(m.providerId === 'local-files' && m.filePath && externalUsed.has(normalize(m.filePath).toLowerCase()))
    )

    // 内置运行时：即使没装 Ollama，也能发现 AIH 已下载的 GGUF 模型
    const runtimeProvider = this.runtime.provider()
    const runtimeIndex = this.providers.findIndex((p) => p.id === BUILTIN_RUNTIME_ID)
    if (runtimeIndex >= 0) this.providers[runtimeIndex] = runtimeProvider
    else this.providers.push(runtimeProvider)
    this.emitScan({ type: 'provider', provider: runtimeProvider })
    for (const model of this.runtime.listModels()) {
      if (this.models.some((m) => m.id === model.id)) continue
      this.models.push(model)
      this.emitScan({ type: 'model', model })
    }

    const detected = this.providers.filter(
      (p) => p.id === BUILTIN_RUNTIME_ID || ['ollama', 'lmstudio', 'llamacpp', 'local-files'].some((k) => p.id === k || p.id.startsWith('llamacpp-'))
    )
    const custom = this.store.settings.modelSettings.providers.filter((p) => p.kind === 'openai' || p.kind === 'custom')
    const merged = [...detected, ...custom]
    const binaryPaths: Record<string, string> = {}
    for (const p of detected) if (p.binaryPath) binaryPaths[p.id] = p.binaryPath
    this.store.updateSettings({
      modelSettings: {
        ...this.store.settings.modelSettings,
        providers: merged,
        detectedBinaryPaths: binaryPaths,
        installedModelIds: this.models
          .filter((m) => m.providerKind === 'ollama' || m.providerId === BUILTIN_RUNTIME_ID)
          .map((m) => m.id)
      }
    })
    this.emitScan({ type: 'done' })
    this.applyFit()
    return this.models
  }

  private async ensureOllama(): Promise<{ binary: string; online: boolean }> {
    const detected = this.store.settings.modelSettings.detectedBinaryPaths?.['ollama']
    const binary = (detected && existsSync(detected) ? detected : null) || ollamaBinary()
    let online = false
    try {
      const res = await fetch(`${OLLAMA_BASE}/api/version`, { signal: AbortSignal.timeout(1500) })
      online = res.ok
    } catch {
      online = false
    }
    if (!online && binary) {
      await this.startProvider('ollama')
      try {
        const res = await fetch(`${OLLAMA_BASE}/api/version`, { signal: AbortSignal.timeout(1500) })
        online = res.ok
      } catch {
        online = false
      }
    }
    return { binary: binary || 'ollama', online }
  }

  /** 启动本地推理服务（内置运行时 / Ollama / LM Studio） */
  async startProvider(id: string): Promise<ApiResult<Provider>> {
    if (id === BUILTIN_RUNTIME_ID) {
      const result = await this.runtime.ensure()
      if (!result.ok || !result.provider) return { ok: false, error: result.error || '内置运行时启动失败' }
      this.providers = [...this.providers.filter((p) => p.id !== BUILTIN_RUNTIME_ID), result.provider]
      return { ok: true, data: result.provider }
    }
    const provider = this.providers.find((p) => p.id === id)
    if (id === 'ollama') {
      const binary = ollamaBinary()
      if (!binary) return { ok: false, error: '未检测到 Ollama，可改用 AIH 内置运行时直接运行 GGUF 模型' }
      // 优先启动桌面应用：它会带上用户配置的模型目录（例如 D:\models），
      // 直接 `ollama serve` 可能读到默认空目录。
      const appExe = join(binary, '..', 'ollama app.exe')
      try {
        const exe = existsSync(appExe) ? appExe : binary
        const args = existsSync(appExe) ? [] : ['serve']
        // Ollama 装在非默认目录或模型被移动过时，显式告诉服务去哪里找模型
        const env = { ...process.env, ...(provider?.modelsDir ? { OLLAMA_MODELS: provider.modelsDir } : {}) }
        const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true, env })
        child.unref()
      } catch (err) {
        return { ok: false, error: `启动 Ollama 失败：${String(err)}` }
      }
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 500))
        try {
          const res = await fetch(`${OLLAMA_BASE}/api/version`, { signal: AbortSignal.timeout(1000) })
          if (res.ok) {
            const updated: Provider = { ...(provider || ({ id: 'ollama', name: 'Ollama', kind: 'ollama', baseUrl: OLLAMA_BASE, isLocal: true, enabled: true } as Provider)), state: 'online', note: '本地推理服务运行中', binaryPath: binary }
            const idx = this.providers.findIndex((p) => p.id === 'ollama')
            if (idx >= 0) this.providers[idx] = updated
            else this.providers.push(updated)
            return { ok: true, data: updated }
          }
        } catch {
          /* keep waiting */
        }
      }
      return { ok: false, error: 'Ollama 启动超时，请手动在终端运行 ollama serve' }
    }
    if (provider?.kind === 'lmstudio' && provider.binaryPath) {
      const exe = join(provider.binaryPath, 'LM Studio.exe')
      if (existsSync(exe)) {
        const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false })
        child.unref()
        return { ok: true, data: { ...provider, note: '正在启动 LM Studio，请在应用内开启本地服务器（端口 1234）' } }
      }
    }
    return { ok: false, error: '该服务不支持自动启动，请手动启动后重试' }
  }

  async deploy(modelId: string): Promise<ApiResult> {
    // 推荐模型的一键下载：直接下载 GGUF，用内置运行时启动，不依赖 Ollama
    if (modelId.startsWith('aih::')) {
      return this.deployRecommendedGguf(modelId.slice('aih::'.length), modelId)
    }

    const model =
      this.models.find((m) => m.id === modelId) ||
      this.runtime.findModelByName(modelId)

    if (model?.providerId === BUILTIN_RUNTIME_ID && model.filePath) {
      return this.runBuiltinRuntime(model, modelId)
    }

    if (model?.providerId === 'local-files' && model.filePath) {
      const { binary, online } = await this.ensureOllama()
      if (online) return this.importGguf(binary, model)
      this.runtime.addExternal(model.filePath)
      return this.runBuiltinRuntime(model, modelId)
    }

    const { binary, online } = await this.ensureOllama()
    if (!online) {
      return { ok: false, error: '未检测到可用的本地运行时。请检查网络后重试，或在「模型与 API」页接入在线 API。' }
    }
    this.emitDeploy({ modelId, status: 'starting', progress: 0, message: '准备下载...' })

    let tag = model?.remoteId
    if (!tag) {
      const [providerId, remote] = modelId.split('::')
      if (providerId !== 'ollama' || !remote) return { ok: false, error: '暂时无法识别该模型' }
      tag = remote
    }

    return new Promise<ApiResult>((resolve) => {
      const child = spawn(binary, ['pull', tag], { windowsHide: true, env: { ...process.env } })
      this.pulling.set(modelId, child)
      let lastPct = 0
      let output = ''
      const onData = (chunk: Buffer) => {
        const text = chunk.toString()
        output += text
        for (const line of text.split(/\r?\n/)) {
          const pct = parsePercent(line)
          if (pct !== null) {
            lastPct = Math.max(lastPct, pct)
            this.emitDeploy({
              modelId,
              status: 'progress',
              progress: Math.min(99, lastPct),
              message: line.replace(/\s+/g, ' ').slice(0, 120)
            })
          } else if (line.trim()) {
            this.emitDeploy({ modelId, status: 'progress', progress: lastPct, message: line.trim().slice(0, 120) })
          }
        }
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      child.on('error', (err) => {
        this.pulling.delete(modelId)
        this.emitDeploy({ modelId, status: 'error', message: String(err) })
        resolve({ ok: false, error: String(err) })
      })
      child.on('close', async (code) => {
        this.pulling.delete(modelId)
        if (code === 0) {
          this.emitDeploy({ modelId, status: 'done', progress: 100, message: '部署完成' })
          await this.scan({ quick: true })
          resolve({ ok: true })
        } else if (child.killed) {
          this.emitDeploy({ modelId, status: 'cancelled', message: '已取消' })
          resolve({ ok: false, error: '已取消' })
        } else {
          this.emitDeploy({ modelId, status: 'error', message: output.slice(-300) || `退出码 ${code}` })
          resolve({ ok: false, error: output.slice(-300) || `下载失败（退出码 ${code}）` })
        }
      })
    })
  }

  /** 下载推荐 GGUF 到本地模型目录，并用内置运行时启动。 */
  private async deployRecommendedGguf(recId: string, modelId: string): Promise<ApiResult> {
    const rec = RECOMMENDED_MODELS.find((r) => r.id === recId)
    if (!rec?.gguf) return { ok: false, error: '该模型暂不支持一键下载' }
    const gguf = rec.gguf
    const dest = join(this.runtime.dir, gguf.file)
    this.emitDeploy({ modelId, status: 'starting', progress: 0, message: '准备下载…' })

    const abort = new AbortController()
    this.downloading.set(modelId, abort)
    try {
      if (!existsSync(dest)) {
        // 先把内置运行时准备好（已安装时会直接跳过）
        await this.runtime.downloadRuntime(abort.signal, (pct, text) =>
          this.emitDeploy({ modelId, status: 'progress', progress: Math.round(pct * 0.15), message: text })
        )
        const urls = [
          `https://modelscope.cn/models/${gguf.repo}/resolve/master/${encodeURIComponent(gguf.file)}`,
          `https://huggingface.co/${gguf.repo}/resolve/main/${encodeURIComponent(gguf.file)}`
        ]
        let lastAt = 0
        let lastBytes = 0
        let speed = ''
        await downloadToFile(urls, dest, abort.signal, (p) => {
          const now = Date.now()
          if (now - lastAt > 500) {
            speed = formatSpeed(((p.received - lastBytes) * 1000) / Math.max(1, now - lastAt))
            lastAt = now
            lastBytes = p.received
          }
          this.emitDeploy({
            modelId,
            status: 'progress',
            progress: Math.round(15 + p.ratio * 77),
            message: `下载模型 ${Math.round(p.ratio * 100)}%${speed ? ` · ${speed}` : ''}`
          })
        })
      }

      const result = await this.runtime.ensure(dest, (pct, text) =>
        this.emitDeploy({ modelId, status: 'progress', progress: 92 + Math.round(Math.min(100, pct) * 0.08), message: text })
      )
      if (!result.ok) {
        this.emitDeploy({ modelId, status: 'error', message: result.error })
        return { ok: false, error: result.error }
      }
      await this.scan({ quick: true })
      this.emitDeploy({ modelId, status: 'done', progress: 100, message: '部署完成' })
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (abort.signal.aborted) {
        this.emitDeploy({ modelId, status: 'cancelled', message: '已取消' })
        return { ok: false, error: '已取消' }
      }
      this.emitDeploy({ modelId, status: 'error', message })
      return { ok: false, error: message }
    } finally {
      this.downloading.delete(modelId)
    }
  }

  /** 使用内置 llama.cpp 运行时直接加载 GGUF。 */
  private async runBuiltinRuntime(model: ModelInfo, modelId: string): Promise<ApiResult> {
    if (!model.filePath) return { ok: false, error: '文件路径缺失' }
    this.emitDeploy({ modelId, status: 'starting', progress: 0, message: '准备运行模型…' })
    const result = await this.runtime.ensure(model.filePath, (pct, text) =>
      this.emitDeploy({ modelId, status: 'progress', progress: Math.max(1, Math.min(99, pct)), message: text })
    )
    if (!result.ok) {
      this.emitDeploy({ modelId, status: 'error', message: result.error })
      return { ok: false, error: result.error }
    }
    await this.scan({ quick: true })
    this.emitDeploy({ modelId, status: 'done', progress: 100, message: '部署完成' })
    return { ok: true }
  }

  /** 供对话引擎调用：确保指定内置运行时模型已经启动。 */
  async ensureRuntimeModel(remoteId: string): Promise<Provider | null> {
    const model = this.runtime.findModelByName(remoteId)
    if (!model?.filePath) return null
    const result = await this.runtime.ensure(model.filePath)
    if (!result.ok || !result.provider) return null
    this.providers = [...this.providers.filter((p) => p.id !== BUILTIN_RUNTIME_ID), result.provider]
    return result.provider
  }

  private async importGguf(binary: string, model: ModelInfo): Promise<ApiResult> {
    if (!model.filePath) return { ok: false, error: '文件路径缺失' }
    const name = safeName(model.remoteId)
    const modelfile = join(tmpdir(), `aih-${name}-${Date.now()}.Modelfile`)
    try {
      await fsp.writeFile(
        modelfile,
        `FROM "${model.filePath.replace(/\\/g, '/')}"\nPARAMETER num_ctx 32768\n`,
        'utf8'
      )
    } catch (err) {
      return { ok: false, error: `无法写入 Modelfile：${String(err)}` }
    }
    this.emitDeploy({ modelId: model.id, status: 'progress', progress: 30, message: '正在导入 GGUF...' })
    const result = await run(binary, ['create', name, '-f', modelfile], 600000)
    await fsp.unlink(modelfile).catch(() => undefined)
    if (result.code === 0) {
      this.emitDeploy({ modelId: model.id, status: 'done', progress: 100, message: `已导入为 ollama 模型 ${name}` })
      await this.scan({ quick: true })
      return { ok: true }
    }
    this.emitDeploy({ modelId: model.id, status: 'error', message: result.stderr || result.stdout })
    return { ok: false, error: (result.stderr || result.stdout || '导入失败').slice(-300) }
  }

  cancelDeploy(modelId: string) {
    const child = this.pulling.get(modelId)
    if (child) {
      child.kill()
      this.pulling.delete(modelId)
    }
    const controller = this.downloading.get(modelId)
    if (controller) {
      controller.abort()
      this.downloading.delete(modelId)
    }
    this.runtime.cancelDownload()
  }

  /** 直接导入用户选择的 .gguf 文件 */
  async importGgufFile(path: string): Promise<ApiResult> {
    if (!path.toLowerCase().endsWith('.gguf')) return { ok: false, error: '请选择 .gguf 文件' }
    if (!existsSync(path)) return { ok: false, error: '文件不存在' }

    const { binary, online } = await this.ensureOllama()
    const name = basename(path).replace(/\.gguf$/i, '')
    const model: ModelInfo = {
      id: `local-files::${normalize(path)}`,
      remoteId: name,
      providerId: 'local-files',
      providerKind: 'llamacpp',
      name,
      status: 'ready',
      filePath: path
    }

    // 没装 Ollama 时，直接用内置运行时加载，不复制、不改动原文件
    if (!online) {
      this.runtime.addExternal(path)
      return this.runBuiltinRuntime(model, model.id)
    }

    return this.importGguf(binary, model)
  }

  async remove(modelId: string): Promise<ApiResult> {
    const model = this.models.find((m) => m.id === modelId) || this.runtime.findModelByName(modelId)
    if (!model) return { ok: false, error: '模型不存在' }
    if (model.providerId === 'local-files') {
      return { ok: false, error: '为避免误删你的文件，AIH 不会删除磁盘上的 GGUF 文件' }
    }
    if (model.providerId === BUILTIN_RUNTIME_ID) {
      const path = model.filePath
      const inModelsDir = path && this.runtime.isInsideModelsDir(path)
      if (!path || !inModelsDir) return { ok: false, error: '该模型在 AIH 模型目录之外，为避免误删不会自动删除' }
      // Windows 上 llama-server 会锁住模型文件，必须先停服并等进程退出再删
      if (this.runtime.runningModel === path) await this.runtime.stopAndWait()
      let lastError: unknown = null
      for (let i = 0; i < 5; i++) {
        try {
          await fsp.unlink(path)
          lastError = null
          break
        } catch (err) {
          lastError = err
          await new Promise((resolve) => setTimeout(resolve, 300))
        }
      }
      if (lastError) return { ok: false, error: `删除失败：${String(lastError)}` }
      this.models = this.models.filter((m) => m.id !== modelId)
      this.providers = [...this.providers.filter((p) => p.id !== BUILTIN_RUNTIME_ID), this.runtime.provider()]
      return { ok: true }
    }
    if (model.providerId !== 'ollama') return { ok: false, error: '只能删除本地 Ollama 模型' }
    const binary = ollamaBinary()
    if (!binary) return { ok: false, error: '未检测到 Ollama' }
    const res = await run(binary, ['rm', model.remoteId], 30000)
    if (res.code !== 0) return { ok: false, error: res.stderr || '删除失败' }
    this.models = this.models.filter((m) => m.id !== modelId)
    return { ok: true }
  }

  async saveProvider(input: Partial<Provider> & { name: string; kind: Provider['kind']; baseUrl: string }): Promise<ApiResult<Provider>> {
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, '')
    if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, error: '地址需以 http:// 或 https:// 开头' }
    const providers = this.store.settings.modelSettings.providers
    const existing = input.id ? providers.find((p) => p.id === input.id) : undefined
    const id = input.id || `custom-${Date.now().toString(36)}`
    const models = Array.from(
      new Set(
        (input.models !== undefined ? input.models : existing?.models || [])
          .map((m) => String(m).trim())
          .filter(Boolean)
      )
    )
    const provider: Provider = {
      id,
      name: input.name.trim() || '自定义 API',
      kind: input.kind,
      baseUrl,
      // 编辑时留空表示沿用已保存的密钥
      apiKey: input.apiKey?.trim() || existing?.apiKey || '',
      models,
      isLocal: /^https?:\/\/(127\.0\.0\.1|localhost)/i.test(baseUrl),
      enabled: true,
      state: 'offline',
      note: input.note
    }
    const next = providers.filter((p) => p.id !== id)
    next.push(provider)
    this.store.updateSettings({ modelSettings: { ...this.store.settings.modelSettings, providers: next } })
    return { ok: true, data: provider }
  }

  /** 提前把模型加载进显存/内存，减少第一条消息的等待时间 */
  async warmup(ref: ModelRef): Promise<void> {
    try {
      if (ref.providerId === BUILTIN_RUNTIME_ID) {
        const key = `runtime::${ref.modelId}`
        const now = Date.now()
        if ((this.warmed.get(key) || 0) > now - 10 * 60_000) return
        this.warmed.set(key, now)
        const model = this.runtime.findModelByName(ref.modelId)
        if (!model?.filePath) return
        const result = await this.runtime.ensure(model.filePath)
        if (result.ok && result.provider) {
          this.providers = [...this.providers.filter((p) => p.id !== BUILTIN_RUNTIME_ID), result.provider]
        } else {
          this.warmed.delete(key)
        }
        return
      }

      const provider =
        this.providers.find((p) => p.id === ref.providerId) ||
        this.store.settings.modelSettings.providers.find((p) => p.id === ref.providerId)
      if (!provider || provider.kind !== 'ollama') return
      const key = `${ref.providerId}::${ref.modelId}`
      const now = Date.now()
      if ((this.warmed.get(key) || 0) > now - 10 * 60_000) return
      this.warmed.set(key, now)
      const cfg = this.store.settings.harness
      const keepAlive = `${Math.max(1, cfg.keepAliveMin ?? 30)}m`
      const info = this.models.find((m) => m.providerId === ref.providerId && m.remoteId === ref.modelId)
      const numCtx = Math.max(2048, Math.min(cfg.context.window || 8192, info?.contextLength || Number.MAX_SAFE_INTEGER))
      const res = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {})
        },
        body: JSON.stringify({
          model: ref.modelId,
          prompt: '',
          stream: false,
          keep_alive: keepAlive,
          options: { num_ctx: numCtx, num_predict: 1 }
        }),
        signal: AbortSignal.timeout(120000)
      })
      if (!res.ok) this.warmed.delete(key)
    } catch {
      // 预热失败不影响正常对话
    }
  }

  async removeProvider(id: string): Promise<ApiResult> {
    const providers = this.store.settings.modelSettings.providers.filter((p) => p.id !== id)
    this.store.updateSettings({ modelSettings: { ...this.store.settings.modelSettings, providers } })
    this.providers = this.providers.filter((p) => p.id !== id)
    this.models = this.models.filter((m) => m.providerId !== id)
    return { ok: true }
  }

  async testProvider(id: string): Promise<ApiResult<{ state: Provider['state']; models: number }>> {
    if (id === BUILTIN_RUNTIME_ID) {
      const started = await this.startProvider(BUILTIN_RUNTIME_ID)
      if (!started.ok) return { ok: false, error: started.error }
      return { ok: true, data: { state: 'online', models: this.runtime.listModels().length } }
    }
    const provider =
      this.providers.find((p) => p.id === id) ||
      this.store.settings.modelSettings.providers.find((p) => p.id === id)
    if (!provider) return { ok: false, error: '供应商不存在' }
    try {
      const models = await listProviderModels(provider, 8000)
      const idx = this.providers.findIndex((p) => p.id === id)
      if (idx >= 0) this.providers[idx] = { ...this.providers[idx], state: 'online' }
      return { ok: true, data: { state: 'online', models: models.length } }
    } catch (err) {
      // /models 不可用时，用第一个手动模型发起一次最小请求验证
      const manual = provider.models || []
      if (manual.length) {
        try {
          await probeProviderChat(provider, manual[0], 12000)
          const idx = this.providers.findIndex((p) => p.id === id)
          if (idx >= 0) this.providers[idx] = { ...this.providers[idx], state: 'online', note: '使用手动模型列表' }
          return { ok: true, data: { state: 'online', models: manual.length } }
        } catch (probeErr) {
          return { ok: false, error: `连接失败：${String(probeErr)}` }
        }
      }
      return { ok: false, error: `连接失败：${String(err)}` }
    }
  }

  dispose() {
    for (const child of this.pulling.values()) child.kill()
    this.pulling.clear()
    for (const controller of this.downloading.values()) controller.abort()
    this.downloading.clear()
    this.runtime.dispose()
    this.scanner.cancel()
  }
}
