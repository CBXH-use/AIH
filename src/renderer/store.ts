import { create } from 'zustand'
import type {
  AgentPreset,
  AppInfo,
  AppSettings,
  ApprovalRequest,
  ChatMessage,
  ChatStreamEvent,
  DeployEvent,
  HardwareInfo,
  KnowledgeBase,
  KnowledgeHit,
  ModelInfo,
  ModelRef,
  PluginManifest,
  PluginState,
  Project,
  Provider,
  ScanEvent,
  Session,
  SessionMode
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { translate } from './i18n'

export type Page = 'chat' | 'task' | 'plugins' | 'models' | 'knowledge' | 'agents' | 'settings'

export interface ToastItem {
  id: string
  level: 'info' | 'success' | 'warn' | 'error'
  text: string
}

export type ApprovalChoice = 'allow' | 'allow-always' | 'deny'

interface AppState {
  ready: boolean
  settings: AppSettings
  sessions: Session[]
  projects: Project[]
  activeProjectId: string
  showArchived: boolean
  hardware: HardwareInfo | null
  currentId: string | null
  agents: AgentPreset[]
  plugins: PluginManifest[]
  pluginStates: PluginState[]
  knowledge: KnowledgeBase[]
  providers: Provider[]
  models: ModelInfo[]
  info: AppInfo | null
  page: Page
  scanning: boolean
  scanningStartedAt: number | null
  deploy: Record<string, DeployEvent>
  approvals: ApprovalRequest[]
  initError: string | null
  toasts: ToastItem[]
  pluginRefreshing: boolean

  init(): Promise<void>
  addApproval(req: ApprovalRequest): void
  refreshSessions(): Promise<void>
  refreshAgents(): Promise<void>
  refreshKnowledge(): Promise<void>
  refreshPlugins(): Promise<void>
  setPage(page: Page): void
  selectSession(id: string): void
  selectProject(id: string): void
  setShowArchived(show: boolean): void
  newSession(opts?: { mode?: SessionMode; agentId?: string; projectId?: string; page?: Page }): Promise<Session | null>
  deleteSession(id: string): Promise<void>
  archiveSession(id: string, archived: boolean): Promise<void>
  createProject(input: { name: string; path?: string; description?: string }): Promise<Project | null>
  updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'description' | 'path'>>): Promise<boolean>
  archiveProject(id: string, archived: boolean): Promise<void>
  openProjectFolder(id: string): Promise<void>
  patchSession(id: string, patch: Partial<Session>): Promise<void>
  setPermission(mode: Session['permissionMode']): Promise<void>
  setWorkspace(): Promise<void>
  attachKnowledge(ids: string[]): Promise<void>
  send(text: string, images?: { dataUrl: string; name?: string }[]): Promise<boolean>
  stop(): Promise<void>
  approve(requestId: string, decision: ApprovalChoice): Promise<void>
  regenerate(messageId: string): Promise<void>
  compress(): Promise<void>

  updateSettings(patch: Partial<AppSettings>): Promise<void>
  saveSnapshot(label: string): Promise<void>
  restoreSnapshot(id: string): Promise<void>

  scanModels(opts?: { quick?: boolean; includeLooseGguf?: boolean }): Promise<void>
  cancelScan(): Promise<void>
  deployModel(id: string): Promise<void>
  cancelDeploy(id: string): Promise<void>
  removeModel(id: string): Promise<void>
  startProvider(id: string): Promise<void>
  testProvider(id: string): Promise<void>
  saveProvider(input: {
    id?: string
    name: string
    kind: Provider['kind']
    baseUrl: string
    apiKey?: string
    models?: string[]
  }): Promise<boolean>
  removeProvider(id: string): Promise<void>

  installPlugin(id: string): Promise<void>
  uninstallPlugin(id: string): Promise<void>
  togglePlugin(id: string, enabled: boolean): Promise<void>
  refreshPluginCatalog(): Promise<void>

  saveAgent(agent: AgentPreset): Promise<void>
  deleteAgent(id: string): Promise<void>

  createKnowledge(name: string, description: string): Promise<KnowledgeBase | null>
  importKnowledge(id: string): Promise<void>
  deleteKnowledge(id: string): Promise<void>
  searchKnowledge(id: string, query: string): Promise<KnowledgeHit[]>
  installCatalogKnowledge(id: string): Promise<void>
  exportTraining(id: string): Promise<void>

  handleChatEvent(e: ChatStreamEvent): void
  handleScanEvent(e: ScanEvent): void
  handleDeployEvent(e: DeployEvent): void
  toast(text: string, level?: ToastItem['level']): void
  dismissToast(id: string): void
}

const toastTimers = new Map<string, ReturnType<typeof setTimeout>>()
let refreshTimer: ReturnType<typeof setTimeout> | null = null

function uid(): string {
  return Math.random().toString(36).slice(2, 10)
}

function modeOf(session: Session): SessionMode {
  return session.mode === 'chat' ? 'chat' : 'task'
}

export const useAppStore = create<AppState>((set, get) => {
  const msg = (zh: string, en: string) => (get().settings.language === 'en' ? en : zh)

  const scheduleRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      void get().refreshSessions()
    }, 350)
  }

  const mapSession = (id: string, fn: (s: Session) => Session) => {
    set((state) => ({ sessions: state.sessions.map((s) => (s.id === id ? fn(s) : s)) }))
  }

  const currentSession = (): Session | null => {
    const { sessions, currentId } = get()
    return sessions.find((s) => s.id === currentId) || null
  }

  const ensureAssistant = (session: Session, messageId: string): ChatMessage => {
    const existing = session.messages.find((m) => m.id === messageId)
    if (existing) return existing
    const msg: ChatMessage = {
      id: messageId || `sys-${uid()}`,
      role: messageId ? 'assistant' : 'system',
      parts: [],
      createdAt: Date.now(),
      model: session.model || undefined,
      streaming: !!messageId
    }
    session.messages.push(msg)
    return msg
  }

  const mutateMessage = (sessionId: string, messageId: string, fn: (msg: ChatMessage, session: Session) => void) => {
    mapSession(sessionId, (s) => {
      if (!messageId) return { ...s, updatedAt: Date.now() }
      const session: Session = { ...s, messages: [...s.messages], updatedAt: Date.now() }
      const existingIndex = session.messages.findIndex((m) => m.id === messageId)
      let msg: ChatMessage
      if (existingIndex >= 0) {
        msg = { ...session.messages[existingIndex], parts: [...session.messages[existingIndex].parts] }
        session.messages[existingIndex] = msg
      } else {
        msg = ensureAssistant(session, messageId)
      }
      fn(msg, session)
      return session
    })
  }

  // 流式文本每 40ms 合并一次，避免每个 token 都触发整页重渲染
  const pendingDeltas = new Map<string, { sessionId: string; messageId: string; text: string; reasoning: string }>()
  let deltaTimer: ReturnType<typeof setTimeout> | null = null

  const flushDeltas = () => {
    if (deltaTimer) {
      clearTimeout(deltaTimer)
      deltaTimer = null
    }
    if (!pendingDeltas.size) return
    const items = [...pendingDeltas.values()]
    pendingDeltas.clear()
    for (const item of items) {
      mutateMessage(item.sessionId, item.messageId, (msg) => {
        if (item.reasoning) {
          const part = msg.parts.find((p) => p.type === 'reasoning') as { type: 'reasoning'; text: string } | undefined
          if (part) part.text += item.reasoning
          else msg.parts.unshift({ type: 'reasoning', text: item.reasoning })
        }
        if (item.text) {
          const part = msg.parts.find((p) => p.type === 'text') as { type: 'text'; text: string } | undefined
          if (part) part.text += item.text
          else msg.parts.push({ type: 'text', text: item.text })
        }
        msg.streaming = true
      })
    }
  }

  const queueDelta = (
    sessionId: string,
    messageId: string,
    kind: 'text' | 'reasoning',
    text: string
  ) => {
    if (!text) return
    const key = `${sessionId}::${messageId}`
    const cur = pendingDeltas.get(key) || { sessionId, messageId, text: '', reasoning: '' }
    if (kind === 'text') cur.text += text
    else cur.reasoning += text
    pendingDeltas.set(key, cur)
    if (!deltaTimer) deltaTimer = setTimeout(flushDeltas, 40)
  }

  return {
    ready: false,
    settings: DEFAULT_SETTINGS,
    sessions: [],
    projects: [],
    activeProjectId: 'default',
    showArchived: false,
    hardware: null,
    currentId: null,
    agents: [],
    plugins: [],
    pluginStates: [],
    knowledge: [],
    providers: [],
    models: [],
    info: null,
    page: 'task',
    scanning: false,
    scanningStartedAt: null,
    deploy: {},
    approvals: [],
    initError: null,
    toasts: [],
    pluginRefreshing: false,

    async init() {
      try {
        const boot = await window.aih.bootstrap()
        const sorted = boot.sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt)
        const firstVisible = sorted.find((s) => !s.archived)
        const activeProject =
          (firstVisible && boot.projects.find((p) => p.id === firstVisible.projectId && !p.archived)?.id) ||
          boot.projects.find((p) => !p.archived)?.id ||
          'default'
        set({
          ready: true,
          initError: null,
          settings: boot.settings,
          sessions: sorted,
          projects: boot.projects,
          activeProjectId: activeProject,
          hardware: boot.hardware,
          currentId: firstVisible?.id || null,
          page: firstVisible && firstVisible.mode === 'chat' ? 'chat' : 'task',
          agents: boot.agents,
          plugins: boot.plugins,
          pluginStates: boot.pluginStates,
          knowledge: boot.knowledgeBases,
          providers: boot.providers,
          models: boot.models,
          info: boot.info
        })
      } catch (err) {
        // 启动失败时给出可重试的错误页，而不是永久卡在 Splash
        set({ ready: false, initError: err instanceof Error ? err.message : String(err) })
      }
    },

    addApproval(req) {
      set((state) => ({ approvals: [...state.approvals.filter((a) => a.id !== req.id), req] }))
      const { currentId, sessions } = get()
      if (req.sessionId !== currentId) {
        const title = sessions.find((s) => s.id === req.sessionId)?.title || ''
        get().toast(msg(`「${title}」有新的操作等待确认`, `"${title}" is waiting for approval`), 'warn')
      }
    },

    async refreshSessions() {
      const sessions = await window.aih.listSessions()
      sessions.sort((a, b) => b.updatedAt - a.updatedAt)
      set((state) => {
        const wantMode: SessionMode = state.page === 'chat' ? 'chat' : 'task'
        const fallback =
          sessions.find((s) => !s.archived && modeOf(s) === wantMode) || sessions.find((s) => !s.archived)
        const current = state.currentId ? sessions.find((s) => s.id === state.currentId) : undefined
        const keepCurrent =
          !!current && (state.page !== 'chat' && state.page !== 'task' ? true : modeOf(current) === wantMode)
        return {
          sessions,
          currentId: keepCurrent && current ? current.id : fallback?.id ?? null
        }
      })
    },

    async refreshAgents() {
      set({ agents: await window.aih.listAgents() })
    },

    async refreshKnowledge() {
      set({ knowledge: await window.aih.listKnowledge() })
    },

    async refreshPlugins() {
      const res = await window.aih.listPlugins()
      set({ plugins: res.plugins, pluginStates: res.states })
    },

    setPage(page) {
      set({ page })
    },

    selectSession(id) {
      const session = get().sessions.find((s) => s.id === id)
      set({
        currentId: id,
        page: modeOf(session || ({ mode: 'task' } as Session)),
        ...(session?.projectId ? { activeProjectId: session.projectId } : {})
      })
    },

    selectProject(id) {
      const state = get()
      const wantMode: SessionMode = state.page === 'chat' ? 'chat' : 'task'
      const session =
        state.sessions.find((s) => s.projectId === id && !s.archived && modeOf(s) === wantMode) ||
        state.sessions.find((s) => s.projectId === id && !s.archived)
      set({ activeProjectId: id, currentId: session?.id || null, page: session ? modeOf(session) : wantMode, showArchived: false })
    },

    setShowArchived(show) {
      set({ showArchived: show })
    },

    async newSession(opts) {
      const state = get()
      const cur = currentSession()
      const projectId = opts?.projectId || state.activeProjectId
      const mode: SessionMode = opts?.mode || (opts?.page === 'chat' ? 'chat' : 'task')
      const session = await window.aih.createSession({
        projectId,
        mode,
        agentId: opts?.agentId || cur?.agentId || 'general',
        model: cur?.model || state.settings.lastModel || null,
        permissionMode: state.settings.defaultPermissionMode || 'ask'
      })
      set((s) => ({
        sessions: [session, ...s.sessions],
        currentId: session.id,
        activeProjectId: projectId,
        showArchived: false,
        page: mode
      }))
      if (session.model) void window.aih.warmupModel(session.model)
      get().toast(
        mode === 'chat' ? msg('已创建新对话', 'New chat created') : msg('已创建新任务', 'New task created'),
        'success'
      )
      return session
    },

    async deleteSession(id) {
      await window.aih.deleteSession(id)
      set((state) => {
        const removed = state.sessions.find((s) => s.id === id)
        const wantMode = removed ? modeOf(removed) : state.page === 'chat' ? 'chat' : 'task'
        const sessions = state.sessions.filter((s) => s.id !== id)
        const next =
          sessions.find((s) => s.projectId === state.activeProjectId && !s.archived && modeOf(s) === wantMode) ||
          sessions.find((s) => s.projectId === state.activeProjectId && !s.archived)
        return { sessions, currentId: state.currentId === id ? next?.id || null : state.currentId }
      })
    },

    async archiveSession(id, archived) {
      const updated = await window.aih.setSessionArchived(id, archived)
      set((state) => {
        const target = state.sessions.find((s) => s.id === id)
        const wantMode = target ? modeOf(target) : state.page === 'chat' ? 'chat' : 'task'
        const sessions = state.sessions.map((s) => (s.id === id ? updated : s))
        const next =
          sessions.find(
            (s) =>
              s.projectId === state.activeProjectId &&
              !s.archived &&
              modeOf(s) === wantMode &&
              (archived ? s.id !== id : true)
          ) ||
          sessions.find((s) => s.projectId === state.activeProjectId && !s.archived && (archived ? s.id !== id : true))
        return {
          sessions,
          currentId: archived && state.currentId === id ? next?.id || null : state.currentId
        }
      })
      get().toast(archived ? '已归档' : '已恢复', 'success')
    },

    async createProject(input) {
      const res = await window.aih.createProject(input)
      if (!res.ok || !res.data) {
        get().toast(res.error || '创建项目失败', 'error')
        return null
      }
      const project = res.data
      set((state) => ({
        projects: [...state.projects, project],
        activeProjectId: project.id,
        currentId: null,
        showArchived: false,
        page: get().page === 'chat' ? 'chat' : 'task'
      }))
      get().toast('项目已创建', 'success')
      return project
    },

    async updateProject(id, patch) {
      const res = await window.aih.updateProject(id, patch)
      if (!res.ok || !res.data) {
        get().toast(res.error || '更新项目失败', 'error')
        return false
      }
      const project = res.data
      set((state) => ({
        projects: state.projects.map((p) => (p.id === id ? project : p)),
        sessions: state.sessions.map((s) => (s.projectId === id ? { ...s, workspaceDir: project.path } : s))
      }))
      return true
    },

    async archiveProject(id, archived) {
      const res = await window.aih.archiveProject(id, archived)
      if (!res.ok || !res.data) {
        get().toast(res.error || '归档项目失败', 'error')
        return
      }
      const project = res.data
      set((state) => {
        const projects = state.projects.map((p) => (p.id === id ? project : p))
        const activeArchived = state.activeProjectId === id && archived
        const fallback = projects.find((p) => !p.archived) || projects[0]
        const nextSession = fallback
          ? state.sessions.find((s) => s.projectId === fallback.id && !s.archived)
          : undefined
        return {
          projects,
          activeProjectId: activeArchived ? fallback?.id || 'default' : state.activeProjectId,
          currentId: activeArchived ? nextSession?.id || null : state.currentId
        }
      })
      get().toast(archived ? '项目已归档' : '项目已恢复', 'success')
    },

    async openProjectFolder(id) {
      await window.aih.openProjectFolder(id)
    },

    async patchSession(id, patch) {
      const updated = await window.aih.updateSession(id, patch)
      mapSession(id, () => updated)
      if (patch.model) {
        set((state) => ({ settings: { ...state.settings, lastModel: patch.model || null } }))
        void window.aih.warmupModel(patch.model)
      }
    },

    async setPermission(mode) {
      const cur = currentSession()
      if (!cur) return
      await get().patchSession(cur.id, { permissionMode: mode })
    },

    async setWorkspace() {
      const cur = currentSession()
      if (!cur) return
      const updated = await window.aih.setSessionWorkspace(cur.id)
      if (updated) {
        mapSession(cur.id, () => updated)
        get().toast('toast.workspaceChanged', 'success')
      }
    },

    async attachKnowledge(ids) {
      const cur = currentSession()
      if (!cur) return
      await get().patchSession(cur.id, { knowledgeBaseIds: ids })
      get().toast(
        ids.length
          ? msg(`已关联 ${ids.length} 个知识库`, `${ids.length} knowledge base(s) attached`)
          : msg('已取消知识库关联', 'Knowledge bases detached'),
        'success'
      )
    },

    async send(text, images) {
      const cur = currentSession()
      if (!cur) {
        const mode: SessionMode = get().page === 'chat' ? 'chat' : 'task'
        const created = await get().newSession({ mode })
        if (!created) return false
      }
      const session = currentSession()
      if (!session) return false
      if (!session.model) {
        get().toast('chat.selectModelFirst', 'warn')
        return false
      }
      if (session.status === 'running' || session.status === 'waiting-approval') {
        get().toast(msg('请先停止当前任务', 'Stop the current task first'), 'warn')
        return false
      }
      const parts: ChatMessage['parts'] = []
      if (text.trim()) parts.push({ type: 'text', text })
      for (const img of images || []) parts.push({ type: 'image', dataUrl: img.dataUrl, name: img.name })
      const localUser: ChatMessage = {
        id: `local-${uid()}`,
        role: 'user',
        parts,
        createdAt: Date.now()
      }
      mapSession(session.id, (s) => ({
        ...s,
        messages: [...s.messages, localUser],
        status: 'running',
        updatedAt: Date.now()
      }))
      const res = await window.aih.sendChat({ sessionId: session.id, text, images })
      if (!res.ok) {
        mapSession(session.id, (s) => ({ ...s, status: 'error' }))
        get().toast(res.error || 'toast.failed', 'error')
        return false
      }
      return true
    },

    async stop() {
      const cur = currentSession()
      if (!cur) return
      await window.aih.stopChat(cur.id)
    },

    async approve(requestId, decision) {
      const req = get().approvals.find((a) => a.id === requestId)
      if (!req) return
      set((state) => ({ approvals: state.approvals.filter((a) => a.id !== requestId) }))
      await window.aih.approve(requestId, decision)
      mapSession(req.sessionId, (s) => ({ ...s, status: 'running' }))
    },

    async regenerate(messageId) {
      const cur = currentSession()
      if (!cur) return
      const res = await window.aih.regenerate(cur.id, messageId)
      if (!res.ok) get().toast(res.error || 'toast.failed', 'error')
      else {
        mapSession(cur.id, (s) => ({ ...s, status: 'running' }))
        void get().refreshSessions()
      }
    },

    async compress() {
      const cur = currentSession()
      if (!cur) return
      const res = await window.aih.compressContext(cur.id)
      if (res.ok && res.data) {
        get().toast(
          msg(`上下文已压缩：${res.data.before} → ${res.data.after} tokens`, `Context compressed: ${res.data.before} → ${res.data.after} tokens`),
          'success'
        )
        await get().refreshSessions()
      } else {
        get().toast(res.error || 'chat.compressDone', 'warn')
      }
    },

    async updateSettings(patch) {
      const settings = await window.aih.updateSettings(patch)
      set({ settings })
    },

    async saveSnapshot(label) {
      const snapshots = await window.aih.saveHarnessSnapshot(label)
      set((state) => ({ settings: { ...state.settings, harnessSnapshots: snapshots } }))
      get().toast(msg('已保存 Harness 存档', 'Harness snapshot saved'), 'success')
    },

    async restoreSnapshot(id) {
      const harness = await window.aih.restoreHarnessSnapshot(id)
      set((state) => ({ settings: { ...state.settings, harness } }))
      get().toast('settings.restored', 'success')
    },

    async scanModels(opts) {
      set((state) => ({
        scanning: true,
        scanningStartedAt: Date.now(),
        models: [],
        // 保留手动接入的 API 供应商，扫描过程中不清空，避免刚配置就被短暂移除
        providers: state.providers.filter((p) => p.kind === 'openai' || p.kind === 'custom')
      }))
      try {
        const res = await window.aih.scanModels(opts)
        if (res.ok && res.data) set({ models: res.data })
      } catch (err) {
        get().toast(msg(`扫描失败：${String(err)}`, `Scan failed: ${String(err)}`), 'error')
      } finally {
        set({ scanning: false })
      }
    },

    async cancelScan() {
      await window.aih.cancelScan()
      set({ scanning: false })
    },

    async deployModel(id) {
      set((state) => ({ deploy: { ...state.deploy, [id]: { modelId: id, status: 'starting', progress: 0 } } }))
      const res = await window.aih.deployModel(id)
      if (!res.ok) get().toast(res.error || 'models.deployFailed', 'error')    },

    async cancelDeploy(id) {
      await window.aih.cancelDeploy(id)
    },

    async removeModel(id) {
      const res = await window.aih.removeModel(id)
      if (res.ok) {
        set((state) => ({ models: state.models.filter((m) => m.id !== id) }))
        get().toast('toast.deleted', 'success')
      } else {
        get().toast(res.error || 'toast.failed', 'error')
      }
    },

    async startProvider(id) {
      const res = await window.aih.startProvider(id)
      if (res.ok) {
        get().toast(msg('服务已启动', 'Service started'), 'success')
        await get().scanModels({ quick: true })
      } else {
        get().toast(res.error || 'toast.failed', 'error')
      }
    },

    async testProvider(id) {
      const res = await window.aih.testProvider(id)
      if (res.ok) {
        get().toast(
          msg(`连接正常，发现 ${res.data?.models ?? 0} 个模型`, `Connected, ${res.data?.models ?? 0} models found`),
          'success'
        )
        await get().scanModels({ quick: true })
      } else get().toast(res.error || msg('连接失败', 'Connection failed'), 'error')
    },

    async saveProvider(input) {
      const res = await window.aih.saveProvider({ ...input, kind: input.kind })
      if (res.ok) {
        if (res.data) {
          const saved = res.data
          set((state) => ({
            providers: [...state.providers.filter((p) => p.id !== saved.id), { ...saved, state: 'scanning' as const }]
          }))
        }
        get().toast(msg('API 已保存，正在刷新模型列表', 'API saved, refreshing models'), 'success')
        void get().scanModels({ quick: true })
        return true
      }
      get().toast(res.error || 'toast.failed', 'error')
      return false
    },

    async removeProvider(id) {
      await window.aih.removeProvider(id)
      set((state) => ({
        providers: state.providers.filter((p) => p.id !== id),
        models: state.models.filter((m) => m.providerId !== id)
      }))
    },

    async installPlugin(id) {
      const res = await window.aih.installPlugin(id)
      if (res.ok && res.data) {
        set((state) => ({
          pluginStates: [...state.pluginStates.filter((p) => p.manifestId !== id), res.data!]
        }))
        get().toast('toast.installed', 'success')
        await get().refreshAgents()
        if (res.data.error) get().toast(res.data.error, 'warn')
      } else {
        get().toast(res.error || 'toast.failed', 'error')
      }
    },

    async uninstallPlugin(id) {
      const res = await window.aih.uninstallPlugin(id)
      if (res.ok) {
        set((state) => ({
          pluginStates: state.pluginStates.filter((p) => p.manifestId !== id)
        }))
        get().toast('toast.uninstalled', 'success')
        await get().refreshAgents()
      } else get().toast(res.error || 'toast.failed', 'error')
    },

    async togglePlugin(id, enabled) {
      const res = await window.aih.togglePlugin(id, enabled)
      if (res.ok && res.data) {
        set((state) => ({
          pluginStates: [...state.pluginStates.filter((p) => p.manifestId !== id), res.data!]
        }))
        get().toast(enabled ? 'toast.enabled' : 'toast.disabled', 'success')
        await get().refreshAgents()
        if (res.data.error) get().toast(res.data.error, 'warn')
      } else get().toast(res.error || 'toast.failed', 'error')
    },

    async refreshPluginCatalog() {
      set({ pluginRefreshing: true })
      try {
        const res = await window.aih.refreshPlugins()
        set({ plugins: res.plugins, pluginStates: res.states })
        if (res.remote) get().toast('plugins.refreshed', 'success')
        else if (get().settings.pluginCatalogUrl?.trim()) get().toast('plugins.refreshedOffline', 'warn')
        else get().toast(msg('当前使用内置插件目录（未配置远程地址）', 'Using built-in catalog (no remote configured)'), 'info')
      } finally {
        set({ pluginRefreshing: false })
      }
    },

    async saveAgent(agent) {
      set({ agents: await window.aih.saveAgent(agent) })
      get().toast('common.saved', 'success')
    },

    async deleteAgent(id) {
      set({ agents: await window.aih.deleteAgent(id) })
      get().toast('toast.deleted', 'success')
    },

    async createKnowledge(name, description) {
      const kb = await window.aih.createKnowledge(name, description)
      await get().refreshKnowledge()
      return kb
    },

    async importKnowledge(id) {
      const res = await window.aih.importKnowledge(id)
      if (res.ok) {
        await get().refreshKnowledge()
        get().toast(msg(`已导入 ${res.data?.docs.length ?? 0} 个文档`, `Imported ${res.data?.docs.length ?? 0} documents`), 'success')
      } else get().toast(res.error || 'knowledge.importEmpty', 'error')
    },

    async deleteKnowledge(id) {
      await window.aih.deleteKnowledge(id)
      await get().refreshKnowledge()
      get().toast('toast.deleted', 'success')
    },

    async searchKnowledge(id, query) {
      return window.aih.searchKnowledge(id, query)
    },

    async installCatalogKnowledge(id) {
      const res = await window.aih.installCatalogKnowledge(id)
      if (res.ok) {
        await get().refreshKnowledge()
        get().toast(msg('知识库已导入', 'Knowledge pack imported'), 'success')
      } else get().toast(res.error || 'toast.failed', 'error')
    },

    async exportTraining(id) {
      const res = await window.aih.exportTrainingData(id)
      if (res.ok && res.data) get().toast(msg(`已导出 ${res.data.samples} 条样本`, `Exported ${res.data.samples} samples`), 'success')
      else get().toast(res.error || 'toast.failed', 'error')
    },

    handleChatEvent(e) {
      const state = get()
      const session = state.sessions.find((s) => s.id === e.sessionId)
      if (!session) {
        scheduleRefresh()
        return
      }
      if (e.type === 'title' && e.title) {
        mapSession(session.id, (s) => ({ ...s, title: e.title! }))
        return
      }
      if (e.type === 'status' && e.status) {
        if (e.status === 'idle') flushDeltas()
        mapSession(session.id, (s) => ({
          ...s,
          status: e.status!,
          messages: e.status === 'idle' ? s.messages.map((m) => ({ ...m, streaming: false })) : s.messages
        }))
        return
      }
      if (e.type === 'text-delta') {
        queueDelta(session.id, e.messageId, 'text', e.text || '')
        return
      }
      if (e.type === 'reasoning-delta') {
        queueDelta(session.id, e.messageId, 'reasoning', e.text || '')
        return
      }
      if (e.type === 'tool-call' && e.call) {
        flushDeltas()
        mutateMessage(session.id, e.messageId, (msg) => {
          if (!msg.parts.some((p) => p.type === 'tool-call' && p.call.id === e.call!.id)) {
            msg.parts.push({ type: 'tool-call', call: e.call! })
          }
          msg.streaming = true
        })
        return
      }
      if (e.type === 'tool-result' && e.result) {
        flushDeltas()
        mutateMessage(session.id, e.messageId, (msg) => {
          if (!msg.parts.some((p) => p.type === 'tool-result' && p.result.callId === e.result!.callId)) {
            msg.parts.push({ type: 'tool-result', result: e.result! })
          }
        })
        return
      }
      if (e.type === 'reset-message') {
        for (const key of [...pendingDeltas.keys()]) {
          if (key.startsWith(`${session.id}::${e.messageId}`)) pendingDeltas.delete(key)
        }
        mutateMessage(session.id, e.messageId, (msg) => {
          msg.parts = []
        })
        return
      }
      if (e.type === 'notice') {
        flushDeltas()
        if (e.messageId) {
          mutateMessage(session.id, e.messageId, (msg) => {
            msg.parts.push({ type: 'notice', level: e.level || 'info', text: e.text || '' })
          })
        }
        if (e.level === 'warn' || e.level === 'error') get().toast(e.text || '', e.level === 'error' ? 'error' : 'warn')
        return
      }
      if (e.type === 'error') {
        flushDeltas()
        get().toast(e.text || 'chat.error', 'error')
        if (e.messageId) {
          mutateMessage(session.id, e.messageId, (msg) => {
            if (!msg.parts.some((p) => p.type === 'notice' && p.text === e.text)) {
              msg.parts.push({ type: 'notice', level: 'error', text: e.text || '' })
            }
          })
        }
        mapSession(session.id, (s) => ({ ...s, status: 'error' }))
        return
      }
      if (e.type === 'message-done') {
        flushDeltas()
        mapSession(session.id, (s) => ({
          ...s,
          messages: s.messages.map((m) => ({ ...m, streaming: false }))
        }))
        scheduleRefresh()
      }
    },

    handleScanEvent(e) {
      if (e.type === 'provider' && e.provider) {
        set((state) => {
          const providers = state.providers.filter((p) => p.id !== e.provider!.id)
          return { providers: [...providers, e.provider!] }
        })
      } else if (e.type === 'model' && e.model) {
        set((state) => (state.models.some((m) => m.id === e.model!.id) ? {} : { models: [...state.models, e.model!] }))
      } else if (e.type === 'done') {
        set({ scanning: false })
      } else if (e.type === 'error') {
        set({ scanning: false })
        if (e.message) get().toast(e.message, 'error')
      }
    },

    handleDeployEvent(e) {
      set((state) => ({ deploy: { ...state.deploy, [e.modelId]: e } }))
      if (e.status === 'done') get().toast(msg('模型部署完成', 'Model deployed'), 'success')
      if (e.status === 'error') get().toast(e.message || msg('部署失败', 'Deployment failed'), 'error')
    },

    toast(text, level = 'info') {
      const id = uid()
      const message = translate(get().settings.language, text)
      set((state) => ({ toasts: [...state.toasts, { id, level, text: message }] }))
      const timer = setTimeout(() => {
        set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
        toastTimers.delete(id)
      }, 4200)
      toastTimers.set(id, timer)
    },

    dismissToast(id) {
      const timer = toastTimers.get(id)
      if (timer) clearTimeout(timer)
      toastTimers.delete(id)
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
    }
  }
})

export function useCurrentSession(): Session | null {
  return useAppStore((s) => s.sessions.find((x) => x.id === s.currentId) || null)
}

export function modelRefOf(m: ModelInfo): ModelRef {
  return { providerId: m.providerId, modelId: m.remoteId, label: m.name }
}
