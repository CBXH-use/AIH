import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import type { ApiResult, UpdateCheckResult, UpdateEvent } from '@shared/ipc'
import { isNewerVersion, isSafeDownloadUrl, pickReleaseAssets, parseChecksums } from '@shared/update'

const REPO = 'CBXH-use/AIH'
const DEFAULT_API_BASE = 'https://api.github.com'
const CHECK_TIMEOUT_MS = 12_000
const CACHE_MS = 30 * 60 * 1000

interface GitHubRelease {
  tag_name?: string
  html_url?: string
  body?: string
  assets?: { name?: string; browser_download_url?: string; size?: number }[]
}

export interface UpdateServiceDeps {
  userDataDir: string
  currentVersion: string
  /** 自检/镜像用：覆盖 GitHub API 根地址（默认 https://api.github.com） */
  apiBase?: string
  emit: (event: UpdateEvent) => void
  /** 安装前清理：落盘数据、停子进程、退出应用 */
  quit: () => void
}

/**
 * 应用内自动更新（不依赖 electron-updater）：
 *  - 读 GitHub Release 元数据判断版本
 *  - 下载官方安装包，并用 Release 里的 SHA256SUMS.txt 校验
 *  - 校验通过后静默启动 NSIS 安装包，退出当前进程完成升级
 * 更新文件不经过第三方，且校验失败会删除下载文件，避免执行被篡改的安装包。
 */
export class UpdateService {
  private readonly deps: UpdateServiceDeps
  private readonly apiBase: string
  private last: UpdateCheckResult | null = null
  private lastCheckAt = 0
  private lastInstallerName: string | null = null
  private checking: Promise<ApiResult<UpdateCheckResult>> | null = null
  private downloading: Promise<ApiResult<{ path: string }>> | null = null
  private downloadedPath: string | null = null
  private downloadedHash: string | null = null

  constructor(deps: UpdateServiceDeps) {
    this.deps = deps
    this.apiBase = (deps.apiBase || process.env.AIH_UPDATE_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '')
  }

  get cached(): UpdateCheckResult | null {
    return this.last
  }

  private emit(event: UpdateEvent) {
    try {
      this.deps.emit(event)
    } catch {
      /* 事件发送失败不影响更新流程 */
    }
  }

  private updatesDir(): string {
    return join(this.deps.userDataDir, 'updates')
  }

  /** 检查更新；force=false 时 30 分钟内复用上次结果，避免每次打开设置都请求 GitHub */
  async check(force = false): Promise<ApiResult<UpdateCheckResult>> {
    if (!force && this.last && Date.now() - this.lastCheckAt < CACHE_MS) {
      return { ok: true, data: this.last }
    }
    if (this.checking) return this.checking
    this.emit({ phase: 'checking' })
    this.checking = this.doCheck().finally(() => {
      this.checking = null
    })
    return this.checking
  }

  private async doCheck(): Promise<ApiResult<UpdateCheckResult>> {
    try {
      const res = await fetch(`${this.apiBase}/repos/${REPO}/releases/latest`, {
        headers: {
          'User-Agent': `AIH/${this.deps.currentVersion}`,
          Accept: 'application/vnd.github+json'
        },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS)
      })
      if (!res.ok) {
        const error = `检查更新失败：HTTP ${res.status}`
        this.emit({ phase: 'error', message: error })
        return { ok: false, error }
      }
      const data = (await res.json()) as GitHubRelease
      const latest = String(data.tag_name || '')
        .replace(/^v/i, '')
        .trim()
      const current = this.deps.currentVersion
      if (!latest) {
        const error = '检查更新失败：Release 里没有版本号'
        this.emit({ phase: 'error', message: error })
        return { ok: false, error }
      }
      const picked = pickReleaseAssets(data.assets)
      const result: UpdateCheckResult = {
        current,
        latest,
        hasUpdate: isNewerVersion(latest, current),
        url: String(data.html_url || `https://github.com/${REPO}/releases`),
        notes: typeof data.body === 'string' ? data.body.slice(0, 4000) : '',
        canAutoInstall: false,
        checkedAt: Date.now()
      }
      if (picked.installer?.name && picked.installer.browser_download_url && isSafeDownloadUrl(picked.installer.browser_download_url)) {
        result.installer = {
          name: picked.installer.name,
          url: picked.installer.browser_download_url,
          size: picked.installer.size
        }
      }
      if (picked.portable?.name && picked.portable.browser_download_url && isSafeDownloadUrl(picked.portable.browser_download_url)) {
        result.portable = {
          name: picked.portable.name,
          url: picked.portable.browser_download_url,
          size: picked.portable.size
        }
      }
      if (picked.checksums?.name && picked.checksums.browser_download_url && isSafeDownloadUrl(picked.checksums.browser_download_url)) {
        result.checksums = { name: picked.checksums.name, url: picked.checksums.browser_download_url }
      }
      result.canAutoInstall = !!(result.hasUpdate && result.installer && result.checksums)
      if (this.downloadedPath && existsSync(this.downloadedPath) && result.installer?.name === this.lastInstallerName) {
        result.downloadedPath = this.downloadedPath
      }
      this.last = result
      this.lastCheckAt = Date.now()
      this.emit({
        phase: result.hasUpdate ? 'available' : 'none',
        result,
        version: latest,
        message: result.hasUpdate ? `发现新版本 ${latest}` : '已是最新版本'
      })
      return { ok: true, data: result }
    } catch (err) {
      const error = `检查更新失败：${err instanceof Error ? err.message : String(err)}`
      this.emit({ phase: 'error', message: error })
      return { ok: false, error }
    }
  }

  /** 下载并校验安装包；返回本地路径 */
  async download(): Promise<ApiResult<{ path: string }>> {
    if (this.downloading) return this.downloading
    this.downloading = this.doDownload().finally(() => {
      this.downloading = null
    })
    return this.downloading
  }

  private async doDownload(): Promise<ApiResult<{ path: string }>> {
    const result = this.last || (await this.check()).data
    if (!result) return { ok: false, error: '请先检查更新' }
    if (!result.hasUpdate) return { ok: false, error: '当前已是最新版本' }
    if (!result.installer || !result.checksums) {
      return { ok: false, error: '该版本没有提供可自动安装的安装包，请到 Release 页面手动下载' }
    }
    const installer = result.installer
    const checksums = result.checksums
    const dir = this.updatesDir()
    await fsp.mkdir(dir, { recursive: true })
    const dest = join(dir, installer.name)
    this.lastInstallerName = installer.name

    if (this.downloadedPath === dest && this.downloadedHash && existsSync(dest)) {
      return { ok: true, data: { path: dest } }
    }

    try {
      this.emit({ phase: 'downloading', progress: 0, message: `正在下载 ${installer.name}` })
      await this.fetchToFile(installer.url, dest, installer.size)
      this.emit({ phase: 'verifying', message: '正在校验安装包 SHA-256…' })
      const sums = parseChecksums(await this.fetchText(checksums.url))
      const expected = sums[installer.name]
      if (!expected) {
        await fsp.unlink(dest).catch(() => undefined)
        const error = '校验文件中没有该安装包的 SHA-256，已删除下载文件'
        this.emit({ phase: 'error', message: error })
        return { ok: false, error }
      }
      const actual = await sha256File(dest)
      if (actual !== expected) {
        await fsp.unlink(dest).catch(() => undefined)
        const error = '安装包校验失败（下载不完整或被篡改），已删除下载文件'
        this.emit({ phase: 'error', message: error })
        return { ok: false, error }
      }
      this.downloadedPath = dest
      this.downloadedHash = actual
      const next: UpdateCheckResult = { ...result, downloadedPath: dest }
      this.last = next
      this.emit({ phase: 'downloaded', progress: 100, message: `已下载并校验 ${result.latest}`, result: next })
      return { ok: true, data: { path: dest } }
    } catch (err) {
      const error = `下载更新失败：${err instanceof Error ? err.message : String(err)}`
      this.emit({ phase: 'error', message: error })
      return { ok: false, error }
    }
  }

  private async fetchToFile(url: string, dest: string, expectedSize?: number): Promise<void> {
    if (!isSafeDownloadUrl(url)) throw new Error('下载地址不合法')
    const res = await fetch(url, {
      headers: { 'User-Agent': `AIH/${this.deps.currentVersion}` },
      redirect: 'follow'
    })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    const total = Number(res.headers.get('content-length') || expectedSize || 0)
    const part = `${dest}.part`
    await fsp.mkdir(dirname(dest), { recursive: true })
    const out = createWriteStream(part)
    let writeError: Error | null = null
    out.on('error', (err) => {
      writeError = err
    })
    let received = 0
    let lastPct = -1
    let lastAt = 0
    try {
      const reader = res.body.getReader()
      for (;;) {
        if (writeError) throw writeError
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (!out.write(Buffer.from(value))) {
          await new Promise<void>((resolve, reject) => {
            out.once('drain', () => resolve())
            out.once('error', (err) => reject(err))
          })
        }
        const now = Date.now()
        if (now - lastAt > 250) {
          lastAt = now
          const pct = total ? Math.min(99, Math.round((received / total) * 100)) : 0
          if (pct !== lastPct) {
            lastPct = pct
            this.emit({
              phase: 'downloading',
              progress: pct,
              received,
              total: total || undefined,
              message: total
                ? `下载中 ${pct}%（${formatMb(received)} / ${formatMb(total)}）`
                : `已下载 ${formatMb(received)}`
            })
          }
        }
      }
      if (writeError) throw writeError
      await new Promise<void>((resolve, reject) => {
        out.end(() => resolve())
        out.once('error', (err) => reject(err))
      })
    } catch (err) {
      out.destroy()
      await fsp.unlink(part).catch(() => undefined)
      throw err
    }
    if (total && received !== total) {
      await fsp.unlink(part).catch(() => undefined)
      throw new Error(`下载不完整（${received}/${total} 字节）`)
    }
    await fsp.rename(part, dest)
  }

  private async fetchText(url: string): Promise<string> {
    if (!isSafeDownloadUrl(url)) throw new Error('校验文件地址不合法')
    const res = await fetch(url, {
      headers: { 'User-Agent': `AIH/${this.deps.currentVersion}` },
      signal: AbortSignal.timeout(20_000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  }

  /** 启动已校验的安装包并退出应用 */
  async install(): Promise<ApiResult> {
    if (!this.downloadedPath || !existsSync(this.downloadedPath)) {
      const res = await this.download()
      if (!res.ok) return { ok: false, error: res.error || '安装包尚未下载' }
    }
    const path = this.downloadedPath
    if (!path) return { ok: false, error: '安装包尚未下载' }
    try {
      this.emit({ phase: 'installing', message: '正在启动安装程序，AIH 即将退出…' })
      // NSIS 静默安装；--updated 让安装器结束后不要自动拉起应用
      const child = spawn(path, ['/S', '--updated'], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
      setTimeout(() => this.deps.quit(), 600)
      return { ok: true }
    } catch (err) {
      const error = `启动安装程序失败：${err instanceof Error ? err.message : String(err)}`
      this.emit({ phase: 'error', message: error })
      return { ok: false, error }
    }
  }
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })
}

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
