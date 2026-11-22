import { app, BrowserWindow, dialog, ipcMain, net, shell } from 'electron'
import { existsSync, mkdirSync, promises as fsp } from 'fs'
import { cpus, freemem, totalmem } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type {
  AgentPreset,
  AppSettings,
  ApprovalRequest,
  Bootstrap,
  HardwareInfo,
  HarnessSnapshot,
  ModelInfo,
  ModelRef,
  PluginState,
  Project,
  Provider,
  Session,
  SessionMode
} from '@shared/types'
import { IPC, type ApiResult, type ChatSendPayload, type ScanOptions, type UpdateCheckResult } from '@shared/ipc'
import { BUILTIN_AGENTS, DEFAULT_HARNESS } from '@shared/defaults'
import { getStore, type StoreLoadWarning } from './services/store'
import { ModelService } from './services/modelService'
import { KnowledgeService } from './services/knowledgeService'
import { PluginService } from './services/pluginService'
import { ChatEngine, type ApprovalDecision } from './services/chatEngine'
import { getHardwareInfo } from './services/hardwareService'

let mainWindow: BrowserWindow | null = null
let modelService: ModelService
let knowledgeService: KnowledgeService
let pluginService: PluginService
let chatEngine: ChatEngine
let scanning: Promise<ModelInfo[]> | null = null
let hardwareInfo: HardwareInfo | null = null

const pendingApprovals = new Map<string, { resolve: (d: ApprovalDecision) => void; timer: NodeJS.Timeout }>()

// 单实例锁：两个实例同时运行会各自整库回写，互相覆盖会话/设置
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

function broadcast(channel: string, payload: unknown) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function askApproval(req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | null = null
    let settled = false
    const onAbort = () => done('deny')
    const done = (d: ApprovalDecision) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      pendingApprovals.delete(req.id)
      signal?.removeEventListener('abort', onAbort)
      resolve(d)
    }
    timer = setTimeout(() => done('deny'), 5 * 60 * 1000)
    pendingApprovals.set(req.id, { resolve: done, timer })
    if (signal) {
      if (signal.aborted) {
        done('deny')
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 660,
    show: false,
    frame: false,
    backgroundColor: '#f6f6f4',
    autoHideMenuBar: true,
    title: 'AIH · AI HOUSE',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // 避免窗口未获得焦点时渲染层被节流，导致表单点击响应变慢
      backgroundThrottling: false
    }
  })
  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    mainWindow?.focus()
    mainWindow?.webContents.focus()
  })
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.focus()
    mainWindow?.webContents.focus()
  })
  mainWindow.on('maximize', () => broadcast(IPC.windowMaximized, true))
  mainWindow.on('unmaximize', () => broadcast(IPC.windowMaximized, false))

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
    for (const [, p] of pendingApprovals) {
      clearTimeout(p.timer)
      p.resolve('deny')
    }
    pendingApprovals.clear()
  })
}

function defaultWorkspace(): string {
  const configured = getStore().settings.defaultWorkspaceDir?.trim()
  const dir = configured || join(app.getPath('documents'), 'AIH Workspace')
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  } catch {
    /* ignore */
  }
  return dir
}

function safeFolderName(name: string): string {
  return (
    name
      .replace(/[<>:"/\\|?*]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 48) || `project-${Date.now()}`
  )
}

function ensureDefaultProject(): Project {
  const store = getStore()
  const now = Date.now()
  let project = store.getProject('default')
  if (!project) {
    project = {
      id: 'default',
      name: '默认项目',
      description: '未创建项目时，会话都在这里运行',
      path: defaultWorkspace(),
      createdAt: now,
      updatedAt: now
    }
    store.upsertProject(project)
  } else if (!existsSync(project.path)) {
    try {
      mkdirSync(project.path, { recursive: true })
    } catch {
      /* ignore */
    }
  }
  for (const s of store.sessions) {
    if (!s.projectId) s.projectId = 'default'
    if (!s.workspaceDir && project) s.workspaceDir = project.path
  }
  store.flush()
  return project
}

function fallbackHardware(): HardwareInfo {
  const totalRamGb = Math.round((totalmem() / 1024 ** 3) * 10) / 10
  const freeRamGb = Math.round((freemem() / 1024 ** 3) * 10) / 10
  return {
    cpu: cpus()[0]?.model || 'Unknown CPU',
    totalRamGb,
    freeRamGb,
    tier: totalRamGb >= 32 ? 'high' : totalRamGb >= 16 ? 'mid' : 'low'
  }
}

function isNewerVersion(latest: string, current: string): boolean {
  const a = latest.split('.').map((n) => Number(n) || 0)
  const b = current.split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < 3; i++) {
    const x = a[i] || 0
    const y = b[i] || 0
    if (x !== y) return x > y
  }
  return false
}

/** 数据文件损坏时给出可操作的提示，而不是静默清空 */
async function showStoreWarning(warning: StoreLoadWarning): Promise<void> {
  const detail = warning.recoveredFromBackup
    ? `已自动从备份恢复大部分数据。\n原文件已保留：${warning.corruptFile}`
    : `原文件已保留：${warning.corruptFile}\n可以先用文本编辑器检查，或把该文件反馈给我们。`
  try {
    const res = await dialog.showMessageBox({
      type: 'warning',
      title: '数据文件需要修复',
      message: warning.recoveredFromBackup ? 'AIH 已从备份恢复数据' : 'AIH 的数据文件读取失败，已使用空白数据启动',
      detail: `${warning.message}\n\n${detail}`,
      buttons: ['知道了', '打开数据目录'],
      defaultId: 0,
      cancelId: 0
    })
    if (res.response === 1) void shell.openPath(getStore().dir)
  } catch {
    /* 对话框失败不影响启动 */
  }
}

function toRef(model: ModelInfo): ModelRef {
  return { providerId: model.providerId, modelId: model.remoteId, label: model.name }
}

function pickDefaultModel(): ModelRef | null {
  const settings = getStore().settings
  if (settings.lastModel) return settings.lastModel
  const first = modelService.getModels().find((m) => m.status === 'ready')
  return first ? toRef(first) : null
}

function createSessionRecord(input: {
  projectId?: string
  mode?: SessionMode
  agentId?: string
  model?: ModelRef | null
  title?: string
  workspaceDir?: string | null
  permissionMode?: Session['permissionMode']
}): Session {
  const settings = getStore().settings
  const requested = input.projectId ? getStore().getProject(input.projectId) : null
  const project = requested && !requested.archived ? requested : ensureDefaultProject()
  // 项目内会话固定使用项目目录，保证工具读写都发生在项目文件夹
  const workspace = project.path
  if (workspace) {
    try {
      if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true })
    } catch {
      /* ignore */
    }
  }
  const session: Session = {
    id: randomUUID(),
    title: input.title || '新对话',
    projectId: project.id,
    mode: input.mode || 'task',
    agentId: input.agentId || 'general',
    model: input.model === undefined ? pickDefaultModel() : input.model,
    permissionMode: input.permissionMode || settings.defaultPermissionMode || 'ask',
    messages: [],
    workspaceDir: workspace,
    archived: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'idle',
    tokenUsage: { input: 0, output: 0, compressed: 0 },
    knowledgeBaseIds: []
  }
  getStore().upsertSession(session)
  return session
}

function listAgents(): AgentPreset[] {
  return [...BUILTIN_AGENTS, ...pluginService.getAgentPresets(), ...getStore().customAgents]
}

function registerIpc() {
  ipcMain.handle(IPC.bootstrap, (): Bootstrap => {
    const store = getStore()
    const defaultProject = ensureDefaultProject()
    // 重置上次异常退出遗留的运行状态
    for (const s of store.sessions) {
      if (!s.projectId) s.projectId = defaultProject.id
      if (!s.mode) s.mode = 'task'
      if (s.status === 'running' || s.status === 'waiting-approval') s.status = 'idle'
      for (const m of s.messages) m.streaming = false
    }
    const plugins = pluginService.list()
    const customProviders = store.settings.modelSettings.providers.filter(
      (p) => p.kind === 'openai' || p.kind === 'custom'
    )
    const providerIds = new Set(modelService.getProviders().map((p) => p.id))
    const providers = [...modelService.getProviders(), ...customProviders.filter((p) => !providerIds.has(p.id))]
    const models = [...modelService.getModels()]
    const modelIds = new Set(models.map((m) => m.id))
    for (const provider of customProviders) {
      for (const name of provider.models || []) {
        const id = `${provider.id}::${name}`
        if (modelIds.has(id)) continue
        modelIds.add(id)
        models.push({
          id,
          remoteId: name,
          providerId: provider.id,
          providerKind: provider.kind,
          name,
          status: 'ready',
          supportsTools: true
        })
      }
    }
    return {
      settings: store.settings,
      sessions: store.sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt),
      projects: store.projects.slice().sort((a, b) => a.createdAt - b.createdAt),
      agents: listAgents(),
      plugins: plugins.plugins,
      pluginStates: plugins.states,
      knowledgeBases: knowledgeService.list(),
      providers,
      models,
      hardware: hardwareInfo || fallbackHardware(),
      info: {
        version: app.getVersion(),
        platform: process.platform,
        online: net.isOnline(),
        userDataDir: store.dir
      }
    }
  })

  ipcMain.handle(IPC.info, () => ({
    version: app.getVersion(),
    platform: process.platform,
    online: net.isOnline(),
    userDataDir: getStore().dir
  }))

  ipcMain.handle(IPC.appCheckUpdate, async (): Promise<ApiResult<UpdateCheckResult>> => {
    try {
      const res = await fetch('https://api.github.com/repos/CBXH-use/AIH/releases/latest', {
        headers: { 'User-Agent': `AIH/${app.getVersion()}`, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(8000)
      })
      if (!res.ok) return { ok: false, error: `检查更新失败：HTTP ${res.status}` }
      const data = (await res.json()) as { tag_name?: string; html_url?: string; body?: string }
      const latest = String(data.tag_name || '').replace(/^v/i, '')
      const current = app.getVersion()
      return {
        ok: true,
        data: {
          current,
          latest,
          hasUpdate: !!latest && isNewerVersion(latest, current),
          url: String(data.html_url || 'https://github.com/CBXH-use/AIH/releases'),
          notes: typeof data.body === 'string' ? data.body.slice(0, 4000) : ''
        }
      }
    } catch (err) {
      return { ok: false, error: `检查更新失败：${err instanceof Error ? err.message : String(err)}` }
    }
  })
  ipcMain.handle(IPC.appOpenDataDir, () => {
    void shell.openPath(getStore().dir)
  })

  ipcMain.handle(IPC.settingsUpdate, (_e, patch: Partial<AppSettings>) => {
    const settings = getStore().updateSettings(patch)
    broadcast(IPC.settingsUpdate, settings)
    return settings
  })

  ipcMain.handle(IPC.harnessSnapshots, () => getStore().settings.harnessSnapshots)
  ipcMain.handle(IPC.harnessSnapshotSave, (_e, label: string) => {
    const store = getStore()
    const snapshot: HarnessSnapshot = {
      id: randomUUID(),
      label: label || `存档 ${new Date().toLocaleString('zh-CN')}`,
      createdAt: Date.now(),
      config: structuredClone(store.settings.harness)
    }
    const snapshots = [snapshot, ...store.settings.harnessSnapshots].slice(0, 30)
    store.updateSettings({ harnessSnapshots: snapshots })
    return snapshots
  })
  ipcMain.handle(IPC.harnessRestore, (_e, id: string) => {
    const store = getStore()
    const snap = store.settings.harnessSnapshots.find((s) => s.id === id)
    if (!snap) throw new Error('存档不存在')
    store.updateSettings({ harness: structuredClone(snap.config) })
    broadcast(IPC.settingsUpdate, store.settings)
    return store.settings.harness
  })

  ipcMain.handle(IPC.modelsScan, async (_e, opts: ScanOptions = {}) => {
    if (scanning) return { ok: true, data: modelService.getModels() }
    scanning = modelService.scan(opts)
    try {
      const models = await scanning
      return { ok: true, data: models }
    } finally {
      scanning = null
    }
  })
  ipcMain.handle(IPC.modelsCancelScan, () => {
    modelService.cancelScan()
  })
  ipcMain.handle(IPC.modelsWarmup, (_e, ref: ModelRef) => modelService.warmup(ref))
  ipcMain.handle(IPC.modelsDeploy, async (_e, modelId: string) => {
    const res = await modelService.deploy(modelId)
    return res
  })
  ipcMain.handle(IPC.modelsCancelDeploy, (_e, modelId: string) => {
    modelService.cancelDeploy(modelId)
  })
  ipcMain.handle(IPC.modelsImport, (_e, path: string) => modelService.importGgufFile(path))
  ipcMain.handle(IPC.modelsRemove, (_e, modelId: string) => modelService.remove(modelId))
  ipcMain.handle(IPC.modelsRecommended, () => modelService.recommended(hardwareInfo || fallbackHardware()))

  ipcMain.handle(IPC.providersSave, (_e, input: Partial<Provider> & { name: string; kind: Provider['kind']; baseUrl: string }) => modelService.saveProvider(input))
  ipcMain.handle(IPC.providersRemove, (_e, id: string) => modelService.removeProvider(id))
  ipcMain.handle(IPC.providersTest, (_e, id: string) => modelService.testProvider(id))
  ipcMain.handle(IPC.providersStart, (_e, id: string) => modelService.startProvider(id))

  ipcMain.handle(IPC.sessionsList, () => getStore().sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt))
  ipcMain.handle(IPC.sessionCreate, (_e, input) => createSessionRecord(input || {}))
  ipcMain.handle(IPC.sessionUpdate, (_e, id: string, patch: Partial<Session>) => {
    const store = getStore()
    const session = store.getSession(id)
    if (!session) throw new Error('会话不存在')
    const allowed: (keyof Session)[] = [
      'title',
      'mode',
      'agentId',
      'model',
      'permissionMode',
      'knowledgeBaseIds',
      'pinned',
      'archived'
    ]
    for (const key of allowed) {
      if (key in patch) {
        ;(session as any)[key] = (patch as any)[key]
      }
    }
    if (patch.model) store.updateSettings({ lastModel: patch.model })
    session.updatedAt = Date.now()
    store.upsertSession(session)
    return session
  })
  ipcMain.handle(IPC.sessionDelete, (_e, id: string) => {
    chatEngine.stop(id)
    getStore().deleteSession(id)
  })
  ipcMain.handle(IPC.sessionArchive, (_e, id: string, archived: boolean) => {
    const store = getStore()
    const session = store.getSession(id)
    if (!session) throw new Error('会话不存在')
    session.archived = archived
    session.updatedAt = Date.now()
    store.upsertSession(session)
    return session
  })
  ipcMain.handle(IPC.sessionSetWorkspace, async (_e, id: string) => {
    const store = getStore()
    const session = store.getSession(id)
    if (!session) throw new Error('会话不存在')
    const project = store.getProject(session.projectId)
    // 项目内会话必须使用项目目录
    if (project && project.id !== 'default') return session
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: '选择工作区目录' })
    if (result.canceled || !result.filePaths[0]) return null
    session.workspaceDir = result.filePaths[0]
    session.updatedAt = Date.now()
    store.upsertSession(session)
    return session
  })

  ipcMain.handle(IPC.projectsList, () => getStore().projects.slice().sort((a, b) => a.createdAt - b.createdAt))
  ipcMain.handle(IPC.projectCreate, (_e, input: { name: string; path?: string; description?: string }): ApiResult<Project> => {
    const name = String(input?.name || '').trim()
    if (!name) return { ok: false, error: '项目名称不能为空' }
    const path = input.path?.trim() || join(app.getPath('documents'), 'AIH Projects', safeFolderName(name))
    try {
      if (!existsSync(path)) mkdirSync(path, { recursive: true })
    } catch (err) {
      return { ok: false, error: `无法创建项目目录：${String(err)}` }
    }
    const now = Date.now()
    const project: Project = {
      id: randomUUID(),
      name,
      description: input.description || '',
      path,
      createdAt: now,
      updatedAt: now
    }
    getStore().upsertProject(project)
    return { ok: true, data: project }
  })
  ipcMain.handle(IPC.projectUpdate, (_e, id: string, patch: Partial<Pick<Project, 'name' | 'description' | 'path'>>): ApiResult<Project> => {
    const store = getStore()
    const project = store.getProject(id)
    if (!project) return { ok: false, error: '项目不存在' }
    if (patch.name !== undefined) project.name = String(patch.name).trim() || project.name
    if (patch.description !== undefined) project.description = patch.description
    if (patch.path && patch.path !== project.path) {
      try {
        if (!existsSync(patch.path)) mkdirSync(patch.path, { recursive: true })
      } catch (err) {
        return { ok: false, error: `目录不可用：${String(err)}` }
      }
      project.path = patch.path
      for (const s of store.sessions) {
        if (s.projectId === project.id) s.workspaceDir = project.path
      }
    }
    project.updatedAt = Date.now()
    store.upsertProject(project)
    return { ok: true, data: project }
  })
  ipcMain.handle(IPC.projectArchive, (_e, id: string, archived: boolean): ApiResult<Project> => {
    const store = getStore()
    const project = store.getProject(id)
    if (!project) return { ok: false, error: '项目不存在' }
    if (project.id === 'default' && archived) return { ok: false, error: '默认项目不能归档' }
    project.archived = archived
    project.updatedAt = Date.now()
    store.upsertProject(project)
    return { ok: true, data: project }
  })
  ipcMain.handle(IPC.projectOpen, (_e, id: string) => {
    const project = getStore().getProject(id)
    if (project && existsSync(project.path)) void shell.openPath(project.path)
  })

  ipcMain.handle(IPC.windowMinimize, () => mainWindow?.minimize())
  ipcMain.handle(IPC.windowToggleMaximize, () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.handle(IPC.windowClose, () => mainWindow?.close())
  ipcMain.handle(IPC.windowIsMaximized, () => mainWindow?.isMaximized() ?? false)

  ipcMain.handle(IPC.chatSend, async (_e, payload: ChatSendPayload): Promise<ApiResult> => {
    try {
      await chatEngine.send(payload.sessionId, payload.text, payload.images)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle(IPC.chatStop, (_e, sessionId: string) => chatEngine.stop(sessionId))
  ipcMain.handle(IPC.chatApprove, (_e, requestId: string, decision: ApprovalDecision) => {
    const pending = pendingApprovals.get(requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    pendingApprovals.delete(requestId)
    pending.resolve(decision === 'deny' ? 'deny' : decision)
  })
  ipcMain.handle(IPC.chatRegenerate, async (_e, sessionId: string, messageId: string): Promise<ApiResult> => {
    try {
      await chatEngine.regenerate(sessionId, messageId)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle(IPC.chatCompress, async (_e, sessionId: string): Promise<ApiResult<{ before: number; after: number }>> => {
    try {
      const data = await chatEngine.compressContext(sessionId)
      return { ok: true, data }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.agentsList, () => listAgents())
  ipcMain.handle(IPC.agentsSave, (_e, agent: AgentPreset) => {
    const store = getStore()
    if (!agent.id || BUILTIN_AGENTS.some((a) => a.id === agent.id)) {
      const copy: AgentPreset = { ...agent, id: `custom-${randomUUID().slice(0, 8)}`, builtin: false }
      store.setCustomAgents([...store.customAgents, copy])
    } else {
      const next = store.customAgents.filter((a) => a.id !== agent.id)
      next.push({ ...agent, builtin: false, pluginId: undefined })
      store.setCustomAgents(next)
    }
    return listAgents()
  })
  ipcMain.handle(IPC.agentsDelete, (_e, id: string) => {
    const store = getStore()
    store.setCustomAgents(store.customAgents.filter((a) => a.id !== id))
    return listAgents()
  })

  ipcMain.handle(IPC.pluginsList, () => pluginService.list())
  ipcMain.handle(IPC.pluginsRefresh, () => pluginService.refresh())
  ipcMain.handle(IPC.pluginsInstall, (_e, id: string) => pluginService.install(id))
  ipcMain.handle(IPC.pluginsUninstall, (_e, id: string) => pluginService.uninstall(id))
  ipcMain.handle(IPC.pluginsToggle, (_e, id: string, enabled: boolean) => pluginService.toggle(id, enabled))

  ipcMain.handle(IPC.knowledgeList, () => knowledgeService.list())
  ipcMain.handle(IPC.knowledgeCreate, (_e, name: string, description: string) => knowledgeService.create(name, description))
  ipcMain.handle(IPC.knowledgeImport, (_e, id: string, paths?: string[]) => knowledgeService.import(id, paths))
  ipcMain.handle(IPC.knowledgeDelete, (_e, id: string) => knowledgeService.delete(id))
  ipcMain.handle(IPC.knowledgeSearch, (_e, id: string, query: string) => knowledgeService.search(id, query, 6))
  ipcMain.handle(IPC.knowledgeCatalog, () => knowledgeService.catalog())
  ipcMain.handle(IPC.knowledgeInstallCatalog, (_e, id: string) => knowledgeService.installCatalog(id))
  ipcMain.handle(IPC.knowledgeExport, async (_e, id: string) => {
    const res = await knowledgeService.exportTraining(id)
    if (res.ok && res.data) shell.showItemInFolder(res.data.path)
    return res
  })

  ipcMain.handle(IPC.webSearch, async (_e, query: string) => {
    const { searchWeb } = await import('./services/harness/tools')
    return searchWeb(query)
  })

  ipcMain.handle(IPC.pickFolder, async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: '选择文件夹' })
    return res.canceled ? null : res.filePaths[0] || null
  })
  ipcMain.handle(IPC.pickFiles, async (_e, filters?: string[]) => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      title: '选择文件',
      filters: filters?.length ? [{ name: '文本文件', extensions: filters }] : undefined
    })
    return res.canceled ? [] : res.filePaths
  })
  ipcMain.handle(IPC.openPath, (_e, path: string) => {
    if (existsSync(path)) void shell.openPath(path)
  })
  ipcMain.handle(IPC.openExternal, (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })
  ipcMain.handle(IPC.workspaceTree, async (_e, dir: string) => {
    const result: { name: string; path: string; children?: unknown[] }[] = []
    const walk = async (base: string, depth: number): Promise<unknown[]> => {
      if (depth > 3) return []
      const items = await fsp.readdir(base, { withFileTypes: true }).catch(() => [])
      const out: unknown[] = []
      for (const item of items.slice(0, 100)) {
        if (item.name.startsWith('.') || item.name === 'node_modules') continue
        const full = join(base, item.name)
        if (item.isDirectory()) out.push({ name: item.name, path: full, children: await walk(full, depth + 1) })
        else out.push({ name: item.name, path: full })
      }
      return out
    }
    if (existsSync(dir)) result.push(...((await walk(dir, 0)) as typeof result))
    return result
  })
}

if (hasSingleInstanceLock) {
  app.whenReady()
    .then(async () => {
      const store = getStore()
      ensureDefaultProject()
      store.cleanupBackups(store.settings.harness.safety.backupRetentionDays ?? 7)
      modelService = new ModelService(
        store,
        (e) => broadcast(IPC.modelsScan + ':event', e),
        (e) => broadcast(IPC.modelsDeploy + ':event', e)
      )
      knowledgeService = new KnowledgeService(store)
      pluginService = new PluginService(store)
      chatEngine = new ChatEngine({
        store,
        models: modelService,
        knowledge: knowledgeService,
        plugins: pluginService,
        emit: (e) => broadcast('chat:event', e),
        emitApproval: (req) => broadcast('chat:approval', req),
        requestApproval: askApproval
      })

      registerIpc()
      createWindow()

      // 先把窗口显示出来，再做硬件探测：nvidia-smi + PowerShell CIM 串行可能耗时数秒
      void getHardwareInfo()
        .then((info) => {
          hardwareInfo = info
        })
        .catch(() => {
          hardwareInfo = fallbackHardware()
        })

      if (store.warning) setTimeout(() => void showStoreWarning(store.warning!), 800)

      // 老用户启动时后台快速探测本地模型（不扫描磁盘 GGUF，避免拖慢启动）
      if (store.settings.onboardingDone) {
        setTimeout(() => {
          if (!scanning) {
            scanning = modelService.scan({ quick: true })
            void scanning
              .catch(() => undefined)
              .finally(() => {
                scanning = null
              })
          }
        }, 1200)
      }

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[main] startup failed', err)
      try {
        dialog.showErrorBox(
          'AIH 启动失败',
          `${message}\n\n请重启 AIH 重试；如果持续失败，请到数据目录备份 aih-data*.json 后反馈问题。`
        )
      } catch {
        /* ignore */
      }
      app.quit()
    })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  getStore().flush()
  modelService?.dispose()
  void pluginService?.shutdown()
  for (const [, p] of pendingApprovals) {
    clearTimeout(p.timer)
    p.resolve('deny')
  }
  pendingApprovals.clear()
})
