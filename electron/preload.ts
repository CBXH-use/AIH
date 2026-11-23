import { contextBridge, ipcRenderer } from 'electron'
import type { AihApi } from '../src/shared/ipc'
import type { ApprovalRequest, AppSettings, ChatStreamEvent, DeployEvent, ScanEvent } from '../src/shared/types'
import { IPC, type UpdateEvent } from '../src/shared/ipc'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: Electron.IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: AihApi = {
  bootstrap: () => ipcRenderer.invoke(IPC.bootstrap),
  info: () => ipcRenderer.invoke(IPC.info),
  checkUpdate: (force?: boolean) => ipcRenderer.invoke(IPC.appCheckUpdate, force === true),
  downloadUpdate: () => ipcRenderer.invoke(IPC.appDownloadUpdate),
  installUpdate: () => ipcRenderer.invoke(IPC.appInstallUpdate),
  onUpdateEvent: (cb: (e: UpdateEvent) => void) => subscribe<UpdateEvent>(IPC.appUpdateEvent, cb),
  openDataDir: () => ipcRenderer.invoke(IPC.appOpenDataDir),
  updateSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
  saveHarnessSnapshot: (label: string) => ipcRenderer.invoke(IPC.harnessSnapshotSave, label),
  restoreHarnessSnapshot: (id: string) => ipcRenderer.invoke(IPC.harnessRestore, id),
  getHarnessSnapshots: () => ipcRenderer.invoke(IPC.harnessSnapshots),

  scanModels: (opts) => ipcRenderer.invoke(IPC.modelsScan, opts),
  cancelScan: () => ipcRenderer.invoke(IPC.modelsCancelScan),
  warmupModel: (ref) => ipcRenderer.invoke(IPC.modelsWarmup, ref),
  deployModel: (modelId: string) => ipcRenderer.invoke(IPC.modelsDeploy, modelId),
  importGguf: (path: string) => ipcRenderer.invoke(IPC.modelsImport, path),
  cancelDeploy: (modelId: string) => ipcRenderer.invoke(IPC.modelsCancelDeploy, modelId),
  removeModel: (modelId: string) => ipcRenderer.invoke(IPC.modelsRemove, modelId),
  recommendedModels: () => ipcRenderer.invoke(IPC.modelsRecommended),
  saveProvider: (provider) => ipcRenderer.invoke(IPC.providersSave, provider),
  removeProvider: (id: string) => ipcRenderer.invoke(IPC.providersRemove, id),
  testProvider: (id: string) => ipcRenderer.invoke(IPC.providersTest, id),
  startProvider: (id: string) => ipcRenderer.invoke(IPC.providersStart, id),

  listSessions: () => ipcRenderer.invoke(IPC.sessionsList),
  createSession: (input) => ipcRenderer.invoke(IPC.sessionCreate, input),
  updateSession: (id, patch) => ipcRenderer.invoke(IPC.sessionUpdate, id, patch),
  setSessionWorkspace: (id: string) => ipcRenderer.invoke(IPC.sessionSetWorkspace, id),
  setSessionArchived: (id: string, archived: boolean) => ipcRenderer.invoke(IPC.sessionArchive, id, archived),
  deleteSession: (id: string) => ipcRenderer.invoke(IPC.sessionDelete, id),

  listProjects: () => ipcRenderer.invoke(IPC.projectsList),
  createProject: (input) => ipcRenderer.invoke(IPC.projectCreate, input),
  updateProject: (id: string, patch) => ipcRenderer.invoke(IPC.projectUpdate, id, patch),
  archiveProject: (id: string, archived: boolean) => ipcRenderer.invoke(IPC.projectArchive, id, archived),
  openProjectFolder: (id: string) => ipcRenderer.invoke(IPC.projectOpen, id),

  windowMinimize: () => ipcRenderer.invoke(IPC.windowMinimize),
  windowToggleMaximize: () => ipcRenderer.invoke(IPC.windowToggleMaximize),
  windowClose: () => ipcRenderer.invoke(IPC.windowClose),
  isWindowMaximized: () => ipcRenderer.invoke(IPC.windowIsMaximized),
  onWindowMaximized: (cb: (maximized: boolean) => void) => subscribe<boolean>(IPC.windowMaximized, cb),
  sendChat: (payload) => ipcRenderer.invoke(IPC.chatSend, payload),
  stopChat: (sessionId: string) => ipcRenderer.invoke(IPC.chatStop, sessionId),
  approve: (requestId: string, decision) => ipcRenderer.invoke(IPC.chatApprove, requestId, decision),
  regenerate: (sessionId: string, messageId: string) => ipcRenderer.invoke(IPC.chatRegenerate, sessionId, messageId),
  compressContext: (sessionId: string) => ipcRenderer.invoke(IPC.chatCompress, sessionId),

  listAgents: () => ipcRenderer.invoke(IPC.agentsList),
  saveAgent: (agent) => ipcRenderer.invoke(IPC.agentsSave, agent),
  deleteAgent: (id: string) => ipcRenderer.invoke(IPC.agentsDelete, id),

  listPlugins: () => ipcRenderer.invoke(IPC.pluginsList),
  refreshPlugins: () => ipcRenderer.invoke(IPC.pluginsRefresh),
  installPlugin: (id: string) => ipcRenderer.invoke(IPC.pluginsInstall, id),
  uninstallPlugin: (id: string) => ipcRenderer.invoke(IPC.pluginsUninstall, id),
  togglePlugin: (id: string, enabled: boolean) => ipcRenderer.invoke(IPC.pluginsToggle, id, enabled),

  listKnowledge: () => ipcRenderer.invoke(IPC.knowledgeList),
  createKnowledge: (name: string, description: string) => ipcRenderer.invoke(IPC.knowledgeCreate, name, description),
  importKnowledge: (id: string, paths?: string[]) => ipcRenderer.invoke(IPC.knowledgeImport, id, paths),
  deleteKnowledge: (id: string) => ipcRenderer.invoke(IPC.knowledgeDelete, id),
  searchKnowledge: (id: string, query: string) => ipcRenderer.invoke(IPC.knowledgeSearch, id, query),
  knowledgeCatalog: () => ipcRenderer.invoke(IPC.knowledgeCatalog),
  installCatalogKnowledge: (id: string) => ipcRenderer.invoke(IPC.knowledgeInstallCatalog, id),
  exportTrainingData: (id: string) => ipcRenderer.invoke(IPC.knowledgeExport, id),

  webSearch: (query: string) => ipcRenderer.invoke(IPC.webSearch, query),
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  pickFiles: (filters?: string[]) => ipcRenderer.invoke(IPC.pickFiles, filters),
  openPath: (path: string) => ipcRenderer.invoke(IPC.openPath, path),
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
  workspaceTree: (dir: string) => ipcRenderer.invoke(IPC.workspaceTree, dir),

  onChatEvent: (cb: (e: ChatStreamEvent) => void) => subscribe<ChatStreamEvent>('chat:event', cb),
  onScanEvent: (cb: (e: ScanEvent) => void) => subscribe<ScanEvent>(`${IPC.modelsScan}:event`, cb),
  onModelsFit: (cb: (models: import('../src/shared/types').ModelInfo[]) => void) =>
    subscribe<import('../src/shared/types').ModelInfo[]>(IPC.modelsFitEvent, cb),
  onDeployEvent: (cb: (e: DeployEvent) => void) => subscribe<DeployEvent>(`${IPC.modelsDeploy}:event`, cb),
  onApproval: (cb: (req: ApprovalRequest) => void) => subscribe<ApprovalRequest>('chat:approval', cb),
  onSettings: (cb: (s: AppSettings) => void) => subscribe<AppSettings>(IPC.settingsUpdate, cb),

  listEvalTasks: () => ipcRenderer.invoke(IPC.evalList),
  runEval: (options) => ipcRenderer.invoke(IPC.evalRun, options),
  cancelEval: () => ipcRenderer.invoke(IPC.evalCancel),
  onEvalEvent: (cb) => subscribe<import('../src/shared/eval').EvalEvent>(IPC.evalEvent, cb)
}

contextBridge.exposeInMainWorld('aih', api)
