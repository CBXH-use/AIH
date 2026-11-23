import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, promises as fsp, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join, normalize, relative, sep } from 'node:path'
import type { ChatMessage, Session } from '@shared/types'

/** 自定义协议：渲染层用 <img src="aih-attachment://local/<file>"> 显示落盘后的图片 */
export const ATTACHMENT_SCHEME = 'aih-attachment'
export const ATTACHMENT_HOST = 'local'
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const CACHE_MAX_ENTRIES = 24

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg'
}
const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml'
}

export interface SavedAttachment {
  /** 相对 attachments 根目录的路径（写入会话数据，迁移数据目录也不会失效） */
  file: string
  name?: string
  mime: string
  sizeBytes: number
}

interface DataUrlParts {
  mime: string
  buffer: Buffer
}

function parseDataUrl(dataUrl: string): DataUrlParts | null {
  const match = /^data:([a-z0-9.+/-]+);base64,([\s\S]+)$/i.exec(String(dataUrl || '').trim())
  if (!match) return null
  try {
    return { mime: match[1].toLowerCase(), buffer: Buffer.from(match[2], 'base64') }
  } catch {
    return null
  }
}

/**
 * 图片附件落盘：会话数据只保存相对路径，避免每次 flush 把几十 MB 的 base64 写进 aih-data.json。
 * 文件按内容哈希命名，天然去重；渲染层通过自定义协议读取。
 */
export class AttachmentService {
  private cache = new Map<string, string>()
  private cacheBytes = 0

  constructor(readonly root: string) {
    try {
      mkdirSync(root, { recursive: true })
    } catch {
      /* 目录创建失败时保存会返回错误，由调用方处理 */
    }
  }

  /** 保存一张 data URL 图片，返回相对路径；内容相同则复用同一个文件 */
  async save(dataUrl: string, name?: string): Promise<SavedAttachment> {
    const parsed = parseDataUrl(dataUrl)
    if (!parsed) throw new Error('图片数据格式不支持')
    if (parsed.buffer.byteLength > MAX_ATTACHMENT_BYTES) throw new Error('图片过大（最大 25MB）')
    const mime = MIME_EXT[parsed.mime] ? parsed.mime : 'image/png'
    const ext = MIME_EXT[mime] || 'png'
    const hash = createHash('sha1').update(parsed.buffer).digest('hex')
    const month = new Date().toISOString().slice(0, 7)
    const rel = `${month}/${hash}.${ext}`
    const abs = join(this.root, month, `${hash}.${ext}`)
    await fsp.mkdir(join(this.root, month), { recursive: true })
    if (!existsSync(abs)) await fsp.writeFile(abs, parsed.buffer)
    this.cache.set(rel, dataUrl)
    this.cacheBytes += dataUrl.length
    this.trimCache()
    return { file: rel, name, mime, sizeBytes: parsed.buffer.byteLength }
  }

  /** 相对路径 → 绝对路径；只允许 attachments 目录内的文件 */
  resolve(file: string): string | null {
    const clean = String(file || '').replace(/^[/\\]+/, '')
    if (!clean || clean.includes('\u0000')) return null
    const abs = normalize(join(this.root, clean))
    const rel = relative(this.root, abs)
    if (!rel || rel.startsWith('..') || /^[a-zA-Z]:/.test(rel)) return null
    return existsSync(abs) ? abs : null
  }

  /** 把落盘图片读回 data URL（带内存缓存，供模型请求使用；读不到返回 null） */
  dataUrlOf(file: string): string | null {
    const cached = this.cache.get(file)
    if (cached) return cached
    const abs = this.resolve(file)
    if (!abs) return null
    try {
      const buffer = readFileSync(abs)
      const mime = EXT_MIME[extname(abs).slice(1).toLowerCase()] || 'image/png'
      const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`
      this.cache.set(file, dataUrl)
      this.cacheBytes += dataUrl.length
      this.trimCache()
      return dataUrl
    } catch {
      return null
    }
  }

  /** 渲染层使用的 URL */
  urlOf(file: string): string {
    return `${ATTACHMENT_SCHEME}://${ATTACHMENT_HOST}/${String(file).split(sep).join('/')}`
  }

  /** 绝对路径 → 相对路径（迁移旧数据时用） */
  relOf(abs: string): string | null {
    const rel = relative(this.root, normalize(abs))
    return rel && !rel.startsWith('..') ? rel.split(sep).join('/') : null
  }

  /**
   * 把历史会话里内联的 dataUrl 图片迁移到磁盘。
   * 返回迁移数量；调用方负责 flush 数据文件。
   */
  async migrateInlineImages(sessions: Session[]): Promise<number> {
    let moved = 0
    for (const session of sessions) {
      for (const message of session.messages || []) {
        for (const part of message.parts || []) {
          if (part.type !== 'image') continue
          const inline = part.dataUrl
          if (!inline || !inline.startsWith('data:')) continue
          try {
            const saved = await this.save(inline, part.name)
            part.file = saved.file
            part.mime = saved.mime
            part.sizeBytes = saved.sizeBytes
            delete part.dataUrl
            moved++
          } catch {
            /* 单张失败不影响其他图片 */
          }
        }
      }
    }
    return moved
  }

  /** 会话里所有图片改为落盘表示（新消息写入时用） */
  async attachToMessage(message: ChatMessage, dataUrls: { dataUrl: string; name?: string }[]): Promise<void> {
    for (const img of dataUrls) {
      try {
        const saved = await this.save(img.dataUrl, img.name)
        message.parts.push({
          type: 'image',
          file: saved.file,
          name: img.name,
          mime: saved.mime,
          sizeBytes: saved.sizeBytes
        })
      } catch {
        // 保存失败时退回内存 dataUrl，保证这一轮还能看图
        message.parts.push({ type: 'image', dataUrl: img.dataUrl, name: img.name })
      }
    }
  }

  stats(): { count: number; sizeBytes: number } {
    let count = 0
    let sizeBytes = 0
    const walk = (dir: string) => {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else {
          count++
          try {
            sizeBytes += statSync(full).size
          } catch {
            /* ignore */
          }
        }
      }
    }
    walk(this.root)
    return { count, sizeBytes }
  }

  private trimCache() {
    while (this.cache.size > CACHE_MAX_ENTRIES && this.cacheBytes > 48 * 1024 * 1024) {
      const first = this.cache.keys().next()
      if (first.done) break
      const value = this.cache.get(first.value)
      this.cache.delete(first.value)
      this.cacheBytes -= value?.length || 0
    }
  }
}

/** 从消息的 image part 里取出可供模型使用的 dataUrl（兼容旧的内联数据） */
export function imagePartDataUrl(
  part: { dataUrl?: string; file?: string },
  attachments: AttachmentService | null
): string | null {
  if (part.dataUrl) return part.dataUrl
  if (part.file && attachments) return attachments.dataUrlOf(part.file)
  return null
}

export function attachmentFileName(file: string): string {
  return basename(file)
}

/** 由扩展名推断 MIME（自定义协议响应头用） */
export function mimeOf(file: string): string {
  return EXT_MIME[extname(String(file || '')).slice(1).toLowerCase()] || 'application/octet-stream'
}
