﻿﻿import type { AihApi } from '@shared/ipc'
import type {
  AgentPreset,
  AppSettings,
  ApprovalRequest,
  ChatMessage,
  ChatStreamEvent,
  DeployEvent,
  KnowledgeBase,
  ModelInfo,
  PluginManifest,
  PluginState,
  Project,
  Provider,
  ScanEvent,
  Session
} from '@shared/types'
import { BUILTIN_AGENTS, DEFAULT_SETTINGS, RECOMMENDED_MODELS } from '@shared/defaults'

const isOnboarding = new URLSearchParams(location.search).has('onboarding')

const now = Date.now()

const settings: AppSettings = {
  ...structuredClone(DEFAULT_SETTINGS),
  onboardingDone: !isOnboarding,
  language: 'zh',
  theme: 'light'
}

const providers: Provider[] = [
  {
    id: 'ollama',
    name: 'Ollama',
    kind: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    isLocal: true,
    enabled: true,
    state: 'online',
    version: '0.5.4',
    note: '本地推理服务运行中'
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    kind: 'lmstudio',
    baseUrl: 'http://127.0.0.1:1234',
    isLocal: true,
    enabled: true,
    state: 'offline',
    note: '检测到 LM Studio，请启动应用并打开本地服务器（端口 1234）'
  }
]

const models: ModelInfo[] = [
  {
    id: 'ollama::qwen2.5:7b',
    remoteId: 'qwen2.5:7b',
    providerId: 'ollama',
    providerKind: 'ollama',
    name: 'qwen2.5:7b',
    family: 'qwen2',
    parameterSize: '7B',
    quantization: 'Q4_K_M',
    sizeBytes: 4.7e9,
    contextLength: 32768,
    supportsTools: true,
    status: 'ready'
  },
  {
    id: 'ollama::deepseek-r1:8b',
    remoteId: 'deepseek-r1:8b',
    providerId: 'ollama',
    providerKind: 'ollama',
    name: 'deepseek-r1:8b',
    parameterSize: '8B',
    quantization: 'Q4_K_M',
    sizeBytes: 5.2e9,
    contextLength: 32768,
    supportsTools: false,
    status: 'ready'
  },
  {
    id: 'ollama::qwen2.5-coder:7b',
    remoteId: 'qwen2.5-coder:7b',
    providerId: 'ollama',
    providerKind: 'ollama',
    name: 'qwen2.5-coder:7b',
    parameterSize: '7B',
    quantization: 'Q4_K_M',
    sizeBytes: 4.7e9,
    contextLength: 32768,
    supportsTools: true,
    status: 'ready'
  },
  {
    id: 'ollama::qwen2.5vl:7b',
    remoteId: 'qwen2.5vl:7b',
    providerId: 'ollama',
    providerKind: 'ollama',
    name: 'qwen2.5vl:7b',
    parameterSize: '7B',
    quantization: 'Q4_K_M',
    sizeBytes: 6e9,
    contextLength: 32768,
    supportsTools: true,
    status: 'ready'
  }
]

function assistantMessage(): ChatMessage {
  return {
    id: `a-${Math.random().toString(36).slice(2)}`,
    role: 'assistant',
    parts: [],
    createdAt: now,
    model: { providerId: 'ollama', modelId: 'qwen2.5:7b', label: 'qwen2.5:7b' }
  }
}

const demoAssistant: ChatMessage = {
  id: 'demo-assistant',
  role: 'assistant',
  createdAt: now - 60000,
  model: { providerId: 'ollama', modelId: 'qwen2.5:7b', label: 'qwen2.5:7b' },
  parts: [
    {
      type: 'reasoning',
      text: '我先读取项目结构，确认设置页与 Harness 配置的位置，然后再做最小改动。用户希望保留回滚能力，所以需要把快照逻辑接到设置页。'
    },
    {
      type: 'tool-call',
      call: { id: 'call-1', name: 'list_dir', arguments: { path: '.', depth: 2 } }
    },
    {
      type: 'tool-result',
      result: {
        callId: 'call-1',
        name: 'list_dir',
        ok: true,
        output: 'electron/\n  main.ts\n  services/\nsrc/\n  renderer/\n    App.tsx\n    styles.css\npackage.json',
        durationMs: 84,
        risk: { level: 'low', reasons: [] }
      }
    },
    {
      type: 'text',
      text: `## 设置页改造方案

已经定位到 [SettingsPage.tsx](file:///d:/做的游戏/插件/src/renderer/pages/SettingsPage.tsx) 与 Harness 配置。

1. **上下文窗口**：按模型能力设置 \`num_ctx\`，超过阈值自动压缩。
2. **工具协议**：小模型自动降级为文本 JSON 协议。
3. **安全兜底**：工作区限制 + 写前备份 + 命令白名单。

\`\`\`ts
const config = {
  maxSteps: 40,
  toolMode: 'auto',
  context: { window: 32768, compressEnabled: true }
}
\`\`\`

> 所有修改都会保存在本地，并生成可回滚的快照。

需要我继续实现自动压缩吗？`
    }
  ]
}

const demoAssistant2: ChatMessage = {
  id: 'demo-assistant-2',
  role: 'assistant',
  createdAt: now - 30000,
  model: { providerId: 'ollama', modelId: 'qwen2.5:7b', label: 'qwen2.5:7b' },
  parts: [
    {
      type: 'text',
      text: '本周共完成 **14 个提交**，重点推进了本地模型扫描与 Harness 权限层。\n\n| 模块 | 进度 | 风险 |\n| --- | --- | --- |\n| 模型扫描 | 已完成 | 磁盘扫描耗时 |\n| 插件广场 | 已完成 | MCP 依赖网络 |\n| 知识库 | 进行中 | 大文件切分 |\n\n下一步：补齐上下文压缩的回归测试。'
    }
  ]
}

const demoSession: Session = {
  id: 'demo-session',
  title: '重构设置页并补齐回滚存档',
  projectId: 'default',
  mode: 'task',
  agentId: 'frontend-engineer',
  model: { providerId: 'ollama', modelId: 'qwen2.5:7b', label: 'qwen2.5:7b' },
  permissionMode: 'ask',
  workspaceDir: 'D:\\做的游戏\\插件',
  createdAt: now - 3600000,
  updatedAt: now - 60000,
  status: 'idle',
  tokenUsage: { input: 4200, output: 880, compressed: 0 },
  knowledgeBaseIds: ['kb-demo'],
  messages: [
    {
      id: 'demo-user',
      role: 'user',
      createdAt: now - 120000,
      parts: [{ type: 'text', text: '帮我重构设置页，加上 Harness 上下文配置和存档回滚，参考 DeepSeek Harness 的思路。' }]
    },
    demoAssistant
  ]
}

const demoSession2: Session = {
  id: 'demo-session-2',
  title: '生成本周产品周报',
  projectId: 'default',
  mode: 'task',
  agentId: 'writer',
  model: { providerId: 'ollama', modelId: 'qwen2.5:7b', label: 'qwen2.5:7b' },
  permissionMode: 'auto-safe',
  workspaceDir: 'D:\\做的游戏\\插件',
  createdAt: now - 86400000,
  updatedAt: now - 30000,
  status: 'idle',
  tokenUsage: { input: 1200, output: 400, compressed: 0 },
  knowledgeBaseIds: [],
  messages: [
    {
      id: 'demo-user-2',
      role: 'user',
      createdAt: now - 60000,
      parts: [{ type: 'text', text: '根据这周的提交记录，写一份给老板看的周报，突出风险和下一步。' }]
    },
    demoAssistant2
  ]
}

let sessions: Session[] = [demoSession, demoSession2]

const projects: Project[] = [
  {
    id: 'default',
    name: '默认项目',
    description: '未创建项目时，会话都在这里运行',
    path: 'D:\\做的游戏\\插件',
    createdAt: now - 86400000 * 3,
    updatedAt: now
  }
]

const agents: AgentPreset[] = BUILTIN_AGENTS

const plugins: PluginManifest[] = [
  {
    id: 'weather',
    name: '天气查询',
    version: '1.2.0',
    author: 'AIH Lab',
    description: '无需密钥的全球天气查询，支持当前天气与三日预报。',
    category: 'tools',
    icon: '🌤️',
    tags: ['生活', 'HTTP', '免密钥'],
    installType: 'declarative',
    downloads: 12800,
    tools: [
      {
        name: 'weather',
        description: '查询城市天气',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        http: { method: 'GET', url: 'https://wttr.in/{{city}}?format=j1' }
      }
    ]
  },
  {
    id: 'github',
    name: 'GitHub 搜索',
    version: '2.0.1',
    author: 'Open Tools',
    description: '搜索仓库、查看星标与语言分布，帮助 Agent 找到参考实现。',
    category: 'tools',
    icon: '🐙',
    tags: ['开发', '搜索', 'HTTP'],
    installType: 'declarative',
    downloads: 9600,
    tools: [
      {
        name: 'github_search',
        description: '搜索 GitHub 仓库',
        parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
        http: { method: 'GET', url: 'https://api.github.com/search/repositories?q={{q}}&per_page=5' }
      }
    ]
  },
  {
    id: 'writer-studio',
    name: '写作工作室',
    version: '1.4.0',
    author: 'AIH Community',
    description: '提供文案、编辑、审校三位一体的写作角色与工作流。',
    category: 'agents',
    icon: '✍️',
    tags: ['写作', '角色'],
    installType: 'builtin',
    downloads: 21400,
    agents: [
      {
        id: 'copywriter',
        name: '文案专家',
        icon: '🪶',
        description: '负责长文与营销文案撰写',
        category: 'writing',
        systemPrompt: '你是一名中文文案专家，写作具体、有画面感。',
        tools: ['read_file', 'write_file', 'web_search']
      }
    ]
  },
  {
    id: 'deep-research',
    name: '深度研究',
    version: '0.9.3',
    author: 'AIH Lab',
    description: '把一个模糊问题拆成检索计划，输出带来源的研究报告。',
    category: 'skills',
    icon: '🔬',
    tags: ['研究', '技能'],
    installType: 'builtin',
    downloads: 18200,
    skills: [{ name: '深度研究', description: '多源检索与交叉验证', prompt: '先拆解问题，再检索，最后输出带来源的报告。' }]
  },
  {
    id: 'mcp-filesystem',
    name: '文件系统 MCP',
    version: '2024.11',
    author: 'Model Context Protocol',
    description: '通过 MCP 协议访问指定目录，提供读写、移动与搜索能力。',
    category: 'mcp',
    icon: '📁',
    tags: ['MCP', '文件', '需要网络'],
    installType: 'mcp',
    downloads: 7400,
    mcp: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] }
  },
  {
    id: 'mcp-sqlite',
    name: 'SQLite MCP',
    version: '2024.10',
    author: 'Model Context Protocol',
    description: '连接本地 SQLite 数据库，执行查询与结构分析。',
    category: 'mcp',
    icon: '🗄️',
    tags: ['MCP', '数据库'],
    installType: 'mcp',
    downloads: 5200,
    mcp: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sqlite'] }
  }
]

const pluginStates: PluginState[] = [
  { manifestId: 'weather', installed: true, enabled: true, installedAt: now - 86400000, runtime: 'ready', tools: ['weather'] },
  { manifestId: 'writer-studio', installed: true, enabled: false, installedAt: now - 172800000 },
  { manifestId: 'mcp-filesystem', installed: true, enabled: false, installedAt: now - 50000000, runtime: 'error', error: '需要网络与 Node.js 20+（确保 npx 可用）' }
]

const knowledge: KnowledgeBase[] = [
  {
    id: 'kb-demo',
    name: '产品需求文档',
    description: 'AIH 的产品规划、交互规范与验收标准',
    docs: [
      { id: 'd1', title: 'AIH 产品策划案.md', source: 'D:\\docs\\aih.md', sizeBytes: 18234, chunks: 24, addedAt: now - 200000, tags: [] },
      { id: 'd2', title: '交互规范.md', source: 'D:\\docs\\ux.md', sizeBytes: 9234, chunks: 12, addedAt: now - 100000, tags: [] }
    ],
    updatedAt: now - 100000,
    sizeBytes: 27468,
    recommendedFor: ['qwen2.5:7b']
  }
]

const chatListeners = new Set<(e: ChatStreamEvent) => void>()
const scanListeners = new Set<(e: ScanEvent) => void>()
const deployListeners = new Set<(e: DeployEvent) => void>()

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

const DEMO_REPLY = `好的，我先看了一下工作区。

### 我的计划

1. 读取相关文件，确认现有结构
2. 做最小改动，保持接口兼容
3. 运行构建与自测

\`\`\`ts
// 示例：让本地小模型也能稳定调用工具
const mode = model.supportsTools ? 'native' : 'prompt'
\`\`\`

需要我直接开始修改，还是先给你一份 diff 预览？`

const mockApi: AihApi = {
  async bootstrap() {
    return {
      settings: clone(settings),
      sessions: clone(sessions),
      projects: clone(projects),
      agents,
      plugins,
      pluginStates,
      knowledgeBases: knowledge,
      providers,
      models,
      hardware: {
        cpu: 'Intel Core i7-13700H',
        totalRamGb: 16,
        freeRamGb: 7.2,
        gpuName: 'NVIDIA GeForce RTX 4060 Laptop GPU',
        vramGb: 8,
        comfyuiOnline: false,
        tier: 'mid'
      },
      info: {
        version: '0.1.0',
        platform: 'win32',
        online: true,
        userDataDir: 'C:\\Users\\ASUS\\AppData\\Roaming\\aih'
      }
    }
  },
  async info() {
    return { version: '0.1.0', platform: 'win32', online: true, userDataDir: 'C:\\Users\\ASUS\\AppData\\Roaming\\aih' }
  },
  async checkUpdate() {
    return {
      ok: true,
      data: {
        current: '0.1.2',
        latest: '0.1.2',
        hasUpdate: false,
        url: 'https://github.com/CBXH-use/AIH/releases'
      }
    }
  },
  async openDataDir() {},
  async updateSettings(patch) {
    Object.assign(settings, patch)
    return clone(settings)
  },
  async saveHarnessSnapshot(label) {
    settings.harnessSnapshots = [
      { id: `snap-${Date.now()}`, label, createdAt: Date.now(), config: clone(settings.harness) },
      ...settings.harnessSnapshots
    ]
    return clone(settings.harnessSnapshots)
  },
  async restoreHarnessSnapshot(id) {
    const snap = settings.harnessSnapshots.find((s) => s.id === id)
    if (snap) settings.harness = clone(snap.config)
    return clone(settings.harness)
  },
  async getHarnessSnapshots() {
    return clone(settings.harnessSnapshots)
  },
  async scanModels() {
    for (const p of providers) scanListeners.forEach((cb) => cb({ type: 'provider', provider: p }))
    await delay(600)
    for (const m of models) scanListeners.forEach((cb) => cb({ type: 'model', model: m }))
    scanListeners.forEach((cb) => cb({ type: 'done' }))
    return { ok: true, data: models }
  },
  async cancelScan() {},
  async deployModel(id) {
    for (let i = 0; i <= 100; i += 12) {
      deployListeners.forEach((cb) => cb({ modelId: id, status: 'progress', progress: i, message: 'pulling manifest' }))
      await delay(160)
    }
    deployListeners.forEach((cb) => cb({ modelId: id, status: 'done', progress: 100 }))
    return { ok: true }
  },
  async importGguf() {
    return { ok: true }
  },
  async cancelDeploy() {},
  async removeModel() {
    return { ok: true }
  },
  async recommendedModels() {
    return RECOMMENDED_MODELS.map((m) => {
      const vramOk = !m.vramGb || 8 >= m.vramGb
      const ramOk = 16 >= m.minRamGb
      const fit: 'great' | 'ok' | 'heavy' = !ramOk || !vramOk ? 'heavy' : 16 >= m.minRamGb + 8 && (!m.vramGb || 8 >= m.vramGb + 4) ? 'great' : 'ok'
      return { ...m, fit }
    })
  },
  async saveProvider() {
    return { ok: true }
  },
  async warmupModel() {
    return undefined
  },
  async removeProvider() {
    return { ok: true }
  },
  async testProvider() {
    return { ok: true, data: { state: 'online', models: 4 } }
  },
  async startProvider() {
    return { ok: true, data: providers[0] }
  },
  async listSessions() {
    return clone(sessions)
  },
  async createSession(input) {
    const project = projects.find((p) => p.id === (input.projectId || 'default')) || projects[0]
    const s: Session = {
      id: `s-${Date.now()}`,
      title: input.title || '新对话',
      projectId: project.id,
      mode: input.mode || 'task',
      agentId: input.agentId || 'general',
      model: input.model || { providerId: 'ollama', modelId: 'qwen2.5:7b', label: 'qwen2.5:7b' },
      permissionMode: input.permissionMode || 'ask',
      workspaceDir: project.path,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'idle',
      tokenUsage: { input: 0, output: 0, compressed: 0 },
      knowledgeBaseIds: [],
      messages: []
    }
    sessions = [s, ...sessions]
    return clone(s)
  },
  async updateSession(id, patch) {
    const s = sessions.find((x) => x.id === id)
    if (!s) throw new Error('not found')
    Object.assign(s, patch, { updatedAt: Date.now() })
    return clone(s)
  },
  async setSessionWorkspace(id) {
    return this.updateSession(id, { workspaceDir: 'D:\\做的游戏\\插件' })
  },
  async setSessionArchived(id, archived) {
    return this.updateSession(id, { archived })
  },
  async listProjects() {
    return clone(projects)
  },
  async createProject(input) {
    const path = input.path || `D:\\做的游戏\\插件\\${input.name}`
    const project: Project = {
      id: `p-${Date.now()}`,
      name: input.name,
      description: input.description,
      path,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    projects.push(project)
    return { ok: true, data: clone(project) }
  },
  async updateProject(id, patch) {
    const project = projects.find((p) => p.id === id)
    if (!project) return { ok: false, error: 'not found' }
    Object.assign(project, patch, { updatedAt: Date.now() })
    sessions = sessions.map((s) => (s.projectId === id && patch.path ? { ...s, workspaceDir: patch.path } : s))
    return { ok: true, data: clone(project) }
  },
  async archiveProject(id, archived) {
    const project = projects.find((p) => p.id === id)
    if (!project) return { ok: false, error: 'not found' }
    project.archived = archived
    return { ok: true, data: clone(project) }
  },
  async openProjectFolder() {},
  async windowMinimize() {},
  async windowToggleMaximize() {},
  async windowClose() {},
  async isWindowMaximized() {
    return false
  },
  onWindowMaximized() {
    return () => undefined
  },
  async deleteSession(id) {
    sessions = sessions.filter((s) => s.id !== id)
  },
  async sendChat({ sessionId, text, images }) {
    const session = sessions.find((s) => s.id === sessionId)
    if (!session) return { ok: false, error: 'not found' }
    session.messages.push({
      id: `u-${Date.now()}`,
      role: 'user',
      parts: [
        ...(text ? [{ type: 'text' as const, text }] : []),
        ...(images || []).map((i) => ({ type: 'image' as const, dataUrl: i.dataUrl, name: i.name }))
      ],
      createdAt: Date.now()
    })
    const msg = assistantMessage()
    session.messages.push(msg)
    session.status = 'running'
    const emit = (e: ChatStreamEvent) => chatListeners.forEach((cb) => cb(e))
    const chunks = DEMO_REPLY.match(/[\s\S]{1,14}/g) || []
    let i = 0
    const timer = setInterval(() => {
      if (i >= chunks.length) {
        clearInterval(timer)
        msg.streaming = false
        session.status = 'idle'
        emit({ sessionId, messageId: msg.id, type: 'status', status: 'idle' })
        emit({ sessionId, messageId: msg.id, type: 'message-done' })
        return
      }
      const delta = chunks[i++]
      msg.parts.push({ type: 'text', text: delta })
      emit({ sessionId, messageId: msg.id, type: 'text-delta', text: delta })
    }, 40)
    return { ok: true }
  },
  async stopChat() {},
  async approve() {},
  async regenerate() {
    return { ok: true }
  },
  async compressContext() {
    return { ok: true, data: { before: 6200, after: 1800 } }
  },
  async listAgents() {
    return agents
  },
  async saveAgent(agent) {
    agents.push({ ...agent, id: `custom-${Date.now()}` })
    return agents
  },
  async deleteAgent(id) {
    return agents.filter((a) => a.id !== id)
  },
  async listPlugins() {
    return { plugins, states: pluginStates }
  },
  async refreshPlugins() {
    await delay(500)
    return { plugins, states: pluginStates, remote: false }
  },
  async installPlugin(id) {
    const state: PluginState = { manifestId: id, installed: true, enabled: true, installedAt: Date.now(), runtime: 'ready' }
    pluginStates.push(state)
    return { ok: true, data: state }
  },
  async uninstallPlugin(id) {
    const idx = pluginStates.findIndex((p) => p.manifestId === id)
    if (idx >= 0) pluginStates.splice(idx, 1)
    return { ok: true }
  },
  async togglePlugin(id, enabled) {
    const state = pluginStates.find((p) => p.manifestId === id)
    if (state) state.enabled = enabled
    return { ok: true, data: state }
  },
  async listKnowledge() {
    return clone(knowledge)
  },
  async createKnowledge(name, description) {
    const kb: KnowledgeBase = {
      id: `kb-${Date.now()}`,
      name,
      description,
      docs: [],
      updatedAt: Date.now(),
      sizeBytes: 0
    }
    knowledge.push(kb)
    return kb
  },
  async importKnowledge() {
    return { ok: true, data: knowledge[0] }
  },
  async deleteKnowledge() {},
  async searchKnowledge() {
    return []
  },
  async knowledgeCatalog() {
    return { bases: [], online: true }
  },
  async installCatalogKnowledge() {
    return { ok: true }
  },
  async exportTrainingData() {
    return { ok: true, data: { path: 'C:\\Users\\ASUS\\AppData\\Roaming\\aih\\knowledge-exports\\demo.jsonl', samples: 128 } }
  },
  async webSearch() {
    return []
  },
  async pickFolder() {
    return 'D:\\做的游戏\\插件'
  },
  async pickFiles() {
    return []
  },
  async openPath() {},
  async openExternal(url) {
    window.open(url, '_blank')
  },
  async workspaceTree() {
    return []
  },
  onChatEvent(cb) {
    chatListeners.add(cb)
    return () => chatListeners.delete(cb)
  },
  onScanEvent(cb) {
    scanListeners.add(cb)
    return () => scanListeners.delete(cb)
  },
  onDeployEvent(cb) {
    deployListeners.add(cb)
    return () => deployListeners.delete(cb)
  },
  onApproval(_cb: (req: ApprovalRequest) => void) {
    return () => undefined
  },
  onSettings() {
    return () => undefined
  }
}

export { mockApi }
