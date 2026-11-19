import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AgentPreset, AppSettings, KnowledgeBase, PluginState, Project, Session } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'

interface DbShape {
  version: number
  settings: AppSettings
  sessions: Session[]
  projects: Project[]
  pluginStates: PluginState[]
  customAgents: AgentPreset[]
  knowledge: KnowledgeBase[]
}

const EMPTY_DB: DbShape = {
  version: 2,
  settings: DEFAULT_SETTINGS,
  sessions: [],
  projects: [],
  pluginStates: [],
  customAgents: [],
  knowledge: []
}

function deepMerge<T>(base: T, patch: Partial<T>): T {
  const out: any = Array.isArray(base) ? [...(base as any[])] : { ...(base as any) }
  for (const [k, v] of Object.entries(patch as any)) {
    if (v === undefined) continue
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof (out as any)[k] === 'object' && (out as any)[k] && !Array.isArray((out as any)[k])) {
      out[k] = deepMerge((out as any)[k], v)
    } else {
      out[k] = v
    }
  }
  return out as T
}

export class Store {
  readonly dir: string
  private file: string
  private db: DbShape
  private timer: NodeJS.Timeout | null = null

  constructor() {
    this.dir = app.getPath('userData')
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    this.file = join(this.dir, 'aih-data.json')
    this.db = this.load()
  }

  private load(): DbShape {
    try {
      if (!existsSync(this.file)) return structuredClone(EMPTY_DB)
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      const settings = deepMerge(structuredClone(DEFAULT_SETTINGS), raw.settings || {})
      // v1 的默认上下文是 32768，会让本地 8B 模型明显变慢；升级时把「仍是旧默认值」的用户降到 8192
      if ((Number(raw.version) || 1) < 2 && settings.harness.context.window === 32768) {
        settings.harness.context.window = 8192
      }
      return {
        ...structuredClone(EMPTY_DB),
        ...raw,
        version: 2,
        settings
      }
    } catch (err) {
      console.error('[store] load failed, starting fresh', err)
      return structuredClone(EMPTY_DB)
    }
  }

  private persist() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 120)
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    try {
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.db, null, 1), 'utf8')
      renameSync(tmp, this.file)
    } catch (err) {
      console.error('[store] save failed', err)
    }
  }

  get settings(): AppSettings {
    return this.db.settings
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.db.settings = deepMerge(this.db.settings, patch)
    this.persist()
    return this.db.settings
  }

  get sessions(): Session[] {
    return this.db.sessions
  }

  getSession(id: string): Session | undefined {
    return this.db.sessions.find((s) => s.id === id)
  }

  upsertSession(session: Session) {
    const i = this.db.sessions.findIndex((s) => s.id === session.id)
    if (i >= 0) this.db.sessions[i] = session
    else this.db.sessions.unshift(session)
    this.persist()
  }

  deleteSession(id: string) {
    this.db.sessions = this.db.sessions.filter((s) => s.id !== id)
    this.persist()
  }

  get pluginStates(): PluginState[] {
    return this.db.pluginStates
  }

  get projects(): Project[] {
    return this.db.projects
  }

  getProject(id: string): Project | undefined {
    return this.db.projects.find((p) => p.id === id)
  }

  upsertProject(project: Project) {
    const i = this.db.projects.findIndex((p) => p.id === project.id)
    if (i >= 0) this.db.projects[i] = project
    else this.db.projects.unshift(project)
    this.persist()
  }

  setProjects(projects: Project[]) {
    this.db.projects = projects
    this.persist()
  }

  setPluginStates(states: PluginState[]) {
    this.db.pluginStates = states
    this.persist()
  }

  get customAgents(): AgentPreset[] {
    return this.db.customAgents
  }

  setCustomAgents(agents: AgentPreset[]) {
    this.db.customAgents = agents
    this.persist()
  }

  get knowledge(): KnowledgeBase[] {
    return this.db.knowledge
  }

  setKnowledge(list: KnowledgeBase[]) {
    this.db.knowledge = list
    this.persist()
  }

  /** raw message store for a knowledge base's chunks */
  kbDir(id: string): string {
    const d = join(this.dir, 'knowledge', id)
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
    return d
  }

  auditLogPath(sessionId: string): string {
    const d = join(this.dir, 'audit')
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
    return join(d, `${sessionId}.jsonl`)
  }

  /** 清理超过保留天数的写文件备份 */
  cleanupBackups(days: number) {
    if (!days || days <= 0) return
    const root = join(this.dir, 'backups')
    if (!existsSync(root)) return
    const cutoff = Date.now() - days * 86_400_000
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const full = join(root, entry.name)
        try {
          if (statSync(full).mtimeMs < cutoff) rmSync(full, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }
}

let store: Store | null = null
export function getStore(): Store {
  if (!store) store = new Store()
  return store
}
