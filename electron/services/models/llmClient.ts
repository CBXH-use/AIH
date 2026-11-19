import type { Provider } from '@shared/types'

export interface LlmToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  images?: string[]
  toolCalls?: LlmToolCall[]
  toolCallId?: string
  toolName?: string
}

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ChatStreamOptions {
  provider: Provider
  modelId: string
  messages: LlmMessage[]
  tools: ToolSchema[]
  temperature: number
  numCtx: number
  numPredict?: number
  keepAlive?: string
  think?: boolean
  signal: AbortSignal
  onText?: (delta: string) => void
  onThinking?: (delta: string) => void
}

export interface ChatStreamResult {
  text: string
  thinking: string
  toolCalls: LlmToolCall[]
  usage: { input: number; output: number }
}

export type LlmErrorCode = 'no-tools' | 'context' | 'connection' | 'model' | 'auth' | 'unknown'

export class LlmError extends Error {
  code: LlmErrorCode
  constructor(code: LlmErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'LlmError'
  }
}

function classifyError(status: number, body: string): LlmError {
  const text = body.toLowerCase()
  if (
    text.includes('does not support tools') ||
    text.includes('tools are not supported') ||
    text.includes('tool use is not supported') ||
    text.includes('does not support tool') ||
    text.includes('function calling') ||
    text.includes('tool_choice')
  ) {
    return new LlmError('no-tools', '当前模型不支持原生工具调用')
  }
  if (
    text.includes('context length') ||
    text.includes('context window') ||
    text.includes('available context size') ||
    text.includes('too many tokens') ||
    text.includes('exceeds the') ||
    text.includes('maximum context')
  ) {
    return new LlmError('context', '上下文超出模型窗口，请压缩上下文或调低上下文长度')
  }
  if (status === 401 || status === 403) return new LlmError('auth', 'API Key 无效或没有权限')
  if (status === 404) return new LlmError('model', '模型不存在，请检查模型名称或先下载模型')
  if (status === 400) return new LlmError('unknown', body.slice(0, 300) || '请求被模型拒绝')
  if (status >= 500) {
    const detail = body.replace(/\s+/g, ' ').trim().slice(0, 240)
    return new LlmError('connection', `模型服务异常（HTTP ${status}）${detail ? `：${detail}` : ''}`)
  }
  return new LlmError('unknown', body.slice(0, 300) || `请求失败（HTTP ${status}）`)
}

function networkError(err: unknown, provider: Provider): LlmError {
  if (err instanceof LlmError) return err
  if ((err as Error)?.name === 'AbortError') return new LlmError('connection', '已取消')
  return new LlmError('connection', `无法连接模型服务 ${provider.baseUrl}，请确认服务已启动`)
}

function apiBase(provider: Provider): string {
  return provider.baseUrl.replace(/\/+$/, '')
}

/**
 * 兼容两种 Base URL 写法：
 * - https://api.deepseek.com/v1  -> /chat/completions
 * - https://open.bigmodel.cn/api/paas/v4 -> /chat/completions
 * - http://127.0.0.1:8000         -> /v1/chat/completions
 */
function apiEndpoint(base: string, path: string): string {
  const trimmed = base.replace(/\/+$/, '')
  try {
    const url = new URL(trimmed)
    if (!url.pathname || url.pathname === '/') return `${trimmed}/v1/${path}`
  } catch {
    /* 交给 fetch 报错 */
  }
  return `${trimmed}/${path}`
}

async function readError(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return `HTTP ${res.status}`
  }
}

/** Ollama 原生 /api/chat：支持 thinking、图片与原生 tools。 */
export async function streamOllama(opts: ChatStreamOptions): Promise<ChatStreamResult> {
  const { provider, messages, signal, tools } = opts
  const payload: Record<string, unknown> = {
    model: opts.modelId,
    messages: messages.map((m) => {
      if (m.role === 'tool') return { role: 'tool', content: m.content, tool_name: m.toolName }
      const base: Record<string, unknown> = { role: m.role, content: m.content }
      if (m.images?.length) base.images = m.images
      if (m.toolCalls?.length) {
        base.tool_calls = m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } }))
      }
      return base
    }),
    stream: true,
    options: {
      temperature: opts.temperature,
      num_ctx: opts.numCtx,
      ...(opts.numPredict && opts.numPredict > 0 ? { num_predict: opts.numPredict } : {})
    }
  }
  if (opts.keepAlive) payload.keep_alive = opts.keepAlive
  if (opts.think !== undefined) payload.think = opts.think
  if (tools.length) {
    payload.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }))
  }

  let res: Response
  try {
    res = await fetch(`${apiBase(provider)}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}) },
      body: JSON.stringify(payload),
      signal
    })
  } catch (err) {
    throw networkError(err, provider)
  }
  if (!res.ok) throw classifyError(res.status, await readError(res))
  if (!res.body) throw new LlmError('unknown', '模型没有返回数据流')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let thinking = ''
  const calls: LlmToolCall[] = []
  let usage = { input: 0, output: 0 }

  const handleLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let data: any
    try {
      data = JSON.parse(trimmed)
    } catch {
      return
    }
    if (data.error) throw classifyError(400, String(data.error))
    const msg = data.message || {}
    if (typeof msg.thinking === 'string' && msg.thinking) {
      thinking += msg.thinking
      opts.onThinking?.(msg.thinking)
    }
    if (typeof msg.content === 'string' && msg.content) {
      text += msg.content
      opts.onText?.(msg.content)
    }
    if (Array.isArray(msg.tool_calls)) {
      for (const raw of msg.tool_calls) {
        const fn = raw?.function || {}
        let args = fn.arguments
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args)
          } catch {
            args = { input: args }
          }
        }
        calls.push({
          id: raw?.id || `call_${calls.length}_${Date.now()}`,
          name: String(fn.name || ''),
          arguments: (args || {}) as Record<string, unknown>
        })
      }
    }
    if (data.done) {
      usage = {
        input: Number(data.prompt_eval_count || 0),
        output: Number(data.eval_count || 0)
      }
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) handleLine(line)
    }
    if (buffer) handleLine(buffer)
  } catch (err) {
    if (signal.aborted) throw new LlmError('connection', '已取消')
    throw networkError(err, provider)
  }

  return { text, thinking, toolCalls: calls.filter((c) => c.name), usage }
}

/** OpenAI 兼容 /v1/chat/completions，覆盖 LM Studio、llama.cpp、vLLM、Ollama /v1、云端 API。 */
export async function streamOpenAI(opts: ChatStreamOptions): Promise<ChatStreamResult> {
  const { provider, messages, signal, tools } = opts
  const base = apiBase(provider)
  const url = apiEndpoint(base, 'chat/completions')

  const payload: Record<string, unknown> = {
    model: opts.modelId,
    messages: messages.map((m) => {
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
      if (m.role === 'assistant' && m.toolCalls?.length) {
        return {
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.arguments) }
          }))
        }
      }
      if (m.images?.length && m.role === 'user') {
        const content: unknown[] = [{ type: 'text', text: m.content }]
        for (const img of m.images) content.push({ type: 'image_url', image_url: { url: img } })
        return { role: 'user', content }
      }
      return { role: m.role, content: m.content }
    }),
    stream: true,
    stream_options: { include_usage: true },
    temperature: opts.temperature
  }
  if (tools.length) {
    payload.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }))
    payload.tool_choice = 'auto'
  }

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {})
      },
      body: JSON.stringify(payload),
      signal
    })
  } catch (err) {
    throw networkError(err, provider)
  }
  if (!res.ok) throw classifyError(res.status, await readError(res))
  if (!res.body) throw new LlmError('unknown', '模型没有返回数据流')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let thinking = ''
  const pending = new Map<number, { id: string; name: string; args: string }>()
  let usage = { input: 0, output: 0 }

  const handleData = (data: any) => {
    if (data.error) throw classifyError(400, typeof data.error === 'string' ? data.error : JSON.stringify(data.error))
    if (data.usage) {
      usage = { input: Number(data.usage.prompt_tokens || 0), output: Number(data.usage.completion_tokens || 0) }
    }
    const choice = data.choices?.[0]
    if (!choice) return
    const delta = choice.delta || {}
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      thinking += delta.reasoning_content
      opts.onThinking?.(delta.reasoning_content)
    }
    if (typeof delta.content === 'string' && delta.content) {
      text += delta.content
      opts.onText?.(delta.content)
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = Number(tc.index ?? 0)
        const cur = pending.get(idx) || { id: '', name: '', args: '' }
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name += tc.function.name
        if (tc.function?.arguments) cur.args += tc.function.arguments
        pending.set(idx, cur)
      }
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const dataStr = trimmed.slice(5).trim()
        if (!dataStr || dataStr === '[DONE]') continue
        try {
          handleData(JSON.parse(dataStr))
        } catch (err) {
          if (err instanceof LlmError) throw err
        }
      }
    }
  } catch (err) {
    if (signal.aborted) throw new LlmError('connection', '已取消')
    throw networkError(err, provider)
  }

  const calls: LlmToolCall[] = []
  for (const [, tc] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
    if (!tc.name) continue
    let args: Record<string, unknown> = {}
    try {
      args = tc.args ? JSON.parse(tc.args) : {}
    } catch {
      args = { input: tc.args }
    }
    calls.push({ id: tc.id || `call_${calls.length}_${Date.now()}`, name: tc.name, arguments: args })
  }

  return { text, thinking, toolCalls: calls, usage }
}

/** 简单测试：拉取模型列表，用于供应商连通性检测。 */
export async function listProviderModels(provider: Provider, timeoutMs = 6000): Promise<string[]> {
  const base = apiBase(provider)
  const headers: Record<string, string> = {}
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`
  if (provider.kind === 'ollama') {
    const res = await fetch(`${base}/api/tags`, { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data: any = await res.json()
    return (data.models || []).map((m: any) => String(m.name)).filter(Boolean)
  }
  const url = apiEndpoint(base, 'models')
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data: any = await res.json()
  return (data.data || data.models || []).map((m: any) => String(m.id || m.name)).filter(Boolean)
}

export async function streamChat(opts: ChatStreamOptions): Promise<ChatStreamResult> {
  if (opts.provider.kind === 'ollama') return streamOllama(opts)
  return streamOpenAI(opts)
}

/** 部分服务不提供 /models，用一次最小对话请求验证地址与密钥是否可用。 */
export async function probeProviderChat(provider: Provider, modelId: string, timeoutMs = 10000): Promise<void> {
  const base = apiBase(provider)
  const url = apiEndpoint(base, 'chat/completions')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false
    }),
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!res.ok) throw new Error(await readError(res))
}
