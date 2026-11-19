export type ProviderKind = 'ollama' | 'lmstudio' | 'llamacpp' | 'openai' | 'custom'

export type ConnectionState = 'scanning' | 'online' | 'offline' | 'not-installed'

/** A runtime that hosts models (a local daemon or a remote API). */
export interface Provider {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  apiKey?: string
  /** 手动填写的模型名（API 服务不暴露 /models 时也能使用） */
  models?: string[]
  isLocal: boolean
  enabled: boolean
  state: ConnectionState
  version?: string
  binaryPath?: string
  modelsDir?: string
  note?: string
}

export interface ModelInfo {
  /** unique across providers: `${providerId}::${remoteId}` */
  id: string
  remoteId: string
  providerId: string
  providerKind: ProviderKind
  name: string
  family?: string
  parameterSize?: string
  quantization?: string
  sizeBytes?: number
  contextLength?: number
  supportsTools?: boolean
  /** 模型是否支持 thinking 开关（Qwen3 / R1 等） */
  supportsThinking?: boolean
  status: 'ready' | 'downloading' | 'error'
  /** local path of a gguf file when discovered loose on disk */
  filePath?: string
  installedAt?: number
}

export interface ModelRef {
  providerId: string
  modelId: string
  /** display snapshot so the UI never has to resolve it */
  label: string
}

export interface RecommendedModel {
  id: string
  name: string
  publisher: string
  params: string
  sizeBytes: number
  minRamGb: number
  description: string
  tags: string[]
  modes: ('chat' | 'code' | 'reasoning' | 'vision' | 'embedding' | 'video')[]
  ollamaTag?: string
  downloadUrl: string
  mirrorUrl?: string
  /** 运行方式：ollama 可在应用内直接部署；video 模型需要 ComfyUI / Diffusers 等外部运行时 */
  runtime?: 'ollama' | 'comfyui' | 'diffusers' | 'external'
  /** 可直接下载的 GGUF 文件（ModelScope 仓库，无需安装 Ollama） */
  gguf?: {
    repo: string
    file: string
    sizeBytes?: number
  }
  /** 视频/图像模型建议的显存 */
  vramGb?: number
  /** 由本机硬件计算出的适配度 */
  fit?: 'great' | 'ok' | 'heavy'
}

export interface HardwareInfo {
  cpu: string
  totalRamGb: number
  freeRamGb: number
  gpuName?: string
  vramGb?: number
  comfyuiOnline?: boolean
  tier: 'low' | 'mid' | 'high'
}

export interface Project {
  id: string
  name: string
  description?: string
  /** 该项目的所有会话都在这个目录中读写文件 */
  path: string
  color?: string
  createdAt: number
  updatedAt: number
  archived?: boolean
}

export type PermissionMode = 'readonly' | 'ask' | 'auto-safe' | 'full'

export interface RiskAssessment {
  level: 'low' | 'medium' | 'high'
  reasons: string[]
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ToolResult {
  callId: string
  name: string
  ok: boolean
  output: string
  durationMs?: number
  risk?: RiskAssessment
}

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'image'; dataUrl: string; name?: string }
  | { type: 'tool-call'; call: ToolCall; risk?: RiskAssessment }
  | { type: 'tool-result'; result: ToolResult }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string }

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  parts: MessagePart[]
  createdAt: number
  model?: ModelRef
  tokensEstimate?: number
  /** true while the assistant message is still streaming */
  streaming?: boolean
  /** 本轮已暂停，正在等待用户回复（模型向用户提问） */
  awaitingReply?: boolean
}

export type SessionStatus = 'idle' | 'running' | 'waiting-approval' | 'error'

/** chat: 纯对话，不使用工具；task: 让 Agent 在 workspace 中执行任务 */
export type SessionMode = 'chat' | 'task'

export interface Session {
  id: string
  title: string
  projectId: string
  /** 兼容旧数据：缺省视为 task */
  mode?: SessionMode
  agentId: string
  model: ModelRef | null
  permissionMode: PermissionMode
  messages: ChatMessage[]
  workspaceDir: string | null
  pinned?: boolean
  archived?: boolean
  createdAt: number
  updatedAt: number
  status: SessionStatus
  tokenUsage: { input: number; output: number; compressed: number }
  /** 上下文压缩结果：早期消息保留在界面中，但不再发送给模型 */
  context?: { summary: string; startIndex: number; compressedAt: number }
  knowledgeBaseIds: string[]
}

export interface AgentPreset {
  id: string
  name: string
  icon: string
  description: string
  category: 'general' | 'engineering' | 'writing' | 'office' | 'data'
  systemPrompt: string
  tools: string[]
  builtin: boolean
  pluginId?: string
  recommendedModels?: string[]
}

export interface ApprovalRequest {
  id: string
  sessionId: string
  call: ToolCall
  risk: RiskAssessment
  preview?: string
  createdAt: number
}

export interface HarnessConfig {
  maxSteps: number
  temperature: number
  parallelTools: boolean
  loopGuard: number
  /** auto: 先原生工具调用，模型不支持时自动降级为提示词协议；prompt: 强制文本协议（适配自制小模型） */
  toolMode: 'auto' | 'native' | 'prompt'
  /** 连接失败重试次数 */
  retryCount?: number
  /** 单次工具结果最大字符数，超出后截断 */
  maxToolOutputChars?: number
  /** 单个工具执行超时（秒） */
  toolTimeoutSec?: number
  /** 首条消息后自动命名会话 */
  autoTitle?: boolean
  /** 单次回答的最大输出 tokens，避免小模型无限生成拖慢速度 */
  maxOutputTokens?: number
  /** 模型在内存中保持加载的分钟数（Ollama keep_alive） */
  keepAliveMin?: number
  context: {
    window: number
    compressEnabled: boolean
    compressMode: 'summary' | 'truncate'
    thresholdPct: number
    keepRecentMessages: number
    periodic: boolean
    periodicEveryTurns: number
  }
  safety: {
    workspaceOnly: boolean
    backupBeforeWrite: boolean
    shellTimeoutSec: number
    denyPatterns: string[]
    backupRetentionDays?: number
  }
  systemSuffix: string
}

export interface HarnessSnapshot {
  id: string
  label: string
  createdAt: number
  config: HarnessConfig
}

export interface ModelSettings {
  providers: Provider[]
  defaultModel: ModelRef | null
  /** models the user picked during onboarding */
  installedModelIds: string[]
  detectedBinaryPaths: Record<string, string>
  /** AIH 下载模型的保存目录（首次启动时自动选择剩余空间最大的磁盘） */
  modelsDir?: string
  /** 用户手动添加给内置运行时使用的 GGUF 文件路径 */
  runtimeGgufPaths?: string[]
}

export interface AppSettings {
  language: 'zh' | 'en'
  theme: 'light' | 'dark'
  onboardingDone: boolean
  /** 用户已阅读并确认「完全放行」的风险提示 */
  fullAccessAcknowledged?: boolean
  /** 新建会话的默认权限模式 */
  defaultPermissionMode?: PermissionMode
  /** 默认项目目录（留空使用「文档/AIH Workspace」） */
  defaultWorkspaceDir?: string
  /** 可选：插件广场远程目录 JSON 地址；留空则仅使用内置目录 */
  pluginCatalogUrl?: string
  ui?: {
    fontSize?: 'small' | 'normal' | 'large'
    showReasoning?: boolean
    sendOnEnter?: boolean
    showTokenUsage?: boolean
    compactSidebar?: boolean
    /** 自定义 AI 头像（data URL） */
    assistantAvatar?: string
    /** 配色方案 */
    accent?: 'sage' | 'blue' | 'violet' | 'amber' | 'rose' | 'graphite'
  }
  harness: HarnessConfig
  harnessSnapshots: HarnessSnapshot[]
  modelSettings: ModelSettings
  webSearch: { enabled: boolean; endpoint: string }
  lastModel: ModelRef | null
}

export type PluginCategory = 'tools' | 'agents' | 'skills' | 'mcp' | 'ui'

export interface PluginToolSpec {
  name: string
  description: string
  /** JSON schema for the arguments the model must provide */
  parameters?: Record<string, unknown>
  /** declarative HTTP tool — safe, no arbitrary code execution */
  http?: {
    method: 'GET' | 'POST'
    url: string
    headers?: Record<string, string>
    bodyTemplate?: string
    responsePath?: string
  }
}

export interface PluginManifest {
  id: string
  name: string
  version: string
  author: string
  description: string
  category: PluginCategory
  icon: string
  tags: string[]
  installType: 'builtin' | 'declarative' | 'mcp'
  tools?: PluginToolSpec[]
  agents?: Omit<AgentPreset, 'builtin' | 'pluginId'>[]
  skills?: { name: string; description: string; prompt: string }[]
  mcp?: { command: string; args?: string[]; env?: Record<string, string> }
  homepage?: string
  downloads?: number
}

export interface PluginState {
  manifestId: string
  installed: boolean
  enabled: boolean
  installedAt: number
  error?: string
  tools?: string[]
  /** MCP runtime status */
  runtime?: 'stopped' | 'starting' | 'ready' | 'error'
}

export interface KnowledgeHit {
  docId: string
  title: string
  snippet: string
  score: number
}

export interface KnowledgeDoc {
  id: string
  title: string
  source: string
  sizeBytes: number
  chunks: number
  addedAt: number
  tags: string[]
}

export interface KnowledgeBase {
  id: string
  name: string
  description: string
  docs: KnowledgeDoc[]
  updatedAt: number
  recommendedFor?: string[]
  sizeBytes: number
}

export interface CatalogKnowledgeBase extends KnowledgeBase {
  installUrl?: string
  minRamGb?: number
  format: 'jsonl' | 'markdown' | 'text' | 'hf-dataset'
}

export interface ChatStreamEvent {
  sessionId: string
  messageId: string
  type: 'text-delta' | 'reasoning-delta' | 'tool-call' | 'tool-result' | 'message-done' | 'error' | 'status' | 'title' | 'notice' | 'reset-message'
  text?: string
  call?: ToolCall
  result?: ToolResult
  status?: SessionStatus
  title?: string
  level?: 'info' | 'warn' | 'error'
}

export interface ScanEvent {
  type: 'provider' | 'model' | 'done' | 'error'
  provider?: Provider
  model?: ModelInfo
  message?: string
}

export interface DeployEvent {
  modelId: string
  status: 'starting' | 'progress' | 'done' | 'error' | 'cancelled'
  progress?: number
  message?: string
}

export interface AppInfo {
  version: string
  platform: string
  online: boolean
  userDataDir: string
}

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

export interface Bootstrap {
  settings: AppSettings
  sessions: Session[]
  projects: Project[]
  agents: AgentPreset[]
  plugins: PluginManifest[]
  pluginStates: PluginState[]
  knowledgeBases: KnowledgeBase[]
  providers: Provider[]
  models: ModelInfo[]
  hardware: HardwareInfo
  info: AppInfo
}
