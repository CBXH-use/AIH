import type { HardwareInfo, ModelFit, ModelInfo } from '@shared/types'
import { estimateKvCacheBytes, formatParamCount } from '@shared/gguf'

const GiB = 1024 ** 3
const RUNTIME_OVERHEAD_GB = 0.6
const DEFAULT_CONTEXT = 8192
const MAX_CONTEXT = 32768

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * 按硬件给模型打分。核心是估算真实内存占用：
 * 权重 ≈ 文件大小；KV cache 来自 GGUF 的层数/头数；再加上运行时开销。
 * 内置运行时的 llama.cpp 是 CPU 版本，只看内存；Ollama 有 GPU 时优先看显存。
 */
export function scoreModelFit(model: ModelInfo, hw: HardwareInfo): ModelFit {
  const weightsGb = model.sizeBytes ? model.sizeBytes / GiB : 0
  const context = Math.max(2048, Math.min(model.contextLength || DEFAULT_CONTEXT, MAX_CONTEXT))
  let kvCacheGb = estimateKvCacheBytes(model.gguf, context) / GiB
  if (!kvCacheGb) {
    // 没有元数据时按参数量粗估：8B 模型在 8K 上下文约 1GB KV cache
    const params = model.parameterCount || 0
    kvCacheGb = params > 0 ? (params / 8e9) * (context / 8192) * 1.0 : (model.sizeBytes || 0) / GiB / 5
  }
  const requiredRamGb = round1(weightsGb + kvCacheGb + RUNTIME_OVERHEAD_GB)
  const totalRam = hw.totalRamGb || 8
  // 给系统和其他应用留 25%
  const ramBudget = totalRam * 0.75

  const isBuiltinRuntime = model.providerId === 'aih-runtime' || model.providerId === 'local-files'
  const vram = hw.vramGb || 0
  const gpuOk = !isBuiltinRuntime && vram > 0

  if (gpuOk) {
    const gpuNeed = weightsGb + kvCacheGb + 0.4
    if (vram >= gpuNeed * 1.15 && ramBudget >= requiredRamGb * 0.6) {
      return {
        level: 'great',
        requiredRamGb,
        weightsGb: round1(weightsGb),
        kvCacheGb: round1(kvCacheGb),
        gpuOk,
        suggestedContext: context,
        reason: `可完整放入 ${round1(vram)}GB 显存，速度较快`
      }
    }
    if (vram >= weightsGb * 0.55 && ramBudget >= requiredRamGb) {
      return {
        level: 'ok',
        requiredRamGb,
        weightsGb: round1(weightsGb),
        kvCacheGb: round1(kvCacheGb),
        gpuOk,
        suggestedContext: Math.min(context, 8192),
        reason: `显存可放部分权重，其余走内存，8K 上下文更稳`
      }
    }
  }

  if (ramBudget >= requiredRamGb * 1.25 && requiredRamGb <= totalRam * 0.5) {
    return {
      level: 'great',
      requiredRamGb,
      weightsGb: round1(weightsGb),
      kvCacheGb: round1(kvCacheGb),
      gpuOk,
      suggestedContext: context,
      reason: `内存充裕（约需 ${requiredRamGb}GB），CPU 推理可流畅运行`
    }
  }
  if (ramBudget >= requiredRamGb) {
    return {
      level: 'ok',
      requiredRamGb,
      weightsGb: round1(weightsGb),
      kvCacheGb: round1(kvCacheGb),
      gpuOk,
      suggestedContext: Math.min(context, 8192),
      reason: `约需 ${requiredRamGb}GB 内存，可用但回答会偏慢`
    }
  }
  return {
    level: 'heavy',
    requiredRamGb,
    weightsGb: round1(weightsGb),
    kvCacheGb: round1(kvCacheGb),
    gpuOk,
    suggestedContext: 4096,
    reason: `约需 ${requiredRamGb}GB，超过本机可用内存（${round1(ramBudget)}GB），容易卡死`
  }
}

/** 给 UI 用的简短备注，例如「7.6B · Q4_K_M · 约需 6.2GB」 */
export function fitSummary(model: ModelInfo, fit: ModelFit): string {
  const params = formatParamCount(model.parameterCount)
  const parts = [params, model.quantization, `约需 ${fit.requiredRamGb}GB`].filter(Boolean)
  return parts.join(' · ')
}
