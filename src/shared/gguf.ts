/** GGUF 元数据摘要（主进程解析，渲染层只读，用于展示与能力判断） */
export interface GgufMeta {
  version: number
  architecture?: string
  /** general.name，通常是模型的完整名字 */
  name?: string
  contextLength?: number
  embeddingLength?: number
  blockCount?: number
  headCount?: number
  headCountKv?: number
  /** 量化类型（来自 general.file_type） */
  quantization?: string
  /** 参数量（由张量维度求和得到） */
  parameterCount?: number
  tensorCount: number
  kvCount: number
  /** chat template 是否存在，以及是否声明了工具调用/思考能力 */
  hasChatTemplate: boolean
  supportsTools?: boolean
  supportsThinking?: boolean
  supportsVision?: boolean
  sizeBytes: number
  /** 解析耗时（毫秒），便于排查慢盘 */
  parseMs?: number
}

export function formatParamCount(count?: number): string | undefined {
  if (!count || count <= 0) return undefined
  if (count >= 1e12) return `${(count / 1e12).toFixed(1)}T`
  if (count >= 1e9) return `${(count / 1e9).toFixed(1)}B`
  if (count >= 1e6) return `${Math.round(count / 1e6)}M`
  return String(count)
}

/** 估算 KV cache 大小（字节）：2 bytes/element（f16），按层数 × 上下文 × KV 头 × 头维度 */
export function estimateKvCacheBytes(meta: GgufMeta | undefined, contextLength: number): number {
  if (!meta || !meta.blockCount || !meta.embeddingLength || !meta.headCount) return 0
  const heads = meta.headCountKv || meta.headCount
  const headDim = Math.ceil(meta.embeddingLength / meta.headCount)
  return Math.max(0, meta.blockCount * contextLength * heads * headDim * 2 * 2)
}
