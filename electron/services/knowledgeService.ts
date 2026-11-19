import { BrowserWindow, dialog } from 'electron'
import { existsSync, readFileSync, rmSync } from 'fs'
import { promises as fsp } from 'fs'
import { randomBytes } from 'crypto'
import { basename, extname, join, resolve } from 'path'
import type { ApiResult } from '@shared/ipc'
import type { KnowledgeBase, KnowledgeDoc, KnowledgeHit, CatalogKnowledgeBase } from '@shared/types'
import { Store } from './store'
import { CATALOG, BUILTIN_PACKS } from './knowledgeCatalog'
import type { CatalogEntry } from './knowledgeCatalog'

/** 支持导入的文本类扩展名 */
const SUPPORTED_EXT = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.jsonl',
  '.csv',
  '.log',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.java',
  '.go',
  '.rs',
  '.html',
  '.htm',
  '.css',
  '.xml',
  '.yaml',
  '.yml'
])

const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_FILES = 300
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out'])
const CHUNK_TARGET = 900
const CHUNK_OVERLAP = 150

const EXPORT_README = `知识库训练数据导出
==================

本目录中的 .jsonl 文件为对话格式样本，每行一个 JSON，可直接用于 LoRA / QLoRA 等监督微调。
每行包含 messages 数组：system 为固定提示，user 为基于资料标题的问题，assistant 为资料原文。

使用建议：
1. 使用支持多轮对话格式的微调框架（如 LLaMA-Factory、Axolotl、PEFT）。
2. 根据基座模型套用对应的 chat 模板，system 字段需保留。
3. 数据来自个人知识库，使用前请确认授权与隐私合规。
4. 训练前建议按 8:1:1 划分训练集、验证集与测试集。
`

/** chunks.jsonl 中的一行 */
interface Chunk {
  docId: string
  title: string
  text: string
}

/** 切分后的片段，尚未关联文档 */
interface RawChunk {
  title: string
  text: string
}

/** 内部检索结果，包含完整块内容 */
interface RankedChunk {
  chunk: Chunk
  snippet: string
  score: number
}

/** 生成 nanoid 风格的随机短 id，不引入额外依赖 */
function randomId(size = 12): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const bytes = randomBytes(size)
  let out = ''
  for (let i = 0; i < size; i++) out += alphabet[bytes[i] % alphabet.length]
  return out
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function samePath(a: string, b: string): boolean {
  const na = resolve(a)
  const nb = resolve(b)
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb
}

/** 时间戳，用于导出文件名 */
function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 去掉 HTML 标签与实体，保留段落换行 */
function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|pre|blockquote)>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 英文/数字按词、中文按 bigram 分词，查询与文档共用 */
function tokenize(text: string): string[] {
  const out: string[] = []
  const lower = text.toLowerCase()
  const re = /[a-z0-9]+|[\u4e00-\u9fff]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(lower)) !== null) {
    const part = m[0]
    if (part.charCodeAt(0) <= 0x7f) {
      out.push(part)
      continue
    }
    const chars = Array.from(part)
    if (chars.length === 1) out.push(chars[0])
    else for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1])
  }
  return out
}

/** 取块尾的重叠部分，尽量从完整句子后开始 */
function tailOverlap(text: string): string {
  if (text.length <= CHUNK_OVERLAP) return text.trim()
  let tail = text.slice(text.length - CHUNK_OVERLAP)
  const idx = tail.indexOf('\n')
  if (idx >= 0 && idx < 60) tail = tail.slice(idx + 1)
  return tail.trim()
}

/** 按段落聚合切块，保留 markdown 标题行 */
function splitText(text: string, fallbackTitle: string): RawChunk[] {
  const clean = text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').trim()
  if (!clean) return []

  // 先把超长段落拆成不超过目标长度的单元
  const units: string[] = []
  for (const para of clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
    if (para.length <= CHUNK_TARGET) {
      units.push(para)
      continue
    }
    let buf = ''
    for (const line of para.split('\n')) {
      if (line.length > CHUNK_TARGET) {
        if (buf) {
          units.push(buf)
          buf = ''
        }
        for (let i = 0; i < line.length; i += CHUNK_TARGET) units.push(line.slice(i, i + CHUNK_TARGET))
        continue
      }
      if (buf && buf.length + line.length + 1 > CHUNK_TARGET) {
        units.push(buf)
        buf = line
      } else {
        buf = buf ? `${buf}\n${line}` : line
      }
    }
    if (buf) units.push(buf)
  }

  const chunks: RawChunk[] = []
  let cur = ''
  let title = fallbackTitle
  for (let i = 0; i < units.length; i++) {
    const unit = units[i]
    const heading = /^#{1,6}\s+(.+)$/.exec(unit.split('\n')[0])
    if (heading) title = heading[1].trim()
    cur = cur ? `${cur}\n\n${unit}` : unit
    const last = i === units.length - 1
    if (cur.length >= CHUNK_TARGET && !last) {
      chunks.push({ title, text: cur.trim() })
      cur = tailOverlap(cur)
    }
  }
  if (cur.trim()) {
    const lastChunk = chunks[chunks.length - 1]
    // 极短的尾块并入上一块，避免碎片
    if (lastChunk && cur.trim().length < 120) lastChunk.text += `\n\n${cur.trim()}`
    else chunks.push({ title, text: cur.trim() })
  }
  return chunks
}

/** 命中片段，纯文本，长度约 240 字符 */
function makeSnippet(text: string, tokens: string[], maxLen = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  const lower = flat.toLowerCase()
  let pos = -1
  for (const t of tokens) {
    const i = lower.indexOf(t)
    if (i >= 0 && (pos < 0 || i < pos)) pos = i
  }
  if (pos < 0) pos = 0
  let start = Math.max(0, pos - 60)
  let end = Math.min(flat.length, start + maxLen)
  if (end - start < maxLen) start = Math.max(0, end - maxLen)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < flat.length ? '…' : ''
  return `${prefix}${flat.slice(start, end).trim()}${suffix}`
}

/**
 * 知识库服务：导入、切块、BM25 检索、上下文注入、目录安装与训练集导出。
 * 所有公开方法都要保证不向主进程抛异常。
 */
export class KnowledgeService {
  private store: Store
  private cache = new Map<string, Chunk[]>()

  constructor(store: Store) {
    this.store = store
  }

  list(): KnowledgeBase[] {
    return this.store.knowledge
  }

  create(name: string, description: string): KnowledgeBase {
    const kb: KnowledgeBase = {
      id: randomId(),
      name: name.trim() || '未命名知识库',
      description: description.trim(),
      docs: [],
      updatedAt: Date.now(),
      sizeBytes: 0
    }
    this.upsert(kb)
    return kb
  }

  /** paths 为空时弹出文件/文件夹选择框；支持多选与文件夹递归 */
  async import(id: string, paths?: string[]): Promise<ApiResult<KnowledgeBase>> {
    try {
      const kb = this.find(id)
      if (!kb) return { ok: false, error: '知识库不存在' }

      let targets = (paths ?? []).map((p) => resolve(p))
      if (!targets.length) targets = await this.pickPaths()
      if (!targets.length) return { ok: false, error: '未选择文件或文件夹' }

      const files = await this.collectFiles(targets)
      if (!files.length) {
        return { ok: false, error: '未找到可导入的文本文件（单文件不超过 8MB，最多 300 个）' }
      }

      const existing = this.loadChunks(kb.id)
      const replacedDocIds = new Set<string>()
      const nextDocs: KnowledgeDoc[] = []
      const nextChunks: Chunk[] = []

      for (const file of files) {
        const content = await this.readTextFile(file)
        if (!content) continue
        const pieces = splitText(content.text, basename(file, extname(file)))
        if (!pieces.length) continue

        const docId = randomId()
        const title = basename(file, extname(file))
        const old = kb.docs.find((d) => samePath(d.source, file))
        if (old) replacedDocIds.add(old.id)

        nextDocs.push({
          id: docId,
          title,
          source: file,
          sizeBytes: content.sizeBytes,
          chunks: pieces.length,
          addedAt: Date.now(),
          tags: []
        })
        for (const piece of pieces) nextChunks.push({ docId, title: piece.title, text: piece.text })
      }

      if (!nextDocs.length) return { ok: false, error: '没有可导入的文本内容' }

      const chunks = [...existing.filter((c) => !replacedDocIds.has(c.docId)), ...nextChunks]
      await this.writeChunks(kb.id, chunks)

      const docs = [...kb.docs.filter((d) => !replacedDocIds.has(d.id)), ...nextDocs]
      kb.docs = docs
      kb.sizeBytes = docs.reduce((sum, d) => sum + d.sizeBytes, 0)
      kb.updatedAt = Date.now()
      this.upsert(kb)
      return { ok: true, data: kb }
    } catch (err) {
      return { ok: false, error: `导入失败：${errMsg(err)}` }
    }
  }

  delete(id: string): void {
    try {
      this.store.setKnowledge(this.store.knowledge.filter((k) => k.id !== id))
      this.cache.delete(id)
      const dir = join(this.store.dir, 'knowledge', id)
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      console.error('[knowledge] 删除知识库失败', err)
    }
  }

  search(id: string, query: string, topK = 6): KnowledgeHit[] {
    if (!query.trim() || topK <= 0) return []
    return this.rank(id, query, topK).map((r) => ({
      docId: r.chunk.docId,
      title: r.chunk.title,
      snippet: r.snippet,
      score: r.score
    }))
  }

  /** 供 Harness 注入上下文，返回带来源标注的文本 */
  buildContext(ids: string[], query: string, budgetChars = 6000): string {
    if (!ids.length || !query.trim() || budgetChars <= 0) return ''
    const seen = new Set<string>()
    let out = ''
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      const kb = this.find(id)
      if (!kb) continue
      const ranked = this.rank(id, query, 6)
      if (!ranked.length) continue

      const header = `【知识库：${kb.name}】`
      const sep = out ? '\n\n' : ''
      if (out.length + sep.length + header.length > budgetChars) break
      out += sep + header

      for (const item of ranked) {
        const remain = budgetChars - out.length
        if (remain <= 40) break
        const block = `\n[来源: ${item.chunk.title}]\n${item.chunk.text}`
        if (block.length <= remain) {
          out += block
          continue
        }
        const keep = remain - 1
        if (keep > 0) out += `${block.slice(0, keep)}…`
        break
      }
    }
    return out.trim()
  }

  /** 在线返回在线目录；离线时仍返回目录（含链接） */
  async catalog(): Promise<{ bases: CatalogKnowledgeBase[]; online: boolean }> {
    let online = false
    try {
      online = await this.isOnline()
    } catch {
      online = false
    }
    return { bases: CATALOG.map((b) => ({ ...b, docs: [] })), online }
  }

  async installCatalog(id: string): Promise<ApiResult<KnowledgeBase>> {
    const entry = CATALOG.find((c) => c.id === id)
    if (!entry) return { ok: false, error: '目录中不存在该知识包' }

    // 内置包：直接使用代码中的内容
    if (!entry.installUrl) {
      const content = BUILTIN_PACKS[id]
      if (!content) return { ok: false, error: '内置知识包内容缺失' }
      try {
        return await this.installText(entry, content, `内置知识包：${entry.name}`)
      } catch (err) {
        return { ok: false, error: `安装失败：${errMsg(err)}` }
      }
    }

    // HuggingFace 数据集不在应用内下载，仅提示打开链接
    if (entry.format === 'hf-dataset') {
      return { ok: false, error: `该数据集需在网页中下载：${entry.installUrl}` }
    }

    const text = await this.download(entry.installUrl)
    if (text === null) return { ok: false, error: '下载失败，请检查网络或使用镜像链接' }
    try {
      return await this.installText(entry, text, entry.installUrl)
    } catch (err) {
      return { ok: false, error: `安装失败：${errMsg(err)}` }
    }
  }

  /** 导出微调数据集 JSONL，返回文件路径与样本数 */
  async exportTraining(id: string): Promise<ApiResult<{ path: string; samples: number }>> {
    try {
      const kb = this.find(id)
      if (!kb) return { ok: false, error: '知识库不存在' }
      const chunks = this.loadChunks(id)
      if (!chunks.length) return { ok: false, error: '知识库暂无内容，请先导入资料' }

      const dir = join(this.store.dir, 'knowledge-exports')
      await fsp.mkdir(dir, { recursive: true })
      const file = join(dir, `${id}-${stamp()}.jsonl`)
      const lines = chunks.map((c) =>
        JSON.stringify({
          messages: [
            { role: 'system', content: '你是知识库助手，回答需基于资料。' },
            { role: 'user', content: `请解释资料中的要点：${c.title}` },
            { role: 'assistant', content: c.text }
          ]
        })
      )
      await fsp.writeFile(file, `${lines.join('\n')}\n`, 'utf8')
      await fsp.writeFile(join(dir, 'README.txt'), EXPORT_README, 'utf8')
      return { ok: true, data: { path: file, samples: lines.length } }
    } catch (err) {
      return { ok: false, error: `导出失败：${errMsg(err)}` }
    }
  }

  private find(id: string): KnowledgeBase | undefined {
    return this.store.knowledge.find((k) => k.id === id)
  }

  private upsert(kb: KnowledgeBase): void {
    const list = this.store.knowledge
    const i = list.findIndex((k) => k.id === kb.id)
    if (i >= 0) list[i] = kb
    else list.unshift(kb)
    this.store.setKnowledge(list)
  }

  /** 弹出「文件 / 文件夹」选择框 */
  private async pickPaths(): Promise<string[]> {
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const message = {
      type: 'question' as const,
      title: '导入知识库',
      message: '选择导入来源',
      detail: '可以选择多个文件，或选择整个文件夹递归导入。',
      buttons: ['选择文件', '选择文件夹', '取消'],
      defaultId: 0,
      cancelId: 2
    }
    const choice = win ? await dialog.showMessageBox(win, message) : await dialog.showMessageBox(message)
    if (choice.response === 2) return []

    const properties: Electron.OpenDialogOptions['properties'] =
      choice.response === 0 ? ['openFile', 'multiSelections'] : ['openDirectory', 'multiSelections']
    const options: Electron.OpenDialogOptions = {
      title: choice.response === 0 ? '选择知识库文件' : '选择知识库文件夹',
      properties
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  }

  /** 递归收集可导入文件，过滤目录、扩展名、大小与重复路径 */
  private async collectFiles(paths: string[]): Promise<string[]> {
    const found: string[] = []
    const seen = new Set<string>()

    const walk = async (p: string): Promise<void> => {
      if (found.length >= MAX_FILES) return
      let st
      try {
        st = await fsp.stat(p)
      } catch {
        return
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(basename(p))) return
        let entries: string[]
        try {
          entries = await fsp.readdir(p)
        } catch {
          return
        }
        for (const entry of entries) {
          if (found.length >= MAX_FILES) break
          await walk(join(p, entry))
        }
        return
      }
      if (!st.isFile() || st.size === 0 || st.size > MAX_FILE_BYTES) return
      if (!SUPPORTED_EXT.has(extname(p).toLowerCase())) return
      const key = process.platform === 'win32' ? p.toLowerCase() : p
      if (seen.has(key)) return
      seen.add(key)
      found.push(p)
    }

    for (const p of paths) {
      if (found.length >= MAX_FILES) break
      await walk(p)
    }
    return found
  }

  /** 读取文本文件；二进制（含 NUL 字节）或读取失败返回 null */
  private async readTextFile(file: string): Promise<{ text: string; sizeBytes: number } | null> {
    try {
      const buf = await fsp.readFile(file)
      if (!buf.length || buf.length > MAX_FILE_BYTES) return null
      if (buf.includes(0)) return null
      const ext = extname(file).toLowerCase()
      let text = buf.toString('utf8').replace(/^\uFEFF/, '')
      if (ext === '.html' || ext === '.htm') text = stripHtml(text)
      text = text.replace(/\r\n?/g, '\n').trim()
      if (!text) return null
      return { text, sizeBytes: buf.length }
    } catch {
      return null
    }
  }

  private async writeChunks(kbId: string, chunks: Chunk[]): Promise<void> {
    const dir = this.store.kbDir(kbId)
    const file = join(dir, 'chunks.jsonl')
    const body = chunks.length ? `${chunks.map((c) => JSON.stringify(c)).join('\n')}\n` : ''
    const tmp = `${file}.tmp`
    await fsp.writeFile(tmp, body, 'utf8')
    await fsp.rename(tmp, file)
    this.cache.set(kbId, chunks)
  }

  private loadChunks(kbId: string): Chunk[] {
    const cached = this.cache.get(kbId)
    if (cached) return cached
    const chunks: Chunk[] = []
    try {
      const file = join(this.store.kbDir(kbId), 'chunks.jsonl')
      if (existsSync(file)) {
        const raw = readFileSync(file, 'utf8')
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue
          try {
            const value = JSON.parse(line) as Partial<Chunk>
            if (
              typeof value.docId === 'string' &&
              typeof value.title === 'string' &&
              typeof value.text === 'string'
            ) {
              chunks.push({ docId: value.docId, title: value.title, text: value.text })
            }
          } catch {
            // 跳过损坏行
          }
        }
      }
    } catch (err) {
      console.error('[knowledge] 读取分块失败', err)
    }
    this.cache.set(kbId, chunks)
    return chunks
  }

  /** BM25 检索，分数归一化到 0-1 */
  private rank(id: string, query: string, limit = 6): RankedChunk[] {
    const queryTokens = [...new Set(tokenize(query))]
    if (!queryTokens.length) return []
    const chunks = this.loadChunks(id)
    if (!chunks.length) return []

    const docs = chunks.map((chunk) => {
      const tokens = tokenize(`${chunk.title}\n${chunk.text}`)
      const tf = new Map<string, number>()
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
      return { chunk, tf, len: tokens.length }
    })

    const n = docs.length
    const avgdl = docs.reduce((sum, d) => sum + d.len, 0) / n || 1
    const df = new Map<string, number>()
    for (const token of queryTokens) {
      let count = 0
      for (const doc of docs) if (doc.tf.has(token)) count++
      df.set(token, count)
    }

    const k1 = 1.5
    const b = 0.75
    const scored = docs
      .map((doc) => {
        let score = 0
        for (const token of queryTokens) {
          const tf = doc.tf.get(token) ?? 0
          if (!tf) continue
          const dfi = df.get(token) ?? 0
          const idf = Math.log(1 + (n - dfi + 0.5) / (dfi + 0.5))
          score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.len) / avgdl))
        }
        return { chunk: doc.chunk, score }
      })
      .filter((item) => item.score > 0)

    if (!scored.length) return []
    scored.sort((a, b2) => b2.score - a.score)
    const max = scored[0].score || 1
    return scored.slice(0, Math.max(1, Math.min(limit, 50))).map((item) => ({
      chunk: item.chunk,
      snippet: makeSnippet(item.chunk.text, queryTokens),
      score: Math.round(Math.min(1, item.score / max) * 10000) / 10000
    }))
  }

  /** 在线检测：HEAD 百度，4 秒超时 */
  private async isOnline(): Promise<boolean> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 4000)
    try {
      const res = await fetch('https://www.baidu.com', {
        method: 'HEAD',
        signal: ctrl.signal,
        headers: { 'User-Agent': 'AIH/0.1' }
      })
      return res.status < 500
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  /** 下载目录内容，20 秒超时；失败返回 null */
  private async download(url: string): Promise<string | null> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 20000)
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'AIH/0.1' } })
      if (!res.ok) return null
      const type = (res.headers.get('content-type') ?? '').toLowerCase()
      let text = await res.text()
      if (type.includes('html') || /\.html?($|\?)/i.test(url)) text = stripHtml(text)
      text = text.replace(/\r\n?/g, '\n').trim()
      return text || null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /** 将目录/内置内容切块入库，目录包重装时整体替换 */
  private async installText(
    entry: CatalogEntry,
    text: string,
    source: string
  ): Promise<ApiResult<KnowledgeBase>> {
    const pieces = splitText(text, entry.name)
    if (!pieces.length) return { ok: false, error: '知识包内容为空' }

    const kb: KnowledgeBase =
      this.find(entry.id) ??
      ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        docs: [],
        updatedAt: Date.now(),
        recommendedFor: entry.recommendedFor,
        sizeBytes: 0
      } satisfies KnowledgeBase)

    const docId = randomId()
    const chunks: Chunk[] = pieces.map((p) => ({ docId, title: p.title, text: p.text }))
    await this.writeChunks(kb.id, chunks)

    const doc: KnowledgeDoc = {
      id: docId,
      title: entry.name,
      source,
      sizeBytes: Buffer.byteLength(text, 'utf8'),
      chunks: pieces.length,
      addedAt: Date.now(),
      tags: entry.tags
    }
    kb.name = entry.name
    kb.description = entry.description
    kb.recommendedFor = entry.recommendedFor
    kb.docs = [doc]
    kb.sizeBytes = doc.sizeBytes
    kb.updatedAt = Date.now()
    this.upsert(kb)
    return { ok: true, data: kb }
  }
}
