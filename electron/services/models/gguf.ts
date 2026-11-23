import { closeSync, openSync, readSync, statSync } from 'node:fs'
import type { GgufMeta } from '@shared/gguf'

/**
 * GGUF 头解析：读出上下文长度、层数、KV 头数、量化、参数量与 chat template 能力。
 * 只读取文件头部（元数据 + 张量信息），不会把整个模型读进内存。
 * 结果按 path+mtime+size 缓存，扫描/启动时重复调用没有额外 IO。
 */
const GGUF_MAGIC = 0x46554747 // 'GGUF'
const MAX_METADATA_BYTES = 48 * 1024 * 1024
const MAX_TENSORS = 100_000
const MAX_ARRAY_ITEMS = 5_000_000
const PARSE_TIME_BUDGET_MS = 600

const VALUE_UINT8 = 0
const VALUE_INT8 = 1
const VALUE_UINT16 = 2
const VALUE_INT16 = 3
const VALUE_UINT32 = 4
const VALUE_INT32 = 5
const VALUE_FLOAT32 = 6
const VALUE_BOOL = 7
const VALUE_STRING = 8
const VALUE_ARRAY = 9
const VALUE_UINT64 = 10
const VALUE_INT64 = 11
const VALUE_FLOAT64 = 12

const FIXED_SIZE: Record<number, number> = {
  [VALUE_UINT8]: 1,
  [VALUE_INT8]: 1,
  [VALUE_UINT16]: 2,
  [VALUE_INT16]: 2,
  [VALUE_UINT32]: 4,
  [VALUE_INT32]: 4,
  [VALUE_FLOAT32]: 4,
  [VALUE_BOOL]: 1,
  [VALUE_UINT64]: 8,
  [VALUE_INT64]: 8,
  [VALUE_FLOAT64]: 8
}

/** general.file_type → 量化名称（llama.cpp 枚举） */
const FILE_TYPE_QUANT: Record<number, string> = {
  0: 'F32',
  1: 'F16',
  2: 'Q4_0',
  3: 'Q4_1',
  7: 'Q8_0',
  8: 'Q5_0',
  9: 'Q5_1',
  10: 'Q2_K',
  11: 'Q3_K_S',
  12: 'Q3_K_M',
  13: 'Q3_K_L',
  14: 'Q4_K_S',
  15: 'Q4_K_M',
  16: 'Q5_K_S',
  17: 'Q5_K_M',
  18: 'Q6_K',
  19: 'IQ2_XXS',
  20: 'IQ2_XS',
  21: 'Q2_K_S',
  22: 'IQ3_XS',
  23: 'IQ3_XXS',
  24: 'IQ1_S',
  25: 'IQ4_NL',
  26: 'IQ3_S',
  27: 'IQ3_M',
  28: 'IQ2_S',
  29: 'IQ2_M',
  30: 'IQ4_XS',
  31: 'IQ1_M',
  32: 'BF16',
  33: 'Q4_0_4_4',
  34: 'Q4_0_4_8',
  35: 'Q4_0_8_8',
  36: 'TQ1_0',
  37: 'TQ2_0',
  38: 'IQ4_NL_4_4',
  39: 'IQ4_NL_4_8',
  40: 'IQ4_NL_8_8'
}

class Cursor {
  private buf: Buffer = Buffer.alloc(0)
  private view: DataView<ArrayBufferLike> = new DataView(new ArrayBuffer(0))
  private pos = 0
  private readonly budget: number

  constructor(
    private readonly fd: number,
    readonly size: number
  ) {
    this.budget = Math.min(size, MAX_METADATA_BYTES)
  }

  get offset(): number {
    return this.pos
  }

  private need(n: number) {
    if (this.pos + n <= this.buf.length) return
    if (this.pos + n > this.budget) throw new Error('gguf metadata exceeds budget')
    const target = Math.min(this.budget, Math.max(this.pos + n, this.buf.length * 2, 64 * 1024))
    const next = Buffer.alloc(target)
    this.buf.copy(next, 0)
    let read = this.buf.length
    while (read < target) {
      const got = readSync(this.fd, next, read, target - read, read)
      if (got <= 0) break
      read += got
    }
    if (read < this.pos + n) throw new Error('unexpected end of file')
    this.buf = next.subarray(0, read)
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength)
  }

  u8(): number {
    this.need(1)
    return this.buf[this.pos++]
  }

  u16(): number {
    this.need(2)
    const v = this.view.getUint16(this.pos, true)
    this.pos += 2
    return v
  }

  u32(): number {
    this.need(4)
    const v = this.view.getUint32(this.pos, true)
    this.pos += 4
    return v
  }

  i32(): number {
    this.need(4)
    const v = this.view.getInt32(this.pos, true)
    this.pos += 4
    return v
  }

  u64(): number {
    this.need(8)
    const v = this.view.getBigUint64(this.pos, true)
    this.pos += 8
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('gguf value too large')
    return Number(v)
  }

  f32(): number {
    this.need(4)
    const v = this.view.getFloat32(this.pos, true)
    this.pos += 4
    return v
  }

  bytes(n: number): Buffer {
    if (n < 0) throw new Error('negative length')
    this.need(n)
    const out = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  /** 直接跳过 n 字节（不读入内存） */
  skip(n: number) {
    if (n < 0) throw new Error('negative skip')
    this.pos += n
    if (this.pos > this.size) throw new Error('unexpected end of file')
  }

  /** GGUF 字符串：uint64 长度 + UTF-8 字节 */
  str(): string {
    const len = this.u64()
    if (len > this.budget || len > this.size - this.pos) throw new Error('invalid string length')
    if (len > 1024 * 1024) {
      // 超长字符串（一般是分词表）不保留内容，直接跳过
      this.skip(len)
      return ''
    }
    return this.bytes(len).toString('utf8')
  }
}

interface PartialMeta {
  architecture?: string
  name?: string
  contextLength?: number
  embeddingLength?: number
  blockCount?: number
  headCount?: number
  headCountKv?: number
  fileType?: number
  chatTemplate?: string
  visionHint: boolean
}

function readScalar(cursor: Cursor, type: number): number | string | boolean | null {
  switch (type) {
    case VALUE_UINT8:
      return cursor.u8()
    case VALUE_INT8:
      return cursor.u8()
    case VALUE_UINT16:
      return cursor.u16()
    case VALUE_INT16:
      return cursor.u16()
    case VALUE_UINT32:
      return cursor.u32()
    case VALUE_INT32:
      return cursor.i32()
    case VALUE_FLOAT32:
      return cursor.f32()
    case VALUE_BOOL:
      return cursor.u8() !== 0
    case VALUE_UINT64:
      return cursor.u64()
    case VALUE_INT64:
      return cursor.u64()
    case VALUE_FLOAT64: {
      const lo = cursor.u32()
      const hi = cursor.u32()
      const view = new DataView(new ArrayBuffer(8))
      view.setUint32(0, lo, true)
      view.setUint32(4, hi, true)
      return view.getFloat64(0, true)
    }
    case VALUE_STRING:
      return cursor.str()
    default:
      return null
  }
}

function skipValue(cursor: Cursor, type: number): void {
  const fixed = FIXED_SIZE[type]
  if (fixed) {
    cursor.skip(fixed)
    return
  }
  if (type === VALUE_STRING) {
    const len = cursor.u64()
    cursor.skip(len)
    return
  }
  if (type === VALUE_ARRAY) {
    const itemType = cursor.u32()
    const len = cursor.u64()
    if (len > MAX_ARRAY_ITEMS) throw new Error('gguf array too large')
    const fixedItem = FIXED_SIZE[itemType]
    if (fixedItem) {
      cursor.skip(len * fixedItem)
      return
    }
    for (let i = 0; i < len; i++) skipValue(cursor, itemType)
    return
  }
  throw new Error(`unsupported gguf value type ${type}`)
}

function looksLikeToolsTemplate(template: string): boolean {
  return /tools\b|tool_call|tool_calls|tool_results|tojson|function/i.test(template)
}

function looksLikeThinkingTemplate(template: string): boolean {
  return /think|reasoning|enable_thinking/i.test(template)
}

function inferVision(arch: string | undefined, name: string | undefined, visionHint: boolean): boolean | undefined {
  if (visionHint) return true
  const text = `${arch || ''} ${name || ''}`.toLowerCase()
  if (/clip|llava|vision|vl|minicpmv|gemma3|pixtral|qwen2vl|qwen2\.5vl|internvl|moondream/.test(text)) return true
  return undefined
}

function inferThinking(arch: string | undefined, name: string | undefined, template: string): boolean | undefined {
  const text = `${arch || ''} ${name || ''}`.toLowerCase()
  if (/qwen3|qwq|deepseek-r1|deepseek2|reasoner|marco-o1|glm-z1|magistral/.test(text)) return true
  if (template && looksLikeThinkingTemplate(template)) return true
  return undefined
}

const metaCache = new Map<string, GgufMeta>()
const META_CACHE_LIMIT = 256

function cacheKey(path: string, size: number, mtimeMs: number): string {
  return `${path.toLowerCase()}::${size}::${Math.round(mtimeMs)}`
}

/** 解析 GGUF 头部；不是 GGUF 或读取失败时返回 null。同步实现，结果带缓存。 */
export function readGgufMeta(filePath: string): GgufMeta | null {
  try {
    const stat = statSync(filePath)
    return readGgufMetaWithStat(filePath, stat.size, stat.mtimeMs, () => openSync(filePath, 'r'))
  } catch {
    return null
  }
}

function readGgufMetaWithStat(
  filePath: string,
  size: number,
  mtimeMs: number,
  open: () => number
): GgufMeta | null {
  const key = cacheKey(filePath, size, mtimeMs)
  const cached = metaCache.get(key)
  if (cached) return cached
  if (size < 24) return null

  const started = Date.now()
  const fd = open()
  let meta: GgufMeta | null = null
  try {
    const cursor = new Cursor(fd, size)
    const magic = cursor.u32()
    if (magic !== GGUF_MAGIC) return null
    const version = cursor.u32()
    if (version < 2 || version > 3) return null
    const tensorCount = cursor.u64()
    const kvCount = cursor.u64()

    const partial: PartialMeta = { visionHint: false }

    for (let i = 0; i < kvCount; i++) {
      if (Date.now() - started > PARSE_TIME_BUDGET_MS) break
      let key = ''
      try {
        key = cursor.str()
      } catch {
        break
      }
      const type = cursor.u32()
      const arch = partial.architecture
      const isContext = /\.context_length$/.test(key)
      const isEmbedding = /\.embedding_length$/.test(key)
      const isBlocks = /\.block_count$/.test(key)
      const isHeads = /\.attention\.head_count$/.test(key)
      const isHeadsKv = /\.attention\.head_count_kv$/.test(key)
      const interesting =
        key === 'general.architecture' ||
        key === 'general.name' ||
        key === 'general.file_type' ||
        key === 'tokenizer.chat_template' ||
        isContext ||
        isEmbedding ||
        isBlocks ||
        isHeads ||
        isHeadsKv

      if (/^(clip|vision|mmproj)\.|image/i.test(key)) partial.visionHint = true

      if (!interesting) {
        skipValue(cursor, type)
        continue
      }

      if (type === VALUE_STRING) {
        const value = cursor.str()
        if (key === 'general.architecture') partial.architecture = value || partial.architecture
        else if (key === 'general.name') partial.name = value || partial.name
        else if (key === 'tokenizer.chat_template') partial.chatTemplate = value
        continue
      }
      if (type === VALUE_ARRAY) {
        // head_count_kv 可能是数组（MoE / 分组 KV），取平均即可
        const itemType = cursor.u32()
        const len = cursor.u64()
        if (len > MAX_ARRAY_ITEMS) throw new Error('gguf array too large')
        const fixed = FIXED_SIZE[itemType]
        if (!fixed) {
          for (let j = 0; j < len; j++) skipValue(cursor, itemType)
          continue
        }
        if (isHeadsKv && (itemType === VALUE_UINT32 || itemType === VALUE_INT32 || itemType === VALUE_UINT64)) {
          let sum = 0
          for (let j = 0; j < len; j++) {
            const v = itemType === VALUE_UINT64 ? cursor.u64() : cursor.u32()
            sum += Number(v) || 0
          }
          if (len > 0) partial.headCountKv = Math.max(1, Math.round(sum / len))
        } else {
          cursor.skip(len * fixed)
        }
        continue
      }
      const value = readScalar(cursor, type)
      if (typeof value !== 'number') continue
      if (isContext && (!arch || key.startsWith(`${arch}.`))) partial.contextLength = value
      else if (isEmbedding) partial.embeddingLength = value
      else if (isBlocks) partial.blockCount = value
      else if (isHeads) partial.headCount = value
      else if (isHeadsKv) partial.headCountKv = value
      else if (key === 'general.file_type') partial.fileType = value
    }

    // 张量信息：读取维度求和得到参数量。名字直接跳过，避免不必要的内存占用
    let parameterCount = 0
    let tensorsRead = 0
    const tensorLimit = Math.min(tensorCount, MAX_TENSORS)
    for (let i = 0; i < tensorLimit; i++) {
      if (Date.now() - started > PARSE_TIME_BUDGET_MS) break
      const nameLen = cursor.u64()
      cursor.skip(nameLen)
      const nDims = cursor.u32()
      if (nDims > 8) break
      let elements = 1
      for (let d = 0; d < nDims; d++) {
        const dim = cursor.u64()
        elements *= dim
        if (!Number.isFinite(elements) || elements > 1e15) elements = 0
      }
      cursor.u32() // ggml type
      cursor.u64() // offset
      parameterCount += elements
      tensorsRead++
    }

    const template = partial.chatTemplate || ''
    meta = {
      version,
      architecture: partial.architecture,
      name: partial.name,
      contextLength: partial.contextLength,
      embeddingLength: partial.embeddingLength,
      blockCount: partial.blockCount,
      headCount: partial.headCount,
      headCountKv: partial.headCountKv,
      quantization: partial.fileType !== undefined ? FILE_TYPE_QUANT[partial.fileType] : undefined,
      parameterCount: parameterCount > 0 ? parameterCount : undefined,
      tensorCount: tensorsRead || tensorCount,
      kvCount,
      hasChatTemplate: !!template,
      supportsTools: template ? looksLikeToolsTemplate(template) : undefined,
      supportsThinking: inferThinking(partial.architecture, partial.name, template),
      supportsVision: inferVision(partial.architecture, partial.name, partial.visionHint),
      sizeBytes: size,
      parseMs: Date.now() - started
    }
    if (metaCache.size >= META_CACHE_LIMIT) {
      const first = metaCache.keys().next()
      if (!first.done) metaCache.delete(first.value)
    }
    metaCache.set(key, meta)
    return meta
  } catch {
    // 解析失败视为「没有元数据」，由调用方回退到文件名猜测，不影响模型可用性
    return meta
  } finally {
    try {
      closeSync(fd)
    } catch {
      /* ignore */
    }
  }
}

/** 统计当前元数据缓存大小（自检用） */
export function ggufCacheSize(): number {
  return metaCache.size
}
