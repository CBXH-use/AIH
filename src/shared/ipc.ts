import type {
  AgentPreset,
  AppInfo,
  AppSettings,
  ApprovalRequest,
  Bootstrap,
  CatalogKnowledgeBase,
  ChatStreamEvent,
  DeployEvent,
  HarnessConfig,
  HarnessSnapshot,
  KnowledgeBase,
  KnowledgeHit,
  ModelInfo,
  ModelRef,
  PluginManifest,
  PluginState,
  Provider,
  RecommendedModel,
  ScanEvent,
  Session,
  WebSearchResult,
  Project,
  SessionMode
} from './types'

export const IPC = {
  bootstrap: 'app:bootstrap',
  info: 'app:info',
  appCheckUpdate: 'app:check-update',
  appOpenDataDir: 'app:open-data-dir',
  settingsUpdate: 'settings:update',
  harnessSnapshots: 'harness:snapshots',
  harnessSnapshotSave: 'harness:snapshot-save',
  harnessRestore: 'harness:restore',

  modelsScan: 'models:scan',
  modelsCancelScan: 'models:cancel-scan',
  modelsWarmup: 'models:warmup',
  modelsDeploy: 'models:deploy',
  modelsImport: 'models:import',
  modelsCancelDeploy: 'models:cancel-deploy',
  modelsRemove: 'models:remove',
  modelsRecommended: 'models:recommended',
  providersSave: 'providers:save',
  providersRemove: 'providers:remove',
  providersTest: 'providers:test',
  providersStart: 'providers:start',

  sessionsList: 'sessions:list',
  sessionCreate: 'session:create',
  sessionUpdate: 'session:update',
  sessionDelete: 'session:delete',
  sessionSetWorkspace: 'session:set-workspace',
  sessionArchive: 'session:archive',
  projectsList: 'projects:list',
  projectCreate: 'projects:create',
  projectUpdate: 'projects:update',
  projectArchive: 'projects:archive',
  projectOpen: 'projects:open',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  windowIsMaximized: 'window:is-maximized',
  windowMaximized: 'window:maximized',
  chatSend: 'chat:send',
  chatStop: 'chat:stop',
  chatApprove: 'chat:approve',
  chatRegenerate: 'chat:regenerate',
  chatCompress: 'chat:compress',

  agentsList: 'agents:list',
  agentsSave: 'agents:save',
  agentsDelete: 'agents:delete',

  pluginsList: 'plugins:list',
  pluginsRefresh: 'plugins:refresh',
  pluginsInstall: 'plugins:install',
  pluginsUninstall: 'plugins:uninstall',
  pluginsToggle: 'plugins:toggle',

  knowledgeList: 'knowledge:list',
  knowledgeCreate: 'knowledge:create',
  knowledgeImport: 'knowledge:import',
  knowledgeDelete: 'knowledge:delete',
  knowledgeSearch: 'knowledge:search',
  knowledgeCatalog: 'knowledge:catalog',
  knowledgeInstallCatalog: 'knowledge:install-catalog',
  knowledgeExport: 'knowledge:export',

  webSearch: 'web:search',
  pickFolder: 'dialog:pick-folder',
  pickFiles: 'dialog:pick-files',
  openPath: 'shell:open-path',
  openExternal: 'shell:open-external',
  workspaceTree: 'workspace:tree'
} as const

export interface ScanOptions {
  quick?: boolean
  includeLooseGguf?: boolean
}

export interface ChatSendPayload {
  sessionId: string
  text: string
  images?: { dataUrl: string; name?: string }[]
}

export interface ApiResult<T = void> {
  ok: boolean
  data?: T
  error?: string
}

export interface UpdateCheckResult {
  current: string
  latest: string
  hasUpdate: boolean
  url: string
  notes?: string
}

export interface AihApi {
  bootstrap(): Promise<Bootstrap>
  info(): Promise<AppInfo>
  checkUpdate(): Promise<ApiResult<UpdateCheckResult>>
  openDataDir(): Promise<void>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  saveHarnessSnapshot(label: string): Promise<HarnessSnapshot[]>
  restoreHarnessSnapshot(id: string): Promise<HarnessConfig>
  getHarnessSnapshots(): Promise<HarnessSnapshot[]>

  scanModels(opts?: ScanOptions): Promise<ApiResult<ModelInfo[]>>
  cancelScan(): Promise<void>
  warmupModel(ref: ModelRef): Promise<void>
  deployModel(modelId: string): Promise<ApiResult>
  importGguf(path: string): Promise<ApiResult>
  cancelDeploy(modelId: string): Promise<void>
  removeModel(modelId: string): Promise<ApiResult>
  recommendedModels(): Promise<RecommendedModel[]>
  saveProvider(provider: Partial<Provider> & { name: string; kind: Provider['kind']; baseUrl: string }): Promise<ApiResult<Provider>>
  removeProvider(id: string): Promise<ApiResult>
  testProvider(id: string): Promise<ApiResult<{ state: Provider['state']; models: number }>>
  startProvider(id: string): Promise<ApiResult<Provider>>

  listSessions(): Promise<Session[]>
  createSession(input: { projectId?: string; mode?: SessionMode; agentId?: string; model?: ModelRef | null; title?: string; workspaceDir?: string | null; permissionMode?: Session['permissionMode'] }): Promise<Session>
  updateSession(id: string, patch: Partial<Pick<Session, 'title' | 'mode' | 'agentId' | 'model' | 'permissionMode' | 'workspaceDir' | 'knowledgeBaseIds' | 'pinned' | 'archived'>>): Promise<Session>
  setSessionWorkspace(id: string): Promise<Session | null>
  setSessionArchived(id: string, archived: boolean): Promise<Session>
  deleteSession(id: string): Promise<void>

  listProjects(): Promise<Project[]>
  createProject(input: { name: string; path?: string; description?: string }): Promise<ApiResult<Project>>
  updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'description' | 'path'>>): Promise<ApiResult<Project>>
  archiveProject(id: string, archived: boolean): Promise<ApiResult<Project>>
  openProjectFolder(id: string): Promise<void>

  windowMinimize(): Promise<void>
  windowToggleMaximize(): Promise<void>
  windowClose(): Promise<void>
  isWindowMaximized(): Promise<boolean>
  onWindowMaximized(cb: (maximized: boolean) => void): () => void
  sendChat(payload: ChatSendPayload): Promise<ApiResult>
  stopChat(sessionId: string): Promise<void>
  approve(requestId: string, decision: 'allow' | 'allow-always' | 'deny'): Promise<void>
  regenerate(sessionId: string, messageId: string): Promise<ApiResult>
  compressContext(sessionId: string): Promise<ApiResult<{ before: number; after: number }>>

  listAgents(): Promise<AgentPreset[]>
  saveAgent(agent: AgentPreset): Promise<AgentPreset[]>
  deleteAgent(id: string): Promise<AgentPreset[]>

  listPlugins(): Promise<{ plugins: PluginManifest[]; states: PluginState[] }>
  refreshPlugins(): Promise<{ plugins: PluginManifest[]; states: PluginState[]; remote: boolean }>
  installPlugin(id: string): Promise<ApiResult<PluginState>>
  uninstallPlugin(id: string): Promise<ApiResult>
  togglePlugin(id: string, enabled: boolean): Promise<ApiResult<PluginState>>

  listKnowledge(): Promise<KnowledgeBase[]>
  createKnowledge(name: string, description: string): Promise<KnowledgeBase>
  importKnowledge(id: string, paths?: string[]): Promise<ApiResult<KnowledgeBase>>
  deleteKnowledge(id: string): Promise<void>
  searchKnowledge(id: string, query: string): Promise<KnowledgeHit[]>
  knowledgeCatalog(): Promise<{ bases: CatalogKnowledgeBase[]; online: boolean }>
  installCatalogKnowledge(id: string): Promise<ApiResult<KnowledgeBase>>
  exportTrainingData(id: string): Promise<ApiResult<{ path: string; samples: number }>>

  webSearch(query: string): Promise<WebSearchResult[]>
  pickFolder(): Promise<string | null>
  pickFiles(filters?: string[]): Promise<string[]>
  openPath(path: string): Promise<void>
  openExternal(url: string): Promise<void>
  workspaceTree(dir: string): Promise<{ name: string; path: string; children?: unknown[] }[]>

  onChatEvent(cb: (e: ChatStreamEvent) => void): () => void
  onScanEvent(cb: (e: ScanEvent) => void): () => void
  onDeployEvent(cb: (e: DeployEvent) => void): () => void
  onApproval(cb: (req: ApprovalRequest) => void): () => void
  onSettings(cb: (s: AppSettings) => void): () => void
}
