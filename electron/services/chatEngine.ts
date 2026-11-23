import { randomUUID } from 'crypto'
import { promises as fsp } from 'fs'
import type {
  AgentPreset,
  ApprovalRequest,
  ChatMessage,
  ChatStreamEvent,
  HarnessConfig,
  ModelRef,
  PermissionMode,
  Provider,
  RiskAssessment,
  Session,
  ToolCall,
  ToolResult
} from '@shared/types'
import { BUILTIN_AGENTS } from '@shared/defaults'
import { asksForUserReply } from '@shared/chatHeuristics'
import { LlmError, streamChat, type ChatStreamResult, type LlmMessage } from './models/llmClient'
import type { ModelService } from './modelService'
import type { KnowledgeService } from './knowledgeService'
import type { PluginService } from './pluginService'
import type { Store } from './store'
import { buildTools, pluginToolSpecs, type ToolContext, type ToolSpec } from './harness/tools'
import { imagePartDataUrl, type AttachmentService } from './attachments'

export type ApprovalDecision = 'allow' | 'allow-always' | 'deny'

export interface ChatEngineDeps {
  store: Store
  models: ModelService
  knowledge: KnowledgeService
  plugins: PluginService
  attachments: AttachmentService
  emit: (e: ChatStreamEvent) => void
  emitApproval: (req: ApprovalRequest) => void
  requestApproval: (req: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalDecision>
  /** 评测/自动化：跳过「完全放行」需要用户先确认的限制（调用方自行承担风险） */
  fullAccessOverride?: boolean
}

const EMPTY_USAGE = { input: 0, output: 0, compressed: 0 }

export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) || 0
    if (code >= 0x2e80 && code <= 0x9fff) cjk++
  }
  const latin = text.length - cjk
  return Math.ceil(cjk * 1.05 + latin / 3.6) + 4
}

export function estimateMessageTokens(messages: ChatMessage[]): number {
  let total = 0
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === 'text' || p.type === 'reasoning') total += estimateTokens(p.text)
      if (p.type === 'tool-call') total += estimateTokens(JSON.stringify(p.call.arguments)) + 12
      if (p.type === 'tool-result') total += estimateTokens(p.result.output) + 12
      if (p.type === 'image') total += 800
    }
  }
  return total
}

/** local: 本地推理服务（Ollama / LM Studio / llama.cpp / 本机地址）；api: 云端 API */
export type HarnessProfile = 'local' | 'api'

const LOCAL_PROVIDER_KINDS = new Set<Provider['kind']>(['ollama', 'lmstudio', 'llamacpp'])

export function isLocalProvider(provider: Provider): boolean {
  if (provider.isLocal || LOCAL_PROVIDER_KINDS.has(provider.kind)) return true
  return /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(provider.baseUrl.trim())
}

const TOOL_NAME_ALIASES: Record<string, string> = {
  write: 'write_file',
  writefile: 'write_file',
  create_file: 'write_file',
  createfile: 'write_file',
  save_file: 'write_file',
  edit: 'edit_file',
  editfile: 'edit_file',
  replace_file: 'edit_file',
  apply_patch: 'edit_file',
  read: 'read_file',
  readfile: 'read_file',
  open_file: 'read_file',
  list: 'list_dir',
  listdir: 'list_dir',
  list_files: 'list_dir',
  ls: 'list_dir',
  run: 'shell',
  exec: 'shell',
  execute: 'shell',
  bash: 'shell',
  powershell: 'shell',
  cmd: 'shell',
  search: 'web_search',
  fetch: 'web_fetch',
  todo: 'todo_write',
  todos: 'todo_write'
}

function normalizeToolName(name: string): string {
  const clean = String(name || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (TOOL_NAME_ALIASES[clean]) return TOOL_NAME_ALIASES[clean]
  if (clean.endsWith('_tool')) {
    const base = clean.slice(0, -5)
    if (TOOL_NAME_ALIASES[base]) return TOOL_NAME_ALIASES[base]
  }
  return clean
}

/** 把反引号模板字符串转成合法的 JSON 字符串（本地模型常直接把代码内容用 ` 包起来） */
function quoteBacktickStrings(raw: string): string {
  let out = ''
  let inBacktick = false
  let escaped = false
  for (const ch of raw) {
    if (inBacktick) {
      if (escaped) {
        out += ch
        escaped = false
        continue
      }
      if (ch === '\\') {
        out += ch
        escaped = true
        continue
      }
      if (ch === '`') {
        out += '"'
        inBacktick = false
        continue
      }
      if (ch === '"') {
        out += '\\"'
        continue
      }
      if (ch === '\n') {
        out += '\\n'
        continue
      }
      if (ch === '\r') continue
      if (ch === '\t') {
        out += '\\t'
        continue
      }
      out += ch
    } else {
      if (ch === '`') {
        out += '"'
        inBacktick = true
        continue
      }
      out += ch
    }
  }
  return out
}

/** 去掉对象/数组末尾的多余逗号（只处理字符串外的逗号） */
function stripTrailingCommas(raw: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === ',') {
      let j = i + 1
      while (j < raw.length && /\s/.test(raw[j])) j++
      if (raw[j] === '}' || raw[j] === ']') continue
      out += ch
      continue
    }
    out += ch
  }
  return out
}

/** 补齐小模型漏掉的右括号/引号，让「差一点就完整」的 JSON 可以解析 */
function balanceJson(raw: string): string {
  let out = ''
  let inString = false
  let escaped = false
  const stack: string[] = []
  for (const ch of raw) {
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '{') {
      stack.push('}')
      out += ch
      continue
    }
    if (ch === '[') {
      stack.push(']')
      out += ch
      continue
    }
    if (ch === '}' || ch === ']') {
      if (stack[stack.length - 1] === ch) stack.pop()
      out += ch
      continue
    }
    out += ch
  }
  if (inString) out += '"'
  while (stack.length) out += stack.pop()
  return out
}

/** 把字符串内未转义的换行/制表符转义，修复小模型生成的不合法 JSON */
function repairJsonText(raw: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (const ch of raw) {
    if (inString) {
      if (escaped) {
        out += ch
        escaped = false
        continue
      }
      if (ch === '\\') {
        out += ch
        escaped = true
        continue
      }
      if (ch === '"') {
        out += ch
        inString = false
        continue
      }
      if (ch === '\n') {
        out += '\\n'
        continue
      }
      if (ch === '\r') continue
      if (ch === '\t') {
        out += '\\t'
        continue
      }
      out += ch
    } else {
      if (ch === '"') inString = true
      out += ch
    }
  }
  return out
}

function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const candidates = [trimmed]
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  if (fenced) candidates.push(fenced[1].trim())
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      const repaired = stripTrailingCommas(repairJsonText(candidate))
      const quoted = stripTrailingCommas(repairJsonText(quoteBacktickStrings(candidate)))
      const attempts = [
        repaired,
        quoted,
        balanceJson(repaired),
        balanceJson(quoted)
      ]
      for (const attempt of attempts) {
        try {
          const parsed = JSON.parse(attempt)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
        } catch {
          /* 尝试下一种修复 */
        }
      }
    }
  }
  return null
}

function stripWrappingQuotes(text: string): string {
  return text.trim().replace(/^[`"']+|[`"']+$/g, '')
}

function coerceText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((v) => String(v)).join('\n')
  if (value && typeof value === 'object') return JSON.stringify(value, null, 2)
  return String(value ?? '')
}

function normalizeTodoStatus(value: unknown): 'pending' | 'in_progress' | 'completed' {
  const text = String(value ?? '').toLowerCase()
  // 先排除「待完成 / 未完成」这类否定表达，避免被「完成」误判
  if (/未完成|未开始|待完成|待办|待确认|待进行|pending|todo/.test(text)) return 'pending'
  if (/已完成|完成|done|complete/.test(text)) return 'completed'
  if (/进行|doing|progress/.test(text)) return 'in_progress'
  return 'pending'
}

/** 统一小模型常见参数别名，并解开被包了一层的参数对象；不改变正常调用 */
export function normalizeToolArguments(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  // 有些小模型直接返回数组作为参数（例如 todo_write 的步骤列表）
  const raw: unknown = input
  let args: Record<string, unknown> = Array.isArray(raw)
    ? { items: raw }
    : { ...((raw as Record<string, unknown>) || {}) }
  const keys = Object.keys(args)
  if (keys.length === 1 && ['input', 'arguments', 'args', 'parameters'].includes(keys[0])) {
    const value = args[keys[0]]
    if (typeof value === 'string') {
      const parsed = tryParseJsonObject(value)
      if (parsed) args = parsed
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      args = { ...(value as Record<string, unknown>) }
    }
  } else if (args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)) {
    args = { ...args, ...(args.arguments as Record<string, unknown>) }
    delete args.arguments
  }

  const pickString = (...names: string[]): string | undefined => {
    for (const name of names) {
      const value = args[name]
      if (typeof value === 'string' && value.trim()) return value.trim()
      if (typeof value === 'number') return String(value)
    }
    return undefined
  }
  const pickValue = (...names: string[]): unknown => {
    for (const name of names) {
      if (args[name] !== undefined && args[name] !== null) return args[name]
    }
    return undefined
  }

  const out: Record<string, unknown> = { ...args }
  const assignPath = () => {
    const path = pickString('path', 'file_path', 'filepath', 'filename', 'file', 'target_path', 'target')
    if (path) out.path = stripWrappingQuotes(path)
  }

  switch (tool) {
    case 'write_file': {
      assignPath()
      const content = pickValue('content', 'text', 'code', 'body', 'data', 'file_content', 'new_content')
      if (content !== undefined) out.content = coerceText(content)
      break
    }
    case 'edit_file': {
      assignPath()
      const find = pickValue('find', 'old_string', 'oldText', 'old_text', 'old', 'search', 'from', 'original')
      const replace = pickValue('replace', 'new_string', 'newText', 'new_text', 'new', 'replacement', 'to')
      if (find !== undefined) out.find = coerceText(find)
      if (replace !== undefined) out.replace = coerceText(replace)
      if (out.replaceAll === undefined && args.replace_all !== undefined) out.replaceAll = Boolean(args.replace_all)
      break
    }
    case 'read_file': {
      assignPath()
      for (const key of ['offset', 'limit']) {
        if (typeof out[key] === 'string' && /^\d+$/.test(String(out[key]).trim())) out[key] = Number(out[key])
      }
      break
    }
    case 'list_dir': {
      assignPath()
      if (typeof out.depth === 'string' && /^\d+$/.test(out.depth.trim())) out.depth = Number(out.depth)
      break
    }
    case 'glob': {
      const pattern = pickString('pattern', 'glob', 'glob_pattern')
      if (pattern) out.pattern = pattern
      assignPath()
      break
    }
    case 'grep': {
      const pattern = pickString('pattern', 'regex', 'query')
      if (pattern) out.pattern = pattern
      assignPath()
      break
    }
    case 'shell': {
      const command = pickString('command', 'cmd', 'script', 'shell')
      if (command) out.command = command
      const cwd = pickString('cwd', 'dir', 'working_directory')
      if (cwd) out.cwd = cwd
      break
    }
    case 'web_fetch': {
      const url = pickString('url', 'href', 'link')
      if (url) out.url = url
      break
    }
    case 'web_search':
    case 'knowledge_search': {
      const query = pickString('query', 'q', 'keywords', 'question')
      if (query) out.query = query
      break
    }
    case 'todo_write': {
      const rawItems = Array.isArray(out.items) ? out.items : Array.isArray(args.todos) ? args.todos : []
      if (rawItems.length) {
        out.items = rawItems.map((rawItem) => {
          if (rawItem && typeof rawItem === 'object') {
            const item = rawItem as Record<string, unknown>
            return {
              content: String(item.content ?? item.action ?? item.title ?? item.task ?? ''),
              status: normalizeTodoStatus(item.status)
            }
          }
          return { content: String(rawItem ?? ''), status: 'pending' }
        })
      }
      break
    }
    default:
      break
  }
  return out
}

function textOf(m: ChatMessage): string {
  return m.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

function imageParts(m: ChatMessage): Extract<ChatMessage['parts'][number], { type: 'image' }>[] {
  return m.parts.filter((p): p is Extract<ChatMessage['parts'][number], { type: 'image' }> => p.type === 'image')
}

function newMessage(role: ChatMessage['role'], parts: ChatMessage['parts'] = [], model?: ModelRef | null): ChatMessage {
  return {
    id: randomUUID(),
    role,
    parts,
    createdAt: Date.now(),
    model: model || undefined,
    streaming: role === 'assistant'
  }
}

function deriveTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > 26 ? clean.slice(0, 26) + '…' : clean || '新对话'
}

export class ChatEngine {
  private runs = new Map<string, AbortController>()
  private runPromises = new Map<string, Promise<void>>()
  private alwaysAllow = new Map<string, Set<string>>()
  private promptModeModels = new Set<string>()
  private noThinkModels = new Set<string>()
  private warnedFull = new Set<string>()

  constructor(private deps: ChatEngineDeps) {}

  isRunning(sessionId: string): boolean {
    return this.runs.has(sessionId)
  }

  listAgents(): AgentPreset[] {
    const pluginAgents = this.deps.plugins.getAgentPresets()
    return [...BUILTIN_AGENTS, ...pluginAgents, ...this.deps.store.customAgents]
  }

  agentById(id: string): AgentPreset {
    return this.listAgents().find((a) => a.id === id) || BUILTIN_AGENTS[0]
  }

  async send(
    sessionId: string,
    text: string,
    images?: { dataUrl?: string; file?: string; name?: string }[]
  ): Promise<void> {
    const session = this.deps.store.getSession(sessionId)
    if (!session) throw new Error('会话不存在')
    if (this.runs.has(sessionId)) throw new Error('该会话正在运行，请先停止')
    if (!session.model) throw new Error('请先在顶部选择或部署一个模型')
    if (!text.trim() && !images?.length) throw new Error('消息不能为空')

    const parts: ChatMessage['parts'] = []
    if (text.trim()) parts.push({ type: 'text', text })
    const userMsg = newMessage('user', parts)
    for (const img of images || []) {
      if (img.file) {
        // 重新生成等场景：图片已经在磁盘上，直接复用
        userMsg.parts.push({ type: 'image', file: img.file, name: img.name })
        continue
      }
      if (!img.dataUrl) continue
      try {
        const saved = await this.deps.attachments.save(img.dataUrl, img.name)
        userMsg.parts.push({
          type: 'image',
          file: saved.file,
          name: img.name,
          mime: saved.mime,
          sizeBytes: saved.sizeBytes
        })
      } catch {
        // 落盘失败时保留内联数据，至少这一轮还能使用
        userMsg.parts.push({ type: 'image', dataUrl: img.dataUrl, name: img.name })
      }
    }
    userMsg.streaming = false
    session.messages.push(userMsg)
    session.status = 'idle'
    if (this.deps.store.settings.harness.autoTitle !== false && (!session.title || session.title === '新对话' || session.title === 'New chat')) {
      session.title = deriveTitle(text)
      this.deps.emit({ sessionId, messageId: userMsg.id, type: 'title', title: session.title })
    }
    session.updatedAt = Date.now()
    this.deps.store.upsertSession(session)
    let promise: Promise<void>
    promise = this.run(session)
      .catch(() => undefined)
      .finally(() => {
        if (this.runPromises.get(sessionId) === promise) this.runPromises.delete(sessionId)
      })
    this.runPromises.set(sessionId, promise)
    void promise
  }

  /** 等待某会话当前这一轮运行结束（评测/自动化用） */
  async waitForRun(sessionId: string): Promise<void> {
    const running = this.runPromises.get(sessionId)
    if (running) await running
  }

  stop(sessionId: string) {
    const ac = this.runs.get(sessionId)
    if (ac) ac.abort()
    const session = this.deps.store.getSession(sessionId)
    if (session) {
      session.status = 'idle'
      for (const m of session.messages) m.streaming = false
      session.updatedAt = Date.now()
      this.deps.store.upsertSession(session)
      this.deps.emit({ sessionId, messageId: '', type: 'status', status: 'idle' })
    }
  }

  async regenerate(sessionId: string, messageId: string): Promise<void> {
    const session = this.deps.store.getSession(sessionId)
    if (!session) throw new Error('会话不存在')
    if (this.runs.has(sessionId)) throw new Error('该会话正在运行')
    if (!session.model) throw new Error('请先在顶部选择或部署一个模型')
    const idx = session.messages.findIndex((m) => m.id === messageId)
    if (idx < 0) throw new Error('消息不存在')
    let userIdx = -1
    for (let i = idx; i >= 0; i--) {
      if (session.messages[i].role === 'user') {
        userIdx = i
        break
      }
    }
    if (userIdx < 0) throw new Error('找不到对应的用户消息')
    const userMsg = session.messages[userIdx]
    const text = textOf(userMsg)
    const images = imageParts(userMsg).map((p) => ({ file: p.file, dataUrl: p.dataUrl, name: p.name }))
    // 先保存快照：send() 可能失败（会话被占用、模型失效等），失败时必须完整回滚
    const snapshotMessages = session.messages
    const snapshotContext = session.context
    const snapshotTitle = session.title
    session.messages = session.messages.slice(0, userIdx)
    // 历史被截断后旧的压缩摘要游标可能失效，直接重置，避免丢失后续上下文
    session.context = undefined
    session.updatedAt = Date.now()
    this.deps.store.upsertSession(session)
    try {
      await this.send(sessionId, text, images)
    } catch (err) {
      const current = this.deps.store.getSession(sessionId)
      if (current) {
        current.messages = snapshotMessages
        current.context = snapshotContext
        current.title = snapshotTitle
        current.updatedAt = Date.now()
        this.deps.store.upsertSession(current)
      }
      throw err
    }
  }

  async compressContext(sessionId: string): Promise<{ before: number; after: number }> {
    const session = this.deps.store.getSession(sessionId)
    if (!session) throw new Error('会话不存在')
    if (this.runs.has(sessionId)) throw new Error('对话进行中，无法手动压缩')
    const before = estimateMessageTokens(session.messages)
    await this.compress(session, true)
    const after = estimateMessageTokens(this.activeMessages(session))
    return { before, after }
  }

  private activeMessages(session: Session): ChatMessage[] {
    const start = session.context?.startIndex ?? 0
    return session.messages.slice(start)
  }

  private async run(session: Session): Promise<void> {
    const ac = new AbortController()
    this.runs.set(session.id, ac)
    session.status = 'running'
    session.tokenUsage = session.tokenUsage || { ...EMPTY_USAGE }
    this.emitStatus(session)
    let currentAssistant: ChatMessage | null = null
    let lastSignature = ''
    let repeatCount = 0
    let step = 0
    let fatal: string | null = null
    // 本地模型偶尔只“说”不“做”，给它一次带纠正指令的重试机会
    let nudge = ''
    let nudged = false
    let wantsUserReply = false
    let endedByQuestion = false

    try {
      const provider = await this.resolveProvider(session)
      if (!provider) throw new Error('模型供应商不可用，请到「本地模型」页面检查连接')
      // 本地模型与云端 API 使用两套 harness：本地侧重容错与短提示词，API 侧重原生工具调用
      const profile: HarnessProfile = isLocalProvider(provider) ? 'local' : 'api'
      const cfg = this.deps.store.settings.harness
      const isChat = session.mode === 'chat'

      if (
        !isChat &&
        session.permissionMode === 'full' &&
        !this.deps.store.settings.fullAccessAcknowledged &&
        !this.deps.fullAccessOverride
      ) {
        session.permissionMode = 'auto-safe'
        this.emit(session, '', 'notice', '尚未确认完全放行风险，本次已自动降为「自动审批」模式', 'warn')
      }

      await this.prepareContext(session, cfg)

      // 对话模式不加载工具，提示词更短，首 token 更快
      const tools = isChat ? {} : this.collectTools(agentToolNames(this.agentById(session.agentId)))
      const ctx: ToolContext = {
        sessionId: session.id,
        workspaceDir: session.workspaceDir,
        permissionMode: session.permissionMode,
        settings: this.deps.store.settings,
        store: this.deps.store,
        knowledge: this.deps.knowledge,
        plugins: this.deps.plugins,
        profile
      }

      const stepLimit = isChat ? 1 : cfg.maxSteps
      for (step = 0; step < stepLimit; step++) {
        if (ac.signal.aborted) break

        currentAssistant = newMessage('assistant', [], session.model)
        session.messages.push(currentAssistant)
        const assistantRef = currentAssistant

        const result = await this.callModel(session, provider, ac.signal, assistantRef, tools, profile, nudge)
        nudge = ''

        let calls = result.toolCalls
        if (!calls.length) calls = this.maybeParsePromptCalls(session, result.text, profile)
        calls = this.normalizeToolCalls(calls, tools)
        assistantRef.streaming = false

        // 有些小模型会直接在文本里“编造”工具调用与成功结果，实际上没有执行任何操作
        let retryWithNudge = false
        if (!isChat && !calls.length && this.looksLikeFakeToolNarration(result.text)) {
          const willRetry = profile === 'local' && !nudged
          const note = willRetry
            ? '模型只生成了工具调用的文字描述，已要求它重新执行。'
            : '模型只生成了工具调用的文字描述，并没有真正执行工具。请重试，或换用支持工具调用的模型（如 qwen2.5:7b / qwen3）。'
          assistantRef.parts.push({ type: 'notice', level: willRetry ? 'warn' : 'error', text: note })
          this.emit(session, assistantRef.id, 'notice', note, willRetry ? 'warn' : 'error')
          if (willRetry) {
            nudged = true
            retryWithNudge = true
            nudge =
              '你上一条回复只描述了操作，没有真正调用工具。请立刻调用工具完成用户要求的文件操作：新建文件用 write_file，修改文件先 read_file 再 edit_file。不要只回复文字。'
          }
        }

        if (result.thinking) {
          const p = assistantRef.parts.find((x) => x.type === 'reasoning')
          if (!p) assistantRef.parts.unshift({ type: 'reasoning', text: result.thinking })
        }

        session.tokenUsage.input += result.usage.input
        session.tokenUsage.output += result.usage.output
        if (!result.text && !result.thinking && !calls.length) {
          assistantRef.parts.push({ type: 'notice', level: 'warn', text: '模型没有返回内容。可尝试降低温度、换用其他模型，或在设置中调整上下文长度。' })
        }

        // 模型在回复里向用户提问或要求确认时，执行完本步工具后就暂停，等用户真正回复
        wantsUserReply = asksForUserReply(result.text)

        if (calls.length) {
          for (const call of calls) {
            assistantRef.parts.push({ type: 'tool-call', call })
            this.emit(session, assistantRef.id, 'tool-call', undefined, undefined, call)
          }
          const signature = calls.map((c) => c.name + JSON.stringify(c.arguments)).join('|')
          if (signature === lastSignature) repeatCount++
          else {
            repeatCount = 1
            lastSignature = signature
          }
          if (repeatCount >= Math.max(2, cfg.loopGuard)) {
            const note = `检测到工具调用重复 ${repeatCount} 次（${calls.map((c) => c.name).join(', ')}），已停止循环。请调整提示词或换用能力更强的模型。`
            assistantRef.parts.push({ type: 'notice', level: 'error', text: note })
            this.emit(session, assistantRef.id, 'notice', note, 'error')
            break
          }
          await this.executeToolCalls(session, assistantRef, calls, tools, ctx, ac.signal, profile)
          this.deps.store.upsertSession(session)
          if (ac.signal.aborted) break
          if (wantsUserReply) {
            endedByQuestion = true
            break
          }
          continue
        }
        if (retryWithNudge) continue
        if (wantsUserReply) endedByQuestion = true
        break
      }

      if (currentAssistant && endedByQuestion && !ac.signal.aborted) {
        currentAssistant.awaitingReply = true
      }

      if (step >= stepLimit) {
        this.emit(session, currentAssistant?.id || '', 'notice', `已达到最大步数 ${stepLimit}，任务暂停。可在设置中调大 maxSteps。`, 'warn')
      }
      if (ac.signal.aborted) {
        const note = '已停止生成'
        if (currentAssistant) currentAssistant.parts.push({ type: 'notice', level: 'info', text: note })
        this.emit(session, currentAssistant?.id || '', 'notice', note, 'info')
      }
      session.status = 'idle'
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (ac.signal.aborted) {
        session.status = 'idle'
      } else {
        session.status = 'error'
        fatal = message
        if (currentAssistant) {
          currentAssistant.parts.push({ type: 'notice', level: 'error', text: message })
        }
        this.emit(session, currentAssistant?.id || '', 'error', message, 'error')
      }
    } finally {
      if (currentAssistant) currentAssistant.streaming = false
      session.updatedAt = Date.now()
      const stillExists = !!this.deps.store.getSession(session.id)
      if (stillExists) {
        this.deps.store.upsertSession(session)
        this.emitStatus(session)
        this.deps.emit({ sessionId: session.id, messageId: currentAssistant?.id || '', type: 'message-done' })
      } else {
        // 运行中会话被用户删除：finally 不能再把它写回去
        this.alwaysAllow.delete(session.id)
      }
      this.runs.delete(session.id)
      void fatal
    }
  }

  private async resolveProvider(session: Session): Promise<Provider | null> {
    const ref = session.model
    if (!ref) return null
    let provider =
      this.deps.models.getProviders().find((p) => p.id === ref.providerId) ||
      this.deps.store.settings.modelSettings.providers.find((p) => p.id === ref.providerId) ||
      null
    if (ref.providerId === 'aih-runtime') {
      // 内置运行时可能还没启动：首次对话时自动拉起对应模型
      const ready = await this.deps.models.ensureRuntimeModel(ref.modelId).catch(() => null)
      if (ready) return ready
    }
    if (ref.providerId === 'ollama' && !provider) {
      provider = {
        id: 'ollama',
        name: 'Ollama',
        kind: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        isLocal: true,
        enabled: true,
        state: 'online'
      }
    }
    if (provider && provider.kind === 'ollama' && provider.state !== 'online') {
      await this.deps.models.startProvider('ollama').catch(() => undefined)
      provider = this.deps.models.getProviders().find((p) => p.id === 'ollama') || { ...provider, state: 'online' }
    }
    return provider
  }

  private emit(session: Session, messageId: string, type: ChatStreamEvent['type'], text?: string, level?: ChatStreamEvent['level'], call?: ToolCall) {
    this.deps.emit({ sessionId: session.id, messageId, type, text, level, call })
  }

  private emitStatus(session: Session) {
    this.deps.emit({ sessionId: session.id, messageId: '', type: 'status', status: session.status })
  }

  /** 该次会话使用的 harness 类型（本地模型 / 云端 API） */
  private normalizeToolCalls(calls: ToolCall[], tools: Record<string, ToolSpec>): ToolCall[] {
    return calls.map((call) => {
      const aliased = normalizeToolName(call.name)
      const name = tools[aliased] ? aliased : call.name.trim()
      return {
        ...call,
        name,
        arguments: normalizeToolArguments(name, call.arguments || {})
      }
    })
  }

  private collectTools(agentTools: string[]): Record<string, ToolSpec> {
    const builtin = buildTools()
    const plugins = pluginToolSpecs(this.deps.plugins)
    const all: Record<string, ToolSpec> = { ...builtin }
    for (const t of plugins) all[t.name] = t
    const filtered: Record<string, ToolSpec> = {}
    for (const name of agentTools) {
      if (all[name]) filtered[name] = all[name]
    }
    for (const t of plugins) filtered[t.name] = t
    return filtered
  }

  private promptModeFor(session: Session): boolean {
    const cfg = this.deps.store.settings.harness
    const key = `${session.model?.providerId}::${session.model?.modelId}`
    // 曾经自动降级过的模型：重启后也直接用文本协议，避免每轮都先失败一次
    const remembered = this.deps.store.settings.modelSettings.toolProtocol?.[key]
    if (cfg.toolMode === 'prompt' || remembered === 'prompt') return true
    if (cfg.toolMode === 'native' || remembered === 'native') return false
    if (this.promptModeModels.has(key)) return true
    // 已知不支持原生工具调用的推理模型，直接走文本协议，避免 Ollama 返回 400/500
    if (/deepseek-r1|deepseek-reasoner|qwq|marco-o1/i.test(session.model?.modelId || '')) return true
    const info = this.deps.models.getModels().find((m) => m.id === key)
    if (info?.supportsTools === false) return true
    // GGUF 没有 chat template 时，llama.cpp 无法把 tools 注入对话，原生调用必然失败
    if (info?.gguf && info.gguf.hasChatTemplate === false) return true
    return false
  }

  /** 记住某模型实际可用的工具协议（自动降级后不再反复试错） */
  private rememberToolProtocol(session: Session, mode: 'native' | 'prompt') {
    const key = `${session.model?.providerId}::${session.model?.modelId}`
    const current = this.deps.store.settings.modelSettings.toolProtocol || {}
    if (current[key] === mode) return
    if (Object.keys(current).length > 100) return
    this.deps.store.updateSettings({
      modelSettings: { ...this.deps.store.settings.modelSettings, toolProtocol: { ...current, [key]: mode } }
    })
  }

  /** 思考决策：全局模式 + 自适应（简单任务不思考） */
  private thinkDecision(session: Session, isChat: boolean, modelSupportsThinking: boolean): boolean | undefined {
    if (!modelSupportsThinking) return undefined
    const cfg = this.deps.store.settings.harness
    const thinking = cfg.thinking || { mode: 'auto', adaptive: true, budgetTokens: 2048, simpleTaskMaxChars: 60 }
    if (isChat) return thinking.mode === 'always' ? true : false
    if (thinking.mode === 'never') return false
    if (thinking.mode === 'always') return true
    if (thinking.adaptive && isSimpleRequest(lastUserText(session), thinking.simpleTaskMaxChars)) return false
    return undefined
  }

  /** 用户配置的窗口不能超过模型自身能力，避免小模型被塞爆或 KV 缓存过大 */
  private effectiveWindow(session: Session): number {
    const configured = this.deps.store.settings.harness.context.window
    const info = this.deps.models
      .getModels()
      .find((m) => m.providerId === session.model?.providerId && (m.remoteId === session.model?.modelId || m.id === `${session.model?.providerId}::${session.model?.modelId}`))
    const modelCtx = info?.contextLength
    if (!modelCtx) return configured
    return Math.max(2048, Math.min(configured, modelCtx))
  }

  private async callModel(
    session: Session,
    provider: Provider,
    signal: AbortSignal,
    assistant: ChatMessage,
    tools: Record<string, ToolSpec>,
    profile: HarnessProfile,
    nudge = ''
  ): Promise<ChatStreamResult> {
    const cfg = this.deps.store.settings.harness
    let promptMode = this.promptModeFor(session)
    if (promptMode) this.rememberToolProtocol(session, 'prompt')
    const isChat = session.mode === 'chat'
    const modelKey = `${session.model?.providerId}::${session.model?.modelId}`
    const modelInfo = this.deps.models
      .getModels()
      .find((m) => m.providerId === session.model?.providerId && (m.remoteId === session.model?.modelId || m.id === modelKey))
    let thinkOverride = this.thinkDecision(session, isChat, modelInfo?.supportsThinking === true)
    // 该模型在任务模式下只输出思考不干活时，后续步骤直接关闭 thinking
    if (modelInfo?.supportsThinking && this.noThinkModels.has(modelKey)) thinkOverride = false
    let emptyRetried = false
    const schemas = isChat ? [] : Object.values(tools).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
    const maxRetries = Math.max(0, Math.min(5, cfg.retryCount ?? 1))
    let retries = 0

    for (let attempt = 0; attempt < 3 + maxRetries; attempt++) {
      const basePrompt = await this.buildSystemPrompt(session, promptMode, tools, isChat, profile)
      const system = nudge ? `${basePrompt}\n\n## 纠正指令\n${nudge}` : basePrompt
      const messages: LlmMessage[] = [
        { role: 'system', content: system },
        ...(session.context?.summary ? [{ role: 'system' as const, content: `## 早期对话摘要\n${session.context.summary}` }] : []),
        ...this.toLlmMessages(session, promptMode)
      ]

      const appendDelta = (kind: 'text' | 'reasoning') => (delta: string) => {
        let part = assistant.parts.find((p) => p.type === kind) as { type: 'text' | 'reasoning'; text: string } | undefined
        if (!part) {
          part = { type: kind, text: '' }
          if (kind === 'reasoning') assistant.parts.unshift(part)
          else assistant.parts.push(part)
        }
        part.text += delta
        this.emit(session, assistant.id, kind === 'text' ? 'text-delta' : 'reasoning-delta', delta)
      }

      try {
        const res = await streamChat({
          provider,
          modelId: session.model?.modelId || '',
          messages,
          tools: promptMode || isChat ? [] : schemas,
          temperature: cfg.temperature,
          numCtx: this.effectiveWindow(session),
          numPredict: cfg.maxOutputTokens,
          keepAlive: cfg.keepAliveMin ? `${Math.max(1, cfg.keepAliveMin)}m` : undefined,
          think: thinkOverride,
          // llama.cpp：按请求关掉思考（Qwen3 等模板支持 enable_thinking）
          chatTemplateKwargs:
            provider.kind === 'llamacpp' && thinkOverride !== undefined ? { enable_thinking: thinkOverride } : undefined,
          signal,
          onText: appendDelta('text'),
          onThinking: appendDelta('reasoning')
        })
        // 本地思考模型偶尔只输出思考、不产出正文/工具调用；关闭 thinking 重试一次
        if (!isChat && profile === 'local' && !emptyRetried && !res.text.trim() && !res.toolCalls.length) {
          emptyRetried = true
          const canDisableThinking = modelInfo?.supportsThinking === true && thinkOverride !== false
          assistant.parts = []
          this.deps.emit({ sessionId: session.id, messageId: assistant.id, type: 'reset-message' })
          this.emit(
            session,
            assistant.id,
            'notice',
            canDisableThinking ? '本地模型只输出了思考内容，已关闭思考模式重试…' : '本地模型没有返回内容，正在重试…',
            'warn'
          )
          if (canDisableThinking) {
            thinkOverride = false
            this.noThinkModels.add(modelKey)
          }
          nudge = nudge || '请直接调用工具继续完成任务，不要只输出思考内容或提前停下。'
          continue
        }
        return res
      } catch (err) {
        const canFallback =
          attempt === 0 &&
          !promptMode &&
          cfg.toolMode === 'auto' &&
          err instanceof LlmError &&
          err.code === 'no-tools'
        if (canFallback) {
          this.promptModeModels.add(modelKey)
          this.rememberToolProtocol(session, 'prompt')
          promptMode = true
          assistant.parts = []
          this.deps.emit({ sessionId: session.id, messageId: assistant.id, type: 'reset-message' })
          this.emit(session, assistant.id, 'notice', '当前模型不支持原生工具调用，已自动切换为「文本工具协议」模式。', 'warn')
          continue
        }
        if (err instanceof LlmError && err.code === 'context') {
          const compressed = await this.compress(session, true)
          if (compressed && attempt === 0) {
            this.emit(session, assistant.id, 'notice', '上下文超限，已自动压缩历史后重试。', 'info')
            continue
          }
        }
        if (err instanceof LlmError && err.code === 'connection' && !signal.aborted && retries < maxRetries) {
          retries++
          assistant.parts = []
          this.deps.emit({ sessionId: session.id, messageId: assistant.id, type: 'reset-message' })
          this.emit(session, assistant.id, 'notice', `模型连接中断，正在重试（${retries}/${maxRetries}）…`, 'warn')
          await new Promise((r) => setTimeout(r, 700 * retries))
          continue
        }
        throw err
      }
    }
    throw new LlmError('unknown', '模型调用失败')
  }

  private looksLikeFakeToolNarration(text: string): boolean {
    if (!text) return false
    const mentionsTool =
      /(工具调用|调用工具|tool[\s_-]?call|write_file\s*\(|read_file\s*\(|edit_file\s*\(|shell\s*\(|list_dir\s*\()/i.test(
        text
      )
    const claimsDone =
      /(已(经)?(创建|写入|保存|修改|删除|执行)|成功(创建|写入|保存|执行)|操作结果[:：]|工具结果[:：])/.test(text)
    return mentionsTool && claimsDone
  }

  private maybeParsePromptCalls(session: Session, text: string, profile: HarnessProfile): ToolCall[] {
    const cfg = this.deps.store.settings.harness
    if (!text) return []
    if (session.mode === 'chat') return []
    // API 模型在 native 模式下只认原生工具调用；本地模型即使返回了文字版调用也尝试兜底解析
    if (cfg.toolMode === 'native' && profile !== 'local') return []
    const parsed = extractToolCalls(text)
    return parsed.map((call, index) => ({
      id: `prompt_${randomUUID().slice(0, 8)}_${index}`,
      name: call.tool,
      arguments: call.arguments
    }))
  }

  private toLlmMessages(session: Session, promptMode: boolean): LlmMessage[] {
    const out: LlmMessage[] = []
    const start = session.context?.startIndex ?? 0
    for (const m of session.messages.slice(start)) {
      if (m.streaming) continue
      if (m.role === 'system') {
        const text = textOf(m)
        if (text) out.push({ role: 'system', content: text })
        continue
      }
      if (m.role === 'user') {
        const content = textOf(m)
        const images = imageParts(m)
          .map((p) => imagePartDataUrl(p, this.deps.attachments))
          .filter((v): v is string => !!v)
        if (content || images.length) out.push({ role: 'user', content, images: images.length ? images : undefined })
        continue
      }
      if (m.role === 'assistant') {
        const content = textOf(m)
        const calls = m.parts.filter((p): p is { type: 'tool-call'; call: ToolCall } => p.type === 'tool-call').map((p) => p.call)
        const results = m.parts.filter((p): p is { type: 'tool-result'; result: ToolResult } => p.type === 'tool-result').map((p) => p.result)

        if (promptMode) {
          // 文本协议模式：不能用 OpenAI/Ollama 的 tool 角色，改为普通对话消息，兼容任意小模型
          const callNote = calls.map((c) => `\n[调用工具 ${c.name}，参数：${JSON.stringify(c.arguments)}]`).join('')
          if (content || callNote) out.push({ role: 'assistant', content: content + callNote })
          for (const r of results) {
            out.push({ role: 'user', content: `[工具 ${r.name} 的执行结果${r.ok ? '' : '（失败）'}]\n${r.output}` })
          }
          continue
        }

        if (content || calls.length) {
          out.push({ role: 'assistant', content, toolCalls: calls.length ? calls : undefined })
        }
        for (const r of results) {
          out.push({ role: 'tool', content: r.output, toolCallId: r.callId, toolName: r.name })
        }
      }
    }
    return out
  }

  private async buildSystemPrompt(
    session: Session,
    promptMode: boolean,
    tools: Record<string, ToolSpec>,
    isChat = false,
    profile: HarnessProfile = 'api'
  ): Promise<string> {
    const agent = this.agentById(session.agentId)
    const settings = this.deps.store.settings
    const cfg = settings.harness
    const modeLabel: Record<PermissionMode, string> = {
      readonly: '只读（禁止写文件与执行命令）',
      ask: '询问（有副作用的操作都需要用户确认）',
      'auto-safe': '自动审批（工作区内的安全操作自动放行，高风险操作询问）',
      full: '完全放行（高风险操作自动执行）'
    }
    const toolLines = Object.values(tools)
      .map((t) => `- ${t.name}: ${t.description}`)
      .join('\n')
    const skillText = this.deps.plugins
      .getSkills()
      .map((s) => `### ${s.name}\n${s.prompt}`)
      .join('\n\n')
      .slice(0, 2400)
    const knowledgeText = session.knowledgeBaseIds.length
      ? this.deps.knowledge.buildContext(session.knowledgeBaseIds, lastUserText(session), 5000)
      : ''

    // 对话模式：不注入工作区、工具和技能，系统提示词尽量短
    if (isChat) {
      return [
        '你是「AIH 对话助手」，一个可靠的通用 AI 助手。',
        '直接用中文回答，简洁准确，不要编造事实。',
        '当前处于「对话」模式：不能读写文件、运行命令或调用工具。如果用户需要这些操作，提醒他点击左侧「新任务」。',
        knowledgeText ? `## 知识库上下文（可能相关，按需引用）\n${knowledgeText}` : '',
        cfg.systemSuffix ? `## 额外指令\n${cfg.systemSuffix}` : ''
      ]
        .filter(Boolean)
        .join('\n')
    }

    // 本地模型 harness：提示词更短、规则更具体，重点保证「能正确创建/修改文件」
    if (profile === 'local') {
      return [
        `你是「${agent.name}」，AIH 中的智能体。${agent.systemPrompt}`,
        '',
        '## 运行环境',
        `- 工作区：${session.workspaceDir || '未设置（请先让用户选择工作区）'}`,
        `- 操作系统：${process.platform === 'win32' ? 'Windows' : process.platform}`,
        `- 权限模式：${modeLabel[session.permissionMode]}`,
        '',
        '## 本地模型执行规范（必须严格遵守）',
        '1. 改文件前必须先 read_file 读取原文；不要凭记忆改写。',
        '2. 新建文件用 write_file：path 写相对工作区的路径（例如 src/App.tsx），不要以 / 开头；content 写完整文件内容。',
        '3. 修改已有文件优先用 edit_file：find 必须逐字复制文件中的原文，不要带行号，不要改缩进；replace 写替换后的内容。',
        '4. content 不要包含 ``` 代码围栏，也不要手动把换行写成 \\n 字面量。',
        '5. 每步只调用一个工具，等工具结果返回后再继续；不要重复完全相同的调用。',
        '6. 绝不能捏造工具调用或工具结果；只有真正执行成功后才能声称完成。',
        '7. 相对路径以工作区为根，不要访问工作区之外的文件，除非用户明确要求。',
        '8. 信息不足时用一句话询问用户并停止；信息足够时必须调用工具推进，不要只输出计划。',
        '9. 需要用户选择时，用编号列表给出 2-5 个选项，格式：`1. **选项名** 一句话说明`，一次只问一个问题。',
        '',
        `## 可用工具\n${toolLines}`,
        promptMode ? this.promptToolProtocol(Object.values(tools), profile) : '',
        skillText ? `## 已安装技能\n${skillText.slice(0, 800)}` : '',
        knowledgeText ? `## 知识库上下文（可能相关，按需引用）\n${knowledgeText}` : '',
        cfg.systemSuffix ? `## 额外 Harness 指令\n${cfg.systemSuffix}` : ''
      ]
        .filter(Boolean)
        .join('\n')
    }

    const parts = [
      `你是「${agent.name}」，AIH 中的智能体。`,
      agent.systemPrompt,
      '',
      '## 运行环境',
      `- 工作区：${session.workspaceDir || '未设置（请先让用户选择工作区）'}`,
      `- 操作系统：${process.platform === 'win32' ? 'Windows' : process.platform}`,
      `- 当前时间：${new Date().toLocaleString('zh-CN')}`,
      `- 权限模式：${modeLabel[session.permissionMode]}`,
      `- 模型：${session.model?.label || '未知'}`,
      '',
      '## 工具使用规范',
      '1. 修改任何文件前，必须先 read_file 读取并确认原文；不要凭记忆改写。',
      '2. 修改已有文件优先使用 edit_file，提供足够上下文保证唯一匹配；新建文件才用 write_file。',
      '3. 相对路径以工作区为根。不要访问工作区之外的文件，除非用户明确要求。',
      '4. 工具返回失败时，先分析原因再重试；不要重复提交完全相同的调用。',
      '5. 多个互不依赖的只读查询可以并行发起。',
      '6. 完成任务后用简短中文总结：改了哪些文件、验证了什么、还有什么风险。',
      '7. 绝不能捏造工具调用或工具结果；只有真正调用工具并拿到结果后，才能声称任务完成。不确定时先用工具确认。',
      '',
      `## 可用工具\n${toolLines}`,
      promptMode ? this.promptToolProtocol(Object.values(tools)) : '',
      skillText ? `## 已安装技能\n${skillText}` : '',
      knowledgeText ? `## 知识库上下文（可能相关，按需引用）\n${knowledgeText}` : '',
      cfg.systemSuffix ? `## 额外 Harness 指令\n${cfg.systemSuffix}` : ''
    ]
    return parts.filter(Boolean).join('\n')
  }

  private promptToolProtocol(tools: ToolSpec[], profile: HarnessProfile = 'api'): string {
    const list = tools
      .map((t) => {
        const props = (t.parameters as any)?.properties || {}
        const args = Object.entries(props)
          .map(([k, v]: [string, any]) => `${k}${Array.isArray(v?.enum) ? `(${v.enum.join('|')})` : v?.type === 'boolean' ? '(bool)' : v?.type === 'number' ? '(number)' : v?.type === 'array' ? '(array)' : '(string)'}`)
          .join(', ')
        return `- ${t.name}(${args})：${t.description}`
      })
      .join('\n')
    // 本地小模型：文件内容用标签块直出，避免 JSON 转义导致写文件失败
    if (profile === 'local') {
      return [
        '',
        '## 工具调用协议（文本模式）',
        '需要操作文件时，只输出下面两种格式之一，不要输出多余解释。',
        '创建或覆盖文件（内容原样书写，不需要 JSON 转义）：',
        '<aih_write path="src/App.tsx">',
        '完整文件内容',
        '</aih_write>',
        '修改文件（find 必须是文件中的原文）：',
        '<aih_edit path="src/App.tsx">',
        '<find>要被替换的原文</find>',
        '<replace>替换后的内容</replace>',
        '</aih_edit>',
        '其他工具用 JSON 代码块，例如：',
        '```json',
        '{"tool":"read_file","arguments":{"path":"src/App.tsx"}}',
        '```',
        '可用工具：',
        list
      ].join('\n')
    }
    return [
      '',
      '## 工具调用协议（文本模式）',
      '你不能直接调用函数。需要工具时，在回复中输出且仅输出一个 JSON 代码块，格式必须严格如下：',
      '```json',
      '{"tool":"read_file","arguments":{"path":"src/app.ts"}}',
      '```',
      '每次只调用一个工具，等待工具结果后再决定下一步。不需要工具时用正常中文回答。可用工具：',
      list
    ].join('\n')
  }

  private async prepareContext(session: Session, cfg: HarnessConfig) {
    const ctxCfg = cfg.context
    if (!ctxCfg.compressEnabled) return
    const tokens = estimateMessageTokens(this.activeMessages(session))
    const messagesLen = session.messages.length - (session.context?.startIndex ?? 0)
    const periodicDue =
      ctxCfg.periodic && messagesLen > ctxCfg.keepRecentMessages && messagesLen % Math.max(2, ctxCfg.periodicEveryTurns) === 0
    const overThreshold = tokens > this.effectiveWindow(session) * (ctxCfg.thresholdPct / 100)
    if (overThreshold || periodicDue) await this.compress(session, false)
  }

  private async compress(session: Session, manual: boolean): Promise<boolean> {
    const start = session.context?.startIndex ?? 0
    const all = session.messages
    if (all.length - start <= 4) return false
    const cfg = this.deps.store.settings.harness.context
    const split = Math.max(start, all.length - Math.max(4, cfg.keepRecentMessages))
    const toSummarize = all.slice(start, split)
    if (!toSummarize.length) return false
    const transcript = toSummarize
      .map((m) => {
        const label = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '系统'
        const text = textOf(m).slice(0, 1200)
        const toolInfo = m.parts
          .filter((p): p is { type: 'tool-result'; result: ToolResult } => p.type === 'tool-result')
          .map((p) => `[工具 ${p.result.name}: ${p.result.output.slice(0, 200)}]`)
          .join('\n')
        return `${label}: ${text}${toolInfo ? `\n${toolInfo}` : ''}`
      })
      .join('\n\n')
      .slice(-14000)

    const previous = session.context?.summary || ''
    let summary = ''
    const provider = await this.resolveProvider(session)
    if (provider && session.model && cfg.compressMode === 'summary') {
      try {
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(), 90000)
        const res = await streamChat({
          provider,
          modelId: session.model.modelId,
          messages: [
            { role: 'system', content: '你是上下文压缩器。请用信息密度高的中文要点总结对话，保留：目标、已完成的改动与文件路径、关键结论、未完成事项、用户偏好。不要编造。不超过 350 字。' },
            { role: 'user', content: `${previous ? `【之前的摘要】\n${previous}\n\n` : ''}【待压缩对话】\n${transcript}` }
          ],
          tools: [],
          temperature: 0.2,
          numCtx: Math.min(8192, this.effectiveWindow(session)),
          signal: ac.signal
        })
        clearTimeout(timer)
        summary = res.text.trim()
      } catch {
        summary = ''
      }
    }
    if (!summary) {
      summary = transcript.replace(/\s+/g, ' ').slice(0, 1200)
    }

    const before = estimateMessageTokens(this.activeMessages(session))
    session.context = { summary, startIndex: split, compressedAt: Date.now() }
    const after = estimateMessageTokens(this.activeMessages(session))
    session.tokenUsage.compressed = (session.tokenUsage.compressed || 0) + Math.max(0, before - after)
    session.updatedAt = Date.now()
    this.deps.store.upsertSession(session)
    this.deps.emit({
      sessionId: session.id,
      messageId: '',
      type: 'notice',
      text: `${manual ? '已手动' : '已自动'}压缩上下文：约 ${before} → ${after} tokens（界面历史仍完整保留）`,
      level: 'info'
    })
    return true
  }

  private previewOf(call: ToolCall): string {
    const a = call.arguments || {}
    if (call.name === 'shell') return String(a.command || '')
    if (call.name === 'write_file') {
      const content = String(a.content || '')
      return `路径：${String(a.path || '')}\n${content.slice(0, 500)}${content.length > 500 ? '\n…' : ''}`
    }
    if (call.name === 'edit_file') {
      return `路径：${String(a.path || '')}\n- ${String(a.find || '').slice(0, 220)}\n+ ${String(a.replace || '').slice(0, 220)}`
    }
    if (call.name === 'web_fetch') return String(a.url || '')
    return JSON.stringify(a).slice(0, 500)
  }

  /** 审批指纹：按“工具 + 关键参数”放行，而不是按工具名整体放行（避免一次 always 后任意命令直通） */
  private approvalFingerprint(call: ToolCall): string {
    const args = call.arguments || {}
    if (call.name === 'shell') {
      return `shell:${String(args.command || '').trim().replace(/\s+/g, ' ').toLowerCase()}`
    }
    if (call.name === 'write_file' || call.name === 'edit_file') {
      return `${call.name}:${String(args.path || '').trim().toLowerCase()}`
    }
    if (call.name === 'web_fetch') {
      try {
        const u = new URL(String(args.url || ''))
        return `web_fetch:${u.protocol}//${u.host}`
      } catch {
        return `web_fetch:${String(args.url || '')}`
      }
    }
    return `${call.name}:${JSON.stringify(args)}`
  }

  private async decide(
    session: Session,
    spec: ToolSpec,
    call: ToolCall,
    risk: RiskAssessment,
    preview: string,
    signal: AbortSignal
  ): Promise<boolean> {
    const mode = session.permissionMode
    if (mode === 'readonly' && !spec.readOnly) return false
    const catastrophic = risk.reasons.includes('catastrophic')
    const fingerprint = this.approvalFingerprint(call)
    const always = this.alwaysAllow.get(session.id)?.has(fingerprint)
    if (always && !catastrophic) return true

    let needAsk = false
    if (mode === 'ask') needAsk = risk.level !== 'low'
    else if (mode === 'auto-safe') needAsk = risk.level === 'high'
    else if (mode === 'full') needAsk = catastrophic
    if (!needAsk) return true
    if (signal.aborted) return false

    const req: ApprovalRequest = {
      id: randomUUID(),
      sessionId: session.id,
      call,
      risk,
      preview,
      createdAt: Date.now()
    }
    const prevStatus = session.status
    session.status = 'waiting-approval'
    this.emitStatus(session)
    this.deps.emitApproval(req)
    let decision: ApprovalDecision = 'deny'
    try {
      // 把 AbortSignal 接到审批上：用户点“停止”或关闭窗口时立即 deny，而不是等 5 分钟超时
      decision = await this.deps.requestApproval(req, signal)
    } catch {
      decision = 'deny'
    }
    if (signal.aborted) return false
    session.status = prevStatus === 'waiting-approval' ? 'running' : prevStatus
    this.emitStatus(session)
    if (decision === 'allow-always') {
      if (!this.alwaysAllow.has(session.id)) this.alwaysAllow.set(session.id, new Set())
      this.alwaysAllow.get(session.id)!.add(fingerprint)
      return true
    }
    return decision === 'allow'
  }

  private async executeToolCalls(
    session: Session,
    assistant: ChatMessage,
    calls: ToolCall[],
    tools: Record<string, ToolSpec>,
    ctx: ToolContext,
    signal: AbortSignal,
    profile: HarnessProfile
  ): Promise<void> {
    const ready: { call: ToolCall; spec: ToolSpec; risk: RiskAssessment; allowed: boolean; deniedReason: string }[] = []

    for (const call of calls) {
      const spec = tools[call.name]
      if (!spec) {
        ready.push({ call, spec: placeholderSpec(call.name), risk: { level: 'low', reasons: [] }, allowed: false, deniedReason: `模型调用了不存在的工具「${call.name}」` })
        continue
      }
      // 小模型常把数字/布尔写成字符串：先按 schema 修一次类型，再判断参数是否完整
      call.arguments = coerceToolArgs(spec, call.arguments || {})
      // 参数不完整时直接让模型重试，避免用空参数覆盖文件
      const required = Array.isArray((spec.parameters as any)?.required)
        ? ((spec.parameters as any).required as string[])
        : []
      const missing = required.filter((key) => call.arguments[key] === undefined || call.arguments[key] === null)
      if (missing.length) {
        ready.push({
          call,
          spec,
          risk: { level: 'low', reasons: [] },
          allowed: false,
          deniedReason: `参数不完整（缺少 ${missing.join(', ')}），请重新调用 ${call.name} 并补全参数`
        })
        continue
      }
      let risk: RiskAssessment
      try {
        risk = spec.assess(call.arguments || {}, ctx)
      } catch {
        risk = { level: 'medium', reasons: ['无法评估风险'] }
      }
      const allowed = signal.aborted ? false : await this.decide(session, spec, call, risk, this.previewOf(call), signal)
      ready.push({
        call,
        spec,
        risk,
        allowed,
        deniedReason: !allowed
          ? session.permissionMode === 'readonly' && !spec.readOnly
            ? '当前为只读模式，已阻止写操作/命令执行'
            : '用户拒绝了该操作'
          : ''
      })
    }

    const executeOne = async (item: (typeof ready)[number]): Promise<ToolResult> => {
      const started = Date.now()
      if (!item.allowed) {
        const retryHint = item.deniedReason.startsWith('参数不完整') ? '请补全参数后重新调用。' : '请换一种方式，或请用户调整权限模式后重试。'
        const result: ToolResult = {
          callId: item.call.id,
          name: item.call.name,
          ok: false,
          output: `[未执行] ${item.deniedReason}。${retryHint}`,
          risk: item.risk,
          durationMs: Date.now() - started
        }
        this.appendResult(session, assistant, result, profile)
        return result
      }
      const cfgNow = this.deps.store.settings.harness
      const timeoutMs = Math.max(5, cfgNow.toolTimeoutSec ?? 180) * 1000
      const toolAc = new AbortController()
      const onAbort = () => toolAc.abort()
      signal.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => toolAc.abort(), timeoutMs)
      let raceTimer: NodeJS.Timeout | null = null
      try {
        const exec = item.spec.execute(item.call.arguments || {}, ctx, toolAc.signal)
        exec.catch(() => undefined)
        const timeoutResult = new Promise<{ output: string; isError: boolean }>((resolve) => {
          raceTimer = setTimeout(() => resolve({ output: `工具执行超时（${timeoutMs / 1000}s），已中止`, isError: true }), timeoutMs + 50)
        })
        const res = await Promise.race([exec, timeoutResult])
        if (raceTimer) {
          clearTimeout(raceTimer)
          raceTimer = null
        }
        const result: ToolResult = {
          callId: item.call.id,
          name: item.call.name,
          ok: !res.isError,
          output: res.output,
          risk: item.risk,
          durationMs: Date.now() - started
        }
        this.appendResult(session, assistant, result, profile)
        return result
      } catch (err) {
        const result: ToolResult = {
          callId: item.call.id,
          name: item.call.name,
          ok: false,
          output: `工具执行失败：${err instanceof Error ? err.message : String(err)}`,
          risk: item.risk,
          durationMs: Date.now() - started
        }
        this.appendResult(session, assistant, result, profile)
        return result
      } finally {
        if (raceTimer) clearTimeout(raceTimer)
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
    }

    const cfg = this.deps.store.settings.harness
    const parallel = ready.filter((r) => r.allowed && r.spec.readOnly)
    const sequential = ready.filter((r) => !(r.allowed && r.spec.readOnly))
    // 本地小模型逐个执行更稳定，也便于用户逐条确认
    if (cfg.parallelTools && profile !== 'local' && parallel.length > 1) {
      await Promise.all(parallel.map((r) => executeOne(r)))
    } else {
      for (const r of parallel) await executeOne(r)
    }
    for (const r of sequential) {
      await executeOne(r)
      if (signal.aborted) break
    }
  }

  private appendResult(session: Session, assistant: ChatMessage, result: ToolResult, profile: HarnessProfile) {
    const configured = this.deps.store.settings.harness.maxToolOutputChars ?? 24000
    // 本地模型上下文通常只有 8K，工具输出要更克制，避免一轮就撑爆窗口
    const maxChars = Math.max(2000, profile === 'local' ? Math.min(configured, 8000) : configured)
    if (result.output.length > maxChars) {
      result.output = `${result.output.slice(0, maxChars)}\n…（输出过长已截断，原长度 ${result.output.length} 字符，可在设置中调整上限）`
    }
    assistant.parts.push({ type: 'tool-result', result })
    this.deps.emit({
      sessionId: session.id,
      messageId: assistant.id,
      type: 'tool-result',
      result
    })
    void this.audit(session.id, result)
  }

  private async audit(sessionId: string, result: ToolResult) {
    try {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        sessionId,
        tool: result.name,
        callId: result.callId,
        ok: result.ok,
        risk: result.risk,
        output: result.output.slice(0, 2000)
      })
      await fsp.appendFile(this.deps.store.auditLogPath(sessionId), line + '\n', 'utf8')
    } catch {
      /* 审计失败不影响主流程 */
    }
  }
}

function agentToolNames(agent: AgentPreset): string[] {
  return agent.tools.filter((t) => typeof t === 'string' && t.length > 0)
}

function lastUserText(session: Session): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    if (session.messages[i].role === 'user') return textOf(session.messages[i])
  }
  return ''
}

/** 带动作词的请求需要工具/思考；纯问答短句可以省掉思考，直接秒回 */
const ACTION_WORDS =
  /(创建|新建|写入|保存|修改|编辑|删除|移除|重命名|运行|执行|安装|部署|构建|编译|测试|重构|实现|修复|排查|生成|做一个|写一个|写个|改成|替换|上传|下载|整理|分析|对比|总结|翻译|规划|设计|找出|检查|扫描|打包|发布|提交|推送|合并|回滚)/i

export function isSimpleRequest(text: string, maxChars = 60): boolean {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  if (!clean) return false
  if (clean.length > maxChars) return false
  if (clean.includes('```')) return false
  return !ACTION_WORDS.test(clean)
}

/** 按工具参数 schema 做基础类型修复（字符串数字 → number，字符串布尔 → boolean 等） */
export function coerceToolArgs(spec: ToolSpec, input: Record<string, unknown>): Record<string, unknown> {
  const properties = (spec.parameters as { properties?: Record<string, unknown> })?.properties || {}
  const out: Record<string, unknown> = { ...input }
  for (const [key, rawSchema] of Object.entries(properties)) {
    const value = out[key]
    if (value === undefined || value === null) continue
    const type = (rawSchema as { type?: string })?.type
    if (type === 'number' || type === 'integer') {
      if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
        out[key] = Number(value.trim())
      } else if (typeof value === 'boolean') {
        out[key] = value ? 1 : 0
      }
    } else if (type === 'boolean' && typeof value === 'string') {
      const text = value.trim().toLowerCase()
      if (['true', '1', 'yes', 'on', '是'].includes(text)) out[key] = true
      else if (['false', '0', 'no', 'off', '否'].includes(text)) out[key] = false
    } else if (type === 'string' && (typeof value === 'number' || typeof value === 'boolean')) {
      out[key] = String(value)
    } else if (type === 'array' && !Array.isArray(value) && typeof value === 'string') {
      try {
        const parsed: unknown = JSON.parse(value)
        if (Array.isArray(parsed)) out[key] = parsed
      } catch {
        /* 保持原值，交给参数完整性检查 */
      }
    }
  }
  return out
}

function placeholderSpec(name: string): ToolSpec {
  return {
    name,
    description: '不存在的工具',
    parameters: { type: 'object', properties: {} },
    readOnly: true,
    assess: () => ({ level: 'low', reasons: [] }),
    execute: async () => ({ output: '工具不存在', isError: true })
  }
}

function stripBlockLead(text: string): string {
  if (text.startsWith('\r\n')) return text.slice(2)
  if (text.startsWith('\n')) return text.slice(1)
  return text
}

function parseToolJson(raw: string): { tool: string; arguments: Record<string, unknown> } | null {
  const obj = tryParseJsonObject(raw)
  if (!obj) return null
  const fn = obj.function && typeof obj.function === 'object' ? (obj.function as Record<string, unknown>) : undefined
  const tool = String(obj.tool || obj.name || fn?.name || '')
  if (!tool) return null
  let args = obj.arguments ?? obj.args ?? obj.parameters ?? fn?.arguments ?? {}
  if (typeof args === 'string') args = tryParseJsonObject(args) || {}
  if (!args || typeof args !== 'object') return null
  return { tool, arguments: args as Record<string, unknown> }
}

/** 解析文本里的所有工具调用；小模型经常在一次回复里写出多个 JSON 块 */
export function extractToolCalls(text: string): { tool: string; arguments: Record<string, unknown> }[] {
  const found: { index: number; call: { tool: string; arguments: Record<string, unknown> } }[] = []
  const push = (index: number, call: { tool: string; arguments: Record<string, unknown> } | null) => {
    if (call) found.push({ index, call })
  }

  let m: RegExpExecArray | null
  // 本地模型专用：标签块协议，避免把代码内容塞进 JSON 字符串导致转义失败
  const blockRe =
    /<(aih_write|aih_write_file|write_file|aih_edit|aih_edit_file|edit_file)\s+path=["']([^"']+)["']\s*>([\s\S]*?)<\/(?:aih_write|aih_write_file|write_file|aih_edit|aih_edit_file|edit_file)>/gi
  while ((m = blockRe.exec(text))) {
    const tag = m[1].toLowerCase()
    const path = m[2]
    const inner = m[3]
    if (tag.includes('write')) {
      push(m.index, { tool: 'write_file', arguments: { path, content: stripBlockLead(inner) } })
    } else {
      const find = /<find>([\s\S]*?)<\/find>/i.exec(inner)
      const replace = /<replace>([\s\S]*?)<\/replace>/i.exec(inner)
      if (find) {
        push(m.index, {
          tool: 'edit_file',
          arguments: { path, find: stripBlockLead(find[1]), replace: replace ? stripBlockLead(replace[1]) : '' }
        })
      }
    }
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi
  while ((m = fenced.exec(text))) {
    push(m.index, parseToolJson(m[1]))
  }
  const tagged = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi
  while ((m = tagged.exec(text))) {
    push(m.index, parseToolJson(m[1]))
  }
  if (!found.length && /^\s*[\[{][\s\S]*[\]}]\s*$/.test(text)) {
    push(0, parseToolJson(text))
  }

  // 兼容小模型常见的“自然语言 + 函数式”调用：工具调用: write_file("a.txt", "hello")
  const marked = /(?:工具调用|调用工具|tool[\s_-]?call)\s*[:：]?\s*([a-zA-Z_]\w*)\s*\(([\s\S]*?)\)/i.exec(
    text
  )
  if (marked) {
    const values = parseLooseArgs(marked[2])
    const args = positionalArgs(marked[1], values)
    if (args) push(marked.index ?? 0, { tool: marked[1], arguments: args })
  }

  found.sort((a, b) => a.index - b.index)
  const seen = new Set<string>()
  const out: { tool: string; arguments: Record<string, unknown> }[] = []
  for (const item of found) {
    const key = `${item.call.tool}::${JSON.stringify(item.call.arguments)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item.call)
  }
  return out
}

export function extractToolCall(text: string): { tool: string; arguments: Record<string, unknown> } | null {
  return extractToolCalls(text)[0] || null
}

function parseLooseArgs(input: string): unknown[] {
  const tokens = input.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,\s]+/g) || []
  return tokens.map((raw) => {
    const token = raw.trim()
    if (!token) return ''
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      const body = token.slice(1, -1)
      try {
        return JSON.parse(`"${body.replace(/\\'/g, "'").replace(/"/g, '\\"')}"`) as string
      } catch {
        return body.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      }
    }
    if (token === 'true') return true
    if (token === 'false') return false
    if (token === 'null') return null
    if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token)
    return token
  })
}

function positionalArgs(tool: string, values: unknown[]): Record<string, unknown> | null {
  const positional: Record<string, string[]> = {
    write_file: ['path', 'content'],
    read_file: ['path'],
    edit_file: ['path', 'find', 'replace'],
    list_dir: ['path', 'depth'],
    glob: ['pattern', 'path'],
    grep: ['pattern', 'path'],
    shell: ['command'],
    web_fetch: ['url'],
    web_search: ['query'],
    knowledge_search: ['query']
  }
  const keys = positional[tool]
  if (!keys) return null
  const args: Record<string, unknown> = {}
  for (let i = 0; i < keys.length && i < values.length; i++) {
    if (values[i] !== undefined && values[i] !== '') args[keys[i]] = values[i]
  }
  return Object.keys(args).length ? args : null
}
