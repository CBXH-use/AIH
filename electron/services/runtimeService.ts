import { app } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import { createServer } from 'net'
import { createReadStream, existsSync, readdirSync, statSync } from 'fs'
import { promises as fsp } from 'fs'
import { cpus } from 'os'
import { basename, dirname, join, normalize, sep } from 'path'
import type { Provider, ModelInfo } from '@shared/types'
import type { Store } from './store'
import { downloadToFile, formatSpeed } from './models/download'
import { guessGgufMeta, isModelFileName } from './models/discovery'

export const BUILTIN_RUNTIME_ID = 'aih-runtime'
export const BUILTIN_RUNTIME_NAME = 'AIH 本地运行时'

/**
 * 内置 llama.cpp 运行时：让没有安装 Ollama 的电脑也能直接运行 GGUF 模型。
 * 首次使用按需下载 llama-server（约 25MB），解压到用户数据目录。
 */
const RUNTIME_BUILD = 'b12359'
const RUNTIME_ZIP = `llama-${RUNTIME_BUILD}-bin-win-cpu-x64.zip`
// 与 scripts/fetch-runtime.mjs 共用同一份 SHA-256；运行期从第三方镜像下载后必须校验再解压
const RUNTIME_SHA256 = '837c1655e87df3b66989f4be33a792a1399c785bf259038dc75c900096683e69'
const RUNTIME_GH = `https://github.com/ggml-org/llama.cpp/releases/download/${RUNTIME_BUILD}/${RUNTIME_ZIP}`
const RUNTIME_URLS = [
  RUNTIME_GH,
  // GitHub 不可达时自动尝试常用镜像
  `https://gh-proxy.com/${RUNTIME_GH}`,
  `https://ghfast.top/${RUNTIME_GH}`,
  `https://ghproxy.net/${RUNTIME_GH}`
]

const RUNTIME_START_PORT = 18211

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })
}

function runCommand(cmd: string, args: string[], timeoutMs = 120000): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    let output = ''
    const child = spawn(cmd, args, { windowsHide: true })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout?.on('data', (d) => (output += d.toString()))
    child.stderr?.on('data', (d) => (output += d.toString()))
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, output: String(err) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, output })
    })
  })
}

async function pickPort(start: number): Promise<number> {
  for (let port = start; port < start + 30; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const server = createServer()
      server.once('error', () => resolve(false))
      server.once('listening', () => server.close(() => resolve(true)))
      server.listen(port, '127.0.0.1')
    })
    if (free) return port
  }
  return start
}

export class RuntimeService {
  private store: Store
  private modelsDir: string
  private child: ChildProcess | null = null
  private port: number | null = null
  private currentModel: string | null = null
  private runtimeExe: string | null = null
  private downloadAbort: AbortController | null = null
  private pending: { target: string; promise: Promise<{ ok: boolean; error?: string; provider?: Provider }> } | null = null
  private lastLog = ''
  onModelsChanged: () => void = () => {}

  constructor(store: Store, modelsDir: string) {
    this.store = store
    this.modelsDir = modelsDir
  }

  get dir(): string {
    return this.modelsDir
  }

  get runningModel(): string | null {
    return this.currentModel
  }

  get isRunning(): boolean {
    return !!this.child && !!this.port
  }

  /** 供扫描器/模型服务展示的供应商信息。 */
  provider(): Provider {
    const models = this.listModels()
    const runtimeReady = this.isRunning || !!this.findRuntimeExe() || !!this.bundledRuntimeZip()
    return {
      id: BUILTIN_RUNTIME_ID,
      name: BUILTIN_RUNTIME_NAME,
      kind: 'llamacpp',
      baseUrl: this.port ? `http://127.0.0.1:${this.port}/v1` : `http://127.0.0.1:${RUNTIME_START_PORT}/v1`,
      isLocal: true,
      enabled: true,
      state: this.isRunning ? 'online' : runtimeReady || models.length ? 'offline' : 'not-installed',
      modelsDir: this.modelsDir,
      note: this.isRunning
        ? `内置运行时 · ${this.currentModel ? basename(this.currentModel) : '已启动'}`
        : models.length
          ? `已发现 ${models.length} 个本地模型，使用时自动启动`
          : runtimeReady
            ? '内置运行时已随软件提供，下载模型后即可使用'
            : '无需安装，首次使用时自动准备'
    }
  }

  /** 已下载到 AIH 模型目录（以及手动添加）的 GGUF 模型。 */
  listModels(): ModelInfo[] {
    const paths: string[] = []
    const collect = (dir: string, depth: number) => {
      if (depth > 4) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) collect(full, depth + 1)
        else if (isModelFileName(entry.name)) paths.push(full)
      }
    }
    collect(this.modelsDir, 0)
    for (const extra of this.store.settings.modelSettings.runtimeGgufPaths || []) {
      if (existsSync(extra) && !paths.includes(extra)) paths.push(extra)
    }

    const used = new Set<string>()
    const models: ModelInfo[] = []
    for (const filePath of paths) {
      const key = normalize(filePath).toLowerCase()
      if (used.has(key)) continue
      used.add(key)
      const name = basename(filePath).replace(/\.gguf$/i, '')
      let size: number | undefined
      try {
        size = statSync(filePath).size
      } catch {
        size = undefined
      }
      const meta = guessGgufMeta(basename(filePath))
      models.push({
        id: `${BUILTIN_RUNTIME_ID}::${normalize(filePath)}`,
        remoteId: name,
        providerId: BUILTIN_RUNTIME_ID,
        providerKind: 'llamacpp',
        name,
        parameterSize: meta.parameterSize,
        quantization: meta.quantization,
        sizeBytes: size,
        contextLength: 8192,
        status: 'ready',
        filePath
      })
    }
    return models.sort((a, b) => a.name.localeCompare(b.name))
  }

  findModelByName(nameOrId: string): ModelInfo | null {
    const models = this.listModels()
    return (
      models.find((m) => m.id === nameOrId) ||
      models.find((m) => m.remoteId === nameOrId) ||
      models.find((m) => m.name === nameOrId) ||
      null
    )
  }

  /** 记住用户手动选择的 GGUF（不复制文件，避免占用双倍空间）。 */
  addExternal(filePath: string) {
    const normalized = normalize(filePath)
    if (!existsSync(normalized)) return
    if (this.isInsideModelsDir(normalized)) return
    const list = this.store.settings.modelSettings.runtimeGgufPaths || []
    if (!list.includes(normalized)) {
      this.store.updateSettings({
        modelSettings: { ...this.store.settings.modelSettings, runtimeGgufPaths: [...list, normalized] }
      })
    }
  }

  isInsideModelsDir(filePath: string): boolean {
    const dir = normalize(this.modelsDir)
    const prefix = dir.endsWith(sep) ? dir : `${dir}${sep}`
    return normalize(filePath).toLowerCase().startsWith(prefix.toLowerCase())
  }

  /** 安装包内置的运行时压缩包；存在时无需联网下载。 */
  private bundledRuntimeZip(): string | null {
    const candidates = app.isPackaged
      ? [join(process.resourcesPath, 'runtime', RUNTIME_ZIP)]
      : [
          join(app.getAppPath(), 'build', 'runtime', RUNTIME_ZIP),
          join(process.cwd(), 'build', 'runtime', RUNTIME_ZIP)
        ]
    return candidates.find((p) => existsSync(p)) || null
  }

  /** 准备内置运行时：优先解压安装包自带的压缩包，缺失时才联网下载。 */
  async downloadRuntime(signal: AbortSignal, onStep?: (pct: number, text: string) => void): Promise<string> {
    if (this.runtimeExe && existsSync(this.runtimeExe)) return this.runtimeExe
    const existing = this.findRuntimeExe()
    if (existing) {
      this.runtimeExe = existing
      return existing
    }

    const runtimeDir = join(app.getPath('userData'), 'runtime')
    const bundled = this.bundledRuntimeZip()
    if (bundled) {
      onStep?.(2, '正在准备内置运行时…')
      await this.extractRuntime(bundled, runtimeDir, onStep, false)
      const exe = this.findRuntimeExe()
      if (exe) {
        this.runtimeExe = exe
        onStep?.(19, '内置运行时已就绪')
        return exe
      }
    }

    const zipPath = join(runtimeDir, RUNTIME_ZIP)
    onStep?.(1, '正在下载内置运行时…')
    let lastSpeedAt = 0
    let lastBytes = 0
    let speed = ''
    await downloadToFile(RUNTIME_URLS, zipPath, signal, (p) => {
      const now = Date.now()
      if (now - lastSpeedAt > 500) {
        speed = formatSpeed(((p.received - lastBytes) * 1000) / Math.max(1, now - lastSpeedAt))
        lastSpeedAt = now
        lastBytes = p.received
      }
      onStep?.(2 + Math.round(p.ratio * 14), `下载内置运行时 ${Math.round(p.ratio * 100)}%${speed ? ` · ${speed}` : ''}`)
    })

    // 镜像可能返回错误页面或被篡改，解压并执行 exe 之前必须校验
    const digest = await sha256File(zipPath)
    if (digest !== RUNTIME_SHA256) {
      await fsp.unlink(zipPath).catch(() => undefined)
      throw new Error('内置运行时校验失败（下载不完整或镜像被篡改），请检查网络后重试')
    }

    await this.extractRuntime(zipPath, runtimeDir, onStep, true)
    const exe = this.findRuntimeExe()
    if (!exe) throw new Error('内置运行时解压失败')
    this.runtimeExe = exe
    onStep?.(19, '内置运行时已就绪')
    return exe
  }

  private async extractRuntime(
    zipPath: string,
    runtimeDir: string,
    onStep?: (pct: number, text: string) => void,
    cleanupZip = true
  ): Promise<void> {
    onStep?.(16, '正在解压内置运行时…')
    await fsp.mkdir(runtimeDir, { recursive: true })
    const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    let result = await runCommand(existsSync(tar) ? tar : 'tar.exe', ['-xf', zipPath, '-C', runtimeDir], 180000)
    if (result.code !== 0) {
      result = await runCommand(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${runtimeDir.replace(/'/g, "''")}' -Force`
        ],
        180000
      )
    }
    if (cleanupZip) await fsp.unlink(zipPath).catch(() => undefined)
    if (result.code !== 0 && !this.findRuntimeExe()) {
      throw new Error(`内置运行时解压失败${result.output ? `：${result.output.slice(-200)}` : ''}`)
    }
  }

  private findRuntimeExe(): string | null {
    const root = join(app.getPath('userData'), 'runtime')
    const direct = join(root, 'llama-server.exe')
    if (existsSync(direct)) return direct
    const walk = (dir: string, depth: number): string | null => {
      if (depth > 4) return null
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return null
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isFile() && entry.name.toLowerCase() === 'llama-server.exe') return full
        if (entry.isDirectory()) {
          const found = walk(full, depth + 1)
          if (found) return found
        }
      }
      return null
    }
    return walk(root, 0)
  }

  /** 启动（或切换到）指定 GGUF 模型。 */
  async ensure(modelPath?: string, onStep?: (pct: number, text: string) => void): Promise<{ ok: boolean; error?: string; provider?: Provider }> {
    const target = this.resolveTarget(modelPath)
    if (!target) return { ok: false, error: '还没有可运行的模型，请先下载一个模型' }
    if (this.pending) {
      // 同一个目标：复用进行中的启动；不同目标：先等它结束，避免把别的模型的 Promise 返回给调用方
      if (this.pending.target === target) return this.pending.promise
      await this.pending.promise.catch(() => undefined)
    }
    const promise: Promise<{ ok: boolean; error?: string; provider?: Provider }> = this.doEnsure(target, onStep).finally(() => {
      if (this.pending && this.pending.promise === promise) this.pending = null
    })
    this.pending = { target, promise }
    return promise
  }

  private resolveTarget(modelPath?: string): string {
    return modelPath || this.currentModel || this.listModels()[0]?.filePath || ''
  }

  private async doEnsure(target: string, onStep?: (pct: number, text: string) => void): Promise<{ ok: boolean; error?: string; provider?: Provider }> {
    if (!existsSync(target)) return { ok: false, error: `模型文件不存在：${target}` }

    if (this.child && this.currentModel === target && this.port && (await this.healthy(this.port))) {
      return { ok: true, provider: this.provider() }
    }

    const abort = new AbortController()
    this.downloadAbort = abort
    try {
      const exe = await this.downloadRuntime(abort.signal, onStep)
      this.stopServer()

      const port = await pickPort(RUNTIME_START_PORT)
      const ctx = Math.max(2048, Math.min(32768, this.store.settings.harness.context.window || 8192))
      const threads = Math.max(2, Math.min(16, cpus().length - 1))
      onStep?.(90, '正在启动模型…')
      this.lastLog = ''
      const child = spawn(
        exe,
        [
          '-m',
          target,
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
          '-c',
          String(ctx),
          '--jinja',
          '-t',
          String(threads)
        ],
        { windowsHide: true, cwd: dirname(exe), stdio: ['ignore', 'pipe', 'pipe'] }
      )
      this.child = child
      this.port = port
      this.currentModel = target
      child.stdout?.on('data', (d) => this.appendLog(d))
      child.stderr?.on('data', (d) => this.appendLog(d))

      let exited = false
      child.once('exit', () => {
        exited = true
        if (this.child === child) {
          this.child = null
          this.port = null
          this.currentModel = null
        }
      })

      for (let i = 0; i < 480; i++) {
        if (abort.signal.aborted) {
          this.stopServer()
          return { ok: false, error: '已取消' }
        }
        if (exited) break
        await new Promise((r) => setTimeout(r, 500))
        if (await this.healthy(port)) {
          onStep?.(100, '模型已就绪')
          this.onModelsChanged()
          return { ok: true, provider: this.provider() }
        }
      }

      this.stopServer()
      return {
        ok: false,
        error: exited
          ? `内置运行时启动失败：${this.lastLog.slice(-300) || '进程已退出'}`
          : '模型加载超时，请稍后重试'
      }
    } catch (err) {
      if (this.child && !this.port) this.stopServer()
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      if (this.downloadAbort === abort) this.downloadAbort = null
    }
  }

  private appendLog(chunk: Buffer) {
    this.lastLog = (this.lastLog + chunk.toString()).slice(-4000)
  }

  private async healthy(port: number): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(1200) })
      return res.ok
    } catch {
      return false
    }
  }

  cancelDownload() {
    this.downloadAbort?.abort()
  }

  stopServer() {
    if (this.child) {
      try {
        this.child.kill()
      } catch {
        /* ignore */
      }
      this.child = null
    }
    this.port = null
    this.currentModel = null
  }

  /** 停止并等待进程退出，用户删除模型前必须调用（否则 Windows 上文件被占用无法删除） */
  async stopAndWait(timeoutMs = 3000): Promise<void> {
    const child = this.child
    this.port = null
    this.currentModel = null
    if (!child) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        child.kill()
      } catch {
        clearTimeout(timer)
        resolve()
      }
    })
    if (this.child === child) this.child = null
  }

  dispose() {
    this.cancelDownload()
    this.stopServer()
  }
}
