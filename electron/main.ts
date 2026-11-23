import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron'
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
import { PluginService, type McpInstallApproval } from './services/pluginService'
import { ChatEngine, type ApprovalDecision } from './services/chatEngine'
import { getHardwareInfo } from './services/hardwareService'
import { UpdateService } from './services/updateService'
import { ATTACHMENT_SCHEME, AttachmentService, mimeOf } from './services/attachments'
import { EvalService } from './services/evalService'
import { runSelfTest } from './services/selfTest'
import type { EvalReport, EvalRunOptions } from '@shared/eval'

// 图片落盘后由渲染层通过自定义协议读取；必须在 app ready 之前注册
protocol.registerSchemesAsPrivileged([
  {
    scheme: ATTACHMENT_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: false }
  }
])

let mainWindow: BrowserWindow | null = null
let modelService: ModelService
let knowledgeService: KnowledgeService
let pluginService: PluginService
let chatEngine: ChatEngine
let updateService: UpdateService
let attachments: AttachmentService
let evalService: EvalService
let scanning: Promise<ModelInfo[]> | null = null
let hardwareInfo: HardwareInfo | null = null

const pendingApprovals = new Map<string, { resolve: (d: ApprovalDecision) => void; timer: NodeJS.Timeout }>()

/** --eval 无窗口跑评测：electron . --user-data-dir=<临时目录> --eval --eval-base-url=... */
const EVAL_CLI = process.argv.includes('--eval')
/** --self-test 无窗口验证纯逻辑（更新校验、MCP 白名单、GGUF、附件、适配评分、评测集） */
const SELF_TEST_CLI = process.argv.includes('--self-test')
/** --smoke-ui 打开窗口后检查渲染层关键元素（图片协议/CSP 是否真的生效），结果写入 --smoke-out */
const SMOKE_UI_CLI = process.argv.includes('--smoke-ui')
/** --update-check[=<version>] 用真实 GitHub Release 走一遍更新检查（只读，不下载） */
const UPDATE_CHECK_ARG = process.argv.find((a) => a === '--update-check' || a.startsWith('--update-check='))

function cliArg(name: string): string | null {
  const prefix = `--${name}=`
  const hit = process.argv.find((a) => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : null
}

async function runEvalCli(): Promise<void> {
  const baseUrl = cliArg('eval-base-url')
  const modelArg = cliArg('eval-model')
  const taskIds = cliArg('eval-tasks')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const out = cliArg('out')
  let provider: Provider | undefined
  let model: EvalRunOptions['model']
  if (baseUrl) {
    const modelId = modelArg?.split('::')[1] || 'mock'
    provider = {
      id: 'eval-mock',
      name: 'Eval Mock',
      kind: 'openai',
      baseUrl,
      models: [modelId],
      isLocal: true,
      enabled: true,
      state: 'online'
    }
    model = { providerId: 'eval-mock', modelId, label: `eval-mock/${modelId}` }
  } else if (modelArg) {
    const [providerId, modelId] = modelArg.split('::')
    if (providerId && modelId) model = { providerId, modelId, label: `${providerId}/${modelId}` }
  }
  try {
    const report = await evalService.run({ provider, model, taskIds })
    const text = JSON.stringify(report, null, 2)
    console.log(text)
    if (out) await fsp.writeFile(out, text, 'utf8')
    process.exitCode = report.summary.passed === report.summary.total ? 0 : 2
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[eval] failed: ${message}`)
    process.exitCode = 1
  } finally {
    app.quit()
  }
}

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

/** MCP 插件安装确认：把完整命令行展示给用户，默认按钮是「取消」 */
async function askMcpInstall(req: McpInstallApproval): Promise<boolean> {
  const detail = [
    `插件：${req.pluginName}`,
    `命令：${req.display}`,
    '',
    'MCP 插件会在本机执行上面这条命令（首次运行可能需要联网下载依赖包）。',
    '只有在你信任插件来源时才继续；命令来源不明请点「取消」。',
    req.warnings.length ? `\n提示：\n- ${req.warnings.join('\n- ')}` : ''
  ].join('\n')
  try {
    const res = await dialog.showMessageBox({
      type: 'warning',
      title: '确认安装 MCP 插件',
      message: '该插件将在本机执行外部命令',
      detail,
      buttons: ['允许安装', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    })
    return res.response === 0
  } catch {
    return false
  }
}

function registerAttachmentProtocol(service: AttachmentService) {
  protocol.handle(ATTACHMENT_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const file = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      const abs = service.resolve(file)
      if (!abs) return new Response('not found', { status: 404 })
      const data = await fsp.readFile(abs)
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: { 'Content-Type': mimeOf(file), 'Cache-Control': 'max-age=31536000, immutable' }
      })
    } catch {
      return new Response('error', { status: 500 })
    }
  })
}

/** 把历史会话里内联的 dataUrl 图片搬到磁盘，减小 aih-data.json */
async function migrateAttachments() {
  try {
    const moved = await attachments.migrateInlineImages(getStore().sessions)
    if (moved > 0) {
      getStore().flush()
      console.log(`[attachments] migrated ${moved} inline image(s) to ${attachments.root}`)
    }
  } catch (err) {
    console.warn('[attachments] migration failed', err)
  }
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
    if (!SMOKE_UI_CLI) return
    setTimeout(() => {
      void (async () => {
        let payload: unknown = null
        try {
          payload = await mainWindow?.webContents.executeJavaScript(`(() => {
            const images = Array.from(document.querySelectorAll('img')).map((img) => ({
              src: img.getAttribute('src') || '',
              width: img.naturalWidth,
              height: img.naturalHeight,
              complete: img.complete
            }))
            return {
              url: location.href,
              rootChildren: document.querySelector('#root') ? document.querySelector('#root').children.length : 0,
              images,
              text: (document.body.innerText || '').slice(0, 300)
            }
          })()`)
        } catch (err) {
          payload = { error: err instanceof Error ? err.message : String(err) }
        }
        const out = cliArg('smoke-out')
        if (out) {
          await fsp.writeFile(out, JSON.stringify(payload, null, 2), 'utf8').catch(() => undefined)
        }
        console.log(`[smoke-ui] ${JSON.stringify(payload)}`)
        const images = (payload as { images?: { src?: string; width?: number }[] } | null)?.images || []
        const ok = images.some((img) => String(img.src || '').startsWith('aih-attachment:') && (img.width || 0) > 0)
        process.exitCode = ok ? 0 : 3
        app.quit()
      })()
    }, 3500)
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

  ipcMain.handle(IPC.appCheckUpdate, (_e, force?: boolean): Promise<ApiResult<UpdateCheckResult>> => {
    return updateService.check(force === true)
  })
  ipcMain.handle(IPC.appDownloadUpdate, () => updateService.download())
  ipcMain.handle(IPC.appInstallUpdate, () => updateService.install())
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
  ipcMain.handle(IPC.workspaceTree, async (_e, dir: string) => {    const result: { name: string; path: string; children?: unknown[] }[] = []
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

  ipcMain.handle(IPC.evalList, () => evalService.list().map(({ id, title, category, expectTools, mode }) => ({ id, title, category, expectTools, mode })))
  ipcMain.handle(IPC.evalRun, async (_e, options: EvalRunOptions = {}): Promise<ApiResult<EvalReport>> => {
    try {
      const report = await evalService.run(options)
      return { ok: true, data: report }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle(IPC.evalCancel, () => evalService.cancel())
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
      pluginService.setMcpApprover(askMcpInstall)
      attachments = new AttachmentService(join(store.dir, 'attachments'))
      registerAttachmentProtocol(attachments)
      chatEngine = new ChatEngine({
        store,
        models: modelService,
        knowledge: knowledgeService,
        plugins: pluginService,
        attachments,
        emit: (e) => broadcast('chat:event', e),
        emitApproval: (req) => broadcast('chat:approval', req),
        requestApproval: askApproval
      })
      updateService = new UpdateService({
        userDataDir: store.dir,
        currentVersion: app.getVersion(),
        emit: (e) => broadcast(IPC.appUpdateEvent, e),
        quit: () => app.quit()
      })
      evalService = new EvalService({
        store,
        models: modelService,
        knowledge: knowledgeService,
        plugins: pluginService,
        attachments,
        userDataDir: store.dir,
        emit: (e) => broadcast(IPC.evalEvent, e)
      })

      registerIpc()

      // 只读更新检查（发版后验证新版本对老版本客户端可见）
      if (UPDATE_CHECK_ARG) {
        void (async () => {
          const override = UPDATE_CHECK_ARG.includes('=') ? UPDATE_CHECK_ARG.split('=')[1] : ''
          const probe = new UpdateService({
            userDataDir: store.dir,
            currentVersion: override || app.getVersion(),
            emit: () => undefined,
            quit: () => undefined
          })
          const res = await probe.check(true)
          console.log(JSON.stringify(res, null, 2))
          process.exitCode = res.ok && (!res.data?.hasUpdate || res.data.canAutoInstall) ? 0 : 4
          app.quit()
        })()
        return
      }

      // 无窗口评测模式（CI/发版前跑）：不建窗口、不探测硬件，跑完直接退出
      if (EVAL_CLI) {
        void runEvalCli()
        return
      }
      if (SELF_TEST_CLI) {
        void runSelfTest({ attachments })
          .then((result) => {
            console.log(JSON.stringify(result, null, 2))
            process.exitCode = result.ok ? 0 : 1
          })
          .catch((err) => {
            console.error(`[self-test] failed: ${err instanceof Error ? err.message : String(err)}`)
            process.exitCode = 1
          })
          .finally(() => app.quit())
        return
      }

      createWindow()

      // 先把窗口显示出来，再做硬件探测：nvidia-smi + PowerShell CIM 串行可能耗时数秒
      void getHardwareInfo()
        .then((info) => {
          hardwareInfo = info
          broadcast(IPC.modelsFitEvent, modelService.setHardware(info))
        })
        .catch(() => {
          hardwareInfo = fallbackHardware()
          broadcast(IPC.modelsFitEvent, modelService.setHardware(hardwareInfo))
        })

      if (store.warning) setTimeout(() => void showStoreWarning(store.warning!), 800)

      // 历史内联图片迁移到磁盘（不阻塞首屏；完成后立即落盘腾出 aih-data.json 体积）
      setTimeout(() => void migrateAttachments(), 1500)

      // 后台静默检查更新（只读 Release 元数据，不自动下载）；用户也可以随时在关于页手动检查
      if (app.isPackaged && store.settings.autoUpdateCheck !== false && net.isOnline()) {
        setTimeout(() => {
          void updateService.check(false).catch(() => undefined)
        }, 8000)
      }

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
