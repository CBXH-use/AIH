import { createWriteStream } from 'fs'
import { promises as fsp } from 'fs'
import { dirname } from 'path'
import { Readable } from 'stream'

export interface DownloadProgress {
  /** 0-1，无法获知总大小时为 0 */
  ratio: number
  received: number
  total: number
}

/**
 * 依次尝试多个地址下载到目标文件（支持重定向），任一个成功即返回。
 * 用于 GitHub 直连失败时自动切换到国内镜像。
 */
export async function downloadToFile(
  urls: string[],
  dest: string,
  signal: AbortSignal,
  onProgress?: (p: DownloadProgress) => void
): Promise<void> {
  let lastError: unknown = null
  await fsp.mkdir(dirname(dest), { recursive: true })

  for (const url of urls) {
    const tmp = `${dest}.part`
    const attempt = new AbortController()
    let idleTimedOut = false
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    const touch = (ms = 45000) => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        idleTimedOut = true
        attempt.abort()
      }, ms)
    }
    const onExternalAbort = () => attempt.abort()
    signal.addEventListener('abort', onExternalAbort, { once: true })
    const requestSignal = AbortSignal.any ? AbortSignal.any([signal, attempt.signal]) : attempt.signal

    try {
      touch()
      const res = await fetch(url, { signal: requestSignal, redirect: 'follow' })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length')) || 0
      const out = createWriteStream(tmp)
      // 磁盘满/权限不足时写流会 emit('error')；不监听会变成未捕获异常，且 drain 永远不会触发导致永久卡住
      let streamError: Error | null = null
      out.on('error', (err) => {
        streamError = err
      })
      let received = 0
      let lastReport = 0
      const nodeStream = Readable.fromWeb(res.body as never)

      const writeChunk = async (chunk: Buffer) => {
        if (streamError) throw streamError
        if (out.write(chunk)) return
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            out.off('drain', onDrain)
            out.off('error', onError)
            attempt.signal.removeEventListener('abort', onAbort)
          }
          const onDrain = () => {
            cleanup()
            resolve()
          }
          const onError = (err: Error) => {
            cleanup()
            reject(err)
          }
          const onAbort = () => {
            cleanup()
            reject(new Error('已取消'))
          }
          out.once('drain', onDrain)
          out.once('error', onError)
          attempt.signal.addEventListener('abort', onAbort, { once: true })
        })
        if (streamError) throw streamError
      }

      try {
        for await (const chunk of nodeStream as AsyncIterable<Buffer>) {
          if (signal.aborted) throw new Error('已取消')
          touch()
          await writeChunk(chunk)
          received += chunk.length
          const now = Date.now()
          if (now - lastReport > 120) {
            lastReport = now
            onProgress?.({ ratio: total ? Math.min(1, received / total) : 0, received, total })
          }
        }
        if (streamError) throw streamError
        await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
        if (streamError) throw streamError
        if (total && received !== total) throw new Error(`下载不完整（${received}/${total} 字节）`)
      } catch (err) {
        out.destroy()
        throw err
      } finally {
        if (idleTimer) clearTimeout(idleTimer)
      }

      await fsp.rename(tmp, dest)
      onProgress?.({ ratio: 1, received, total: total || received })
      signal.removeEventListener('abort', onExternalAbort)
      return
    } catch (err) {
      signal.removeEventListener('abort', onExternalAbort)
      await fsp.unlink(tmp).catch(() => undefined)
      if (signal.aborted) throw new Error('已取消')
      lastError = idleTimedOut ? new Error('下载超时，正在切换下载源…') : err
    }
  }

  throw lastError instanceof Error ? lastError : new Error('下载失败')
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return ''
  const mb = bytesPerSecond / 1024 / 1024
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`
  return `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`
}
