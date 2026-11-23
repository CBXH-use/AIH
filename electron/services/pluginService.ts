import type { ApiResult } from '@shared/ipc'
import type { AgentPreset, PluginCategory, PluginManifest, PluginState, PluginToolSpec } from '@shared/types'
import type { Store } from './store'
import { BUILTIN_PLUGINS, PLUGIN_CATEGORIES, type CatalogEntry } from './plugins/catalog'
import { McpClient, type McpToolInfo } from './plugins/mcpClient'
import { isApproved, validateMcpSpec, type McpLaunchSpec, type McpValidation } from './plugins/mcpGuard'

const REMOTE_CATALOG_URL = ''
const REMOTE_TIMEOUT_MS = 10_000
const HTTP_TIMEOUT_MS = 20_000
const MAX_OUTPUT_CHARS = 8_000
const MCP_HINT = 'MCP 需要网络与 Node.js 20+（确保 npx 可用）'
const MAX_APPROVED_MCP = 50

const AGENT_CATEGORIES = ['general', 'engineering', 'writing', 'office', 'data'] as const

export interface McpInstallApproval {
  pluginId: string
  pluginName: string
  command: string
  /** 安装确认弹窗里展示的完整命令行 */
  display: string
  warnings: string[]
  hash: string
}

/** 由主进程注入的确认回调：返回 false 表示用户取消安装 */
export type McpApprover = (req: McpInstallApproval) => Promise<boolean>

interface DeclarativeMatch {
  manifest: CatalogEntry
  tool: PluginToolSpec
}

interface McpMatch {
  manifest: CatalogEntry
  toolName: string
}

/**
 * 插件广场服务：内置 + 远程目录、安装状态、MCP 生命周期与工具执行。
 * 仅依赖 Node 内置能力，所有网络请求都有超时与 SSRF 防护。
 */
export class PluginService {
  private readonly store: Store
  private catalog: CatalogEntry[] = BUILTIN_PLUGINS.map((p) => ({ ...p }))
  private clients = new Map<string, McpClient>()
  private mcpTools = new Map<string, McpToolInfo[]>()
  private pendingStarts = new Map<string, Promise<PluginState>>()
  private approver: McpApprover | null = null

  constructor(store: Store) {
    this.store = store
  }

  /** 主进程注入安装确认（对话框展示完整命令行），未注入时 MCP 插件一律拒绝启动 */
  setMcpApprover(approver: McpApprover | null) {
    this.approver = approver
  }

  list(): { plugins: PluginManifest[]; states: PluginState[] } {
    const states = this.ensureStates()
    return { plugins: this.catalog, states }
  }

  /** 尝试拉取远程目录，失败或超时则回退内置清单，任何情况下都不抛异常 */
  async refresh(): Promise<{ plugins: PluginManifest[]; states: PluginState[]; remote: boolean }> {
    const remoteUrl = (this.store.settings.pluginCatalogUrl || REMOTE_CATALOG_URL).trim()
    let remote = false
    if (remoteUrl) {
      try {
        const res = await fetch(remoteUrl, {
          headers: { 'User-Agent': 'AIH/0.1.0', Accept: 'application/json' },
          signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS)
        })
        if (res.ok) {
          const raw: unknown = await res.json()
          if (Array.isArray(raw)) {
            const incoming: CatalogEntry[] = []
            for (const item of raw) {
              const plugin = sanitizeRemotePlugin(item)
              if (plugin) incoming.push(plugin)
            }
            this.catalog = mergeCatalog(incoming)
            remote = true
          }
        }
      } catch {
        // 离线、DNS 失败或超时：静默回退，不打断 UI
      }
    }
    if (!remote) this.catalog = BUILTIN_PLUGINS.map((p) => ({ ...p }))
    const states = this.ensureStates()
    return { plugins: this.catalog, states, remote }
  }

  async install(id: string): Promise<ApiResult<PluginState>> {
    const manifest = this.findManifest(id)
    if (!manifest) return { ok: false, error: `未找到插件 ${id}` }

    const existing = this.stateOf(id)
    // 幂等：已安装则直接返回当前状态
    if (existing?.installed) return { ok: true, data: existing }

    // MCP 插件会启动真实子进程：先过白名单，再让用户确认完整命令行
    if (manifest.installType === 'mcp') {
      const check = this.checkMcp(manifest)
      if (!check.ok) return { ok: false, error: check.error }
      if (!isApproved(check.hash, this.store.settings.mcpApprovedHashes)) {
        const accepted = await this.askMcpApproval(manifest, check)
        if (!accepted) return { ok: false, error: '已取消安装：MCP 启动命令未获得确认' }
        this.rememberMcpApproval(check.hash)
      }
    }

    const state: PluginState = {
      manifestId: manifest.id,
      installed: true,
      enabled: true,
      installedAt: Date.now()
    }
    if (manifest.installType === 'mcp') {
      state.runtime = 'starting'
      state.tools = []
    } else if (manifest.tools?.length) {
      state.tools = manifest.tools.map((t) => `plugin_${manifest.id}__${t.name}`)
    }
    this.saveState(state)

    if (manifest.installType === 'mcp') {
      const next = await this.startMcpSafe(manifest, state)
      // 启动失败时 installed 仍为 true，runtime=error，UI 可通过 toggle 重试
      return { ok: true, data: next }
    }
    return { ok: true, data: state }
  }

  async uninstall(id: string): Promise<ApiResult> {
    const manifest = this.findManifest(id)
    if (!manifest) return { ok: false, error: `未找到插件 ${id}` }
    const states = this.ensureStates()
    const state = states.find((s) => s.manifestId === id)
    if (!state?.installed) return { ok: false, error: '插件尚未安装' }

    this.stopMcp(id)
    this.store.setPluginStates(states.filter((s) => s.manifestId !== id))
    return { ok: true }
  }

  async toggle(id: string, enabled: boolean): Promise<ApiResult<PluginState>> {
    const manifest = this.findManifest(id)
    if (!manifest) return { ok: false, error: `未找到插件 ${id}` }
    const state = this.stateOf(id)
    if (!state?.installed) return { ok: false, error: '请先安装插件' }

    if (!enabled) {
      this.stopMcp(id)
      const next: PluginState = { ...state, enabled: false, error: undefined }
      if (manifest.installType === 'mcp') next.runtime = 'stopped'
      this.saveState(next)
      return { ok: true, data: next }
    }

    // MCP 已就绪时幂等返回，未就绪则懒启动
    if (manifest.installType === 'mcp') {
      if (state.enabled && state.runtime === 'ready' && this.clients.has(id)) {
        return { ok: true, data: state }
      }
      // 老版本装过、但这条命令还没被确认时，这里补一次确认，避免只能卸载重装
      const check = this.checkMcp(manifest)
      if (!check.ok) return { ok: false, error: check.error }
      if (!isApproved(check.hash, this.store.settings.mcpApprovedHashes)) {
        const accepted = await this.askMcpApproval(manifest, check)
        if (!accepted) return { ok: false, error: '已取消启动：MCP 启动命令未获得确认' }
        this.rememberMcpApproval(check.hash)
      }
      const next = await this.startMcpSafe(manifest, { ...state, enabled: true })
      if (next.runtime === 'ready') return { ok: true, data: next }
      return { ok: false, error: next.error ?? 'MCP 服务启动失败', data: next }
    }

    const next: PluginState = { ...state, enabled: true, error: undefined }
    if (manifest.tools?.length) {
      next.tools = manifest.tools.map((t) => `plugin_${manifest.id}__${t.name}`)
    }
    this.saveState(next)
    return { ok: true, data: next }
  }

  /** 已启用插件的工具；declarative 前缀 plugin_，MCP 前缀 mcp__，保证全局唯一 */
  getTools(): PluginToolSpec[] {
    const states = this.ensureStates()
    const tools: PluginToolSpec[] = []
    const seen = new Set<string>()

    for (const manifest of this.catalog) {
      const state = states.find((s) => s.manifestId === manifest.id)
      if (!state?.installed || !state.enabled) continue

      if (manifest.installType === 'declarative' && manifest.tools?.length) {
        for (const tool of manifest.tools) {
          const name = `plugin_${manifest.id}__${tool.name}`
          if (seen.has(name)) continue
          seen.add(name)
          tools.push({
            name,
            description: `[${manifest.name}] ${tool.description}`,
            parameters: tool.parameters,
            http: tool.http
          })
        }
      }

      if (manifest.installType === 'mcp' && state.runtime === 'ready') {
        const mcpTools = this.mcpTools.get(manifest.id) ?? []
        for (const tool of mcpTools) {
          const name = `mcp__${manifest.id}__${tool.name}`
          if (seen.has(name)) continue
          seen.add(name)
          tools.push({
            name,
            description: `[${manifest.name}] ${tool.description}`,
            parameters: tool.inputSchema
          })
        }
      }
    }
    return tools
  }

  /** 已安装且启用插件携带的 Agent 预设，id 加 plugin: 前缀避免与内置冲突 */
  getAgentPresets(): AgentPreset[] {
    const states = this.ensureStates()
    const presets: AgentPreset[] = []
    for (const manifest of this.catalog) {
      const state = states.find((s) => s.manifestId === manifest.id)
      if (!state?.installed || !state.enabled || !manifest.agents?.length) continue
      for (const agent of manifest.agents) {
        presets.push({
          ...agent,
          id: `plugin:${manifest.id}:${agent.id}`,
          builtin: false,
          pluginId: manifest.id
        })
      }
    }
    return presets
  }

  getSkills(): { name: string; description: string; prompt: string }[] {
    const states = this.ensureStates()
    const skills: { name: string; description: string; prompt: string }[] = []
    const seen = new Set<string>()
    for (const manifest of this.catalog) {
      const state = states.find((s) => s.manifestId === manifest.id)
      if (!state?.installed || !state.enabled || !manifest.skills?.length) continue
      for (const skill of manifest.skills) {
        if (!skill.name || seen.has(skill.name)) continue
        seen.add(skill.name)
        skills.push({ name: skill.name, description: skill.description, prompt: skill.prompt })
      }
    }
    return skills
  }

  /** 执行插件工具，输出统一截断到 8000 字符 */
  async executeTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; output: string }> {
    const states = this.ensureStates()

    const declarative = this.resolveDeclarativeTool(name)
    if (declarative) {
      const state = states.find((s) => s.manifestId === declarative.manifest.id)
      if (!state?.installed) {
        return { ok: false, output: `插件「${declarative.manifest.name}」尚未安装` }
      }
      if (!state.enabled) {
        return { ok: false, output: `插件「${declarative.manifest.name}」已停用，请先在插件广场启用` }
      }
      return this.runDeclarative(declarative, args)
    }

    const mcp = this.resolveMcpTool(name)
    if (mcp) {
      const state = states.find((s) => s.manifestId === mcp.manifest.id)
      if (!state?.installed) {
        return { ok: false, output: `插件「${mcp.manifest.name}」尚未安装` }
      }
      if (!state.enabled) {
        return { ok: false, output: `插件「${mcp.manifest.name}」已停用，请先在插件广场启用` }
      }

      let client = this.clients.get(mcp.manifest.id)
      if (!client || state.runtime !== 'ready') {
        const next = await this.startMcpSafe(mcp.manifest, { ...state, enabled: true })
        if (next.runtime !== 'ready') {
          return { ok: false, output: truncate(next.error ?? 'MCP 服务启动失败') }
        }
        client = this.clients.get(mcp.manifest.id)
      }
      if (!client) return { ok: false, output: 'MCP 客户端不可用' }

      try {
        const result = await client.callTool(mcp.toolName, args)
        return { ok: result.ok, output: truncate(result.output) }
      } catch (err) {
        return { ok: false, output: truncate(`MCP 工具调用失败：${errorMessage(err)}`) }
      }
    }

    return { ok: false, output: `未知的插件工具：${name}` }
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.clients.keys()]) this.stopMcp(id)
    this.pendingStarts.clear()
  }

  // ---------------------------------------------------------------- 内部实现

  private findManifest(id: string): CatalogEntry | undefined {
    return this.catalog.find((p) => p.id === id)
  }

  private ensureStates(): PluginState[] {
    const previous = this.store.pluginStates
    const previousSnapshot = JSON.stringify(previous)
    const map = new Map(previous.map((s) => [s.manifestId, s]))

    const states: PluginState[] = this.catalog.map((manifest) => {
      const existing = map.get(manifest.id)
      if (!existing) {
        const fresh: PluginState = {
          manifestId: manifest.id,
          installed: false,
          enabled: false,
          installedAt: 0
        }
        if (manifest.installType === 'mcp') {
          fresh.runtime = 'stopped'
          fresh.tools = []
        }
        return fresh
      }

      const state: PluginState = { ...existing }
      // 应用重启后内存中没有存活客户端，不能沿用上次的 ready/starting
      if (
        manifest.installType === 'mcp' &&
        !this.clients.has(manifest.id) &&
        (state.runtime === 'ready' || state.runtime === 'starting')
      ) {
        state.runtime = 'stopped'
      }
      if (!state.installed) {
        state.enabled = false
        if (manifest.installType === 'mcp') state.runtime = 'stopped'
      }
      return state
    })

    if (this.catalog.length !== previous.length || JSON.stringify(states) !== previousSnapshot) {
      this.store.setPluginStates(states)
    }
    return states
  }

  private stateOf(id: string): PluginState | undefined {
    return this.ensureStates().find((s) => s.manifestId === id)
  }

  private saveState(state: PluginState) {
    const states = this.ensureStates().map((s) => (s.manifestId === state.manifestId ? state : s))
    this.store.setPluginStates(states)
  }

  private checkMcp(manifest: CatalogEntry): McpValidation {
    const spec: McpLaunchSpec = manifest.mcp || { command: '' }
    return validateMcpSpec({ command: spec.command || '', args: spec.args || [], env: spec.env || {} })
  }

  private async askMcpApproval(manifest: CatalogEntry, check: McpValidation): Promise<boolean> {
    if (!this.approver) return false
    try {
      return await this.approver({
        pluginId: manifest.id,
        pluginName: manifest.name,
        command: manifest.mcp?.command || '',
        display: check.display,
        warnings: check.warnings,
        hash: check.hash
      })
    } catch {
      return false
    }
  }

  private rememberMcpApproval(hash: string) {
    if (!hash) return
    const current = this.store.settings.mcpApprovedHashes || []
    if (current.includes(hash)) return
    this.store.updateSettings({ mcpApprovedHashes: [hash, ...current].slice(0, MAX_APPROVED_MCP) })
  }

  private startMcpSafe(manifest: CatalogEntry, base: PluginState): Promise<PluginState> {
    const running = this.pendingStarts.get(manifest.id)
    if (running) return running
    const task = this.startMcp(manifest, base).finally(() => {
      this.pendingStarts.delete(manifest.id)
    })
    this.pendingStarts.set(manifest.id, task)
    return task
  }

  private async startMcp(manifest: CatalogEntry, base: PluginState): Promise<PluginState> {
    this.stopMcp(manifest.id)

    let state: PluginState = {
      ...base,
      manifestId: manifest.id,
      installed: true,
      enabled: true,
      runtime: 'starting',
      error: undefined,
      tools: []
    }
    this.saveState(state)

    // 启动前再校验一次：即使状态文件被改写，也不会执行未确认/不合规的命令
    const check = this.checkMcp(manifest)
    if (!check.ok || !isApproved(check.hash, this.store.settings.mcpApprovedHashes) || !check.resolved) {
      state = {
        ...state,
        runtime: 'error',
        error: !check.ok
          ? `${check.error}。${MCP_HINT}`
          : `该 MCP 启动命令未获得确认，请卸载后重新安装：${check.display}`,
        tools: []
      }
      this.saveState(state)
      return state
    }

    const client = new McpClient(
      manifest.id,
      { command: manifest.mcp?.command || '', args: manifest.mcp?.args || [], env: manifest.mcp?.env || {} },
      check.resolved
    )

    try {
      await client.connect()
      const tools = await client.listTools()
      this.clients.set(manifest.id, client)
      this.mcpTools.set(manifest.id, tools)
      state = {
        ...state,
        runtime: 'ready',
        error: undefined,
        tools: tools.map((t) => `mcp__${manifest.id}__${t.name}`)
      }
      this.saveState(state)
      return state
    } catch (err) {
      client.close()
      state = {
        ...state,
        runtime: 'error',
        error: `${errorMessage(err)}。${MCP_HINT}`,
        tools: []
      }
      this.saveState(state)
      return state
    }
  }

  private stopMcp(id: string) {
    const client = this.clients.get(id)
    if (client) {
      client.close()
      this.clients.delete(id)
    }
    this.mcpTools.delete(id)
  }

  private resolveDeclarativeTool(name: string): DeclarativeMatch | undefined {
    let best: DeclarativeMatch | undefined
    for (const manifest of this.catalog) {
      if (manifest.installType !== 'declarative' || !manifest.tools?.length) continue
      const prefix = `plugin_${manifest.id}__`
      if (!name.startsWith(prefix)) continue
      const toolName = name.slice(prefix.length)
      const tool = manifest.tools.find((t) => t.name === toolName)
      if (!tool) continue
      // 极端情况下 id 存在前缀包含关系，取最长匹配
      if (!best || manifest.id.length > best.manifest.id.length) best = { manifest, tool }
    }
    return best
  }

  private resolveMcpTool(name: string): McpMatch | undefined {
    let best: McpMatch | undefined
    for (const manifest of this.catalog) {
      if (manifest.installType !== 'mcp') continue
      const prefix = `mcp__${manifest.id}__`
      if (!name.startsWith(prefix)) continue
      const toolName = name.slice(prefix.length)
      if (!toolName) continue
      if (!best || manifest.id.length > best.manifest.id.length) best = { manifest, toolName }
    }
    return best
  }

  private async runDeclarative(
    match: DeclarativeMatch,
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; output: string }> {
    const http = match.tool.http
    if (!http) return { ok: false, output: `工具 ${match.tool.name} 未配置 HTTP 请求` }

    try {
      const missing = requiredParams(match.tool.parameters).filter((key) => {
        const value = args[key]
        return value === undefined || value === null || value === ''
      })
      if (missing.length) return { ok: false, output: `缺少必填参数：${missing.join('、')}` }

      const url = renderTemplate(http.url, args, true)
      if (/\{\{[^}]+\}\}/.test(url)) return { ok: false, output: '工具 URL 模板存在未替换的参数' }
      assertSafeUrl(url)

      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(http.headers ?? {})) {
        headers[key] = renderTemplate(value, args, false)
      }

      let body: string | undefined
      if (http.method === 'POST') {
        body = http.bodyTemplate ? renderJsonTemplate(http.bodyTemplate, args) : JSON.stringify(args)
        if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json'
      }

      const res = await fetch(url, {
        method: http.method,
        headers,
        body,
        redirect: 'follow',
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
      })
      // 重定向后的最终地址同样要做内网校验，防止 DNS/302 绕过
      if (res.url) assertSafeUrl(res.url)

      const text = await res.text()
      if (!res.ok) {
        const detail = text.trim().slice(0, 300)
        return {
          ok: false,
          output: `HTTP ${res.status} ${res.statusText}${detail ? `：${detail}` : ''}`
        }
      }

      let data: unknown = text
      if (text.trim()) {
        try {
          data = JSON.parse(text)
        } catch {
          data = text
        }
      }

      if (http.responsePath) {
        const path = renderTemplate(http.responsePath, args, false)
        const value = pickPath(data, path)
        if (value === undefined) return { ok: false, output: `响应中未找到字段 ${path}` }
        data = value
      }

      const output = typeof data === 'string' ? data : JSON.stringify(data)
      return { ok: true, output: truncate(output) }
    } catch (err) {
      return { ok: false, output: truncate(`插件工具执行失败：${errorMessage(err)}`) }
    }
  }
}

// ------------------------------------------------------------------ 工具函数

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  const suffix = '\n…（输出已截断）'
  return text.slice(0, MAX_OUTPUT_CHARS - suffix.length) + suffix
}

function requiredParams(parameters: Record<string, unknown> | undefined): string[] {
  const required = parameters?.['required']
  if (!Array.isArray(required)) return []
  return required.filter((key): key is string => typeof key === 'string')
}

/** 替换 {{参数名}}；URL 中的值做 encodeURIComponent，响应路径与请求头保持原文 */
function renderTemplate(template: string, args: Record<string, unknown>, encode: boolean): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_all, key: string) => {
    const value = args[key]
    if (value === undefined || value === null) return ''
    return encode ? encodeURIComponent(String(value)) : String(value)
  })
}

/** JSON 请求体中的占位符按 JSON 字符串规则转义 */
function renderJsonTemplate(template: string, args: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_all, key: string) => {
    const value = args[key]
    if (value === undefined || value === null) return ''
    return JSON.stringify(String(value)).slice(1, -1)
  })
}

function pickPath(value: unknown, path: string): unknown {
  let current: unknown = value
  for (const segment of path.split('.')) {
    if (!segment) continue
    if (Array.isArray(current)) {
      const index = Number(segment)
      if (!Number.isInteger(index) || index < 0) return undefined
      current = current[index]
    } else if (current && typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment]
    } else {
      return undefined
    }
    if (current === undefined) return undefined
  }
  return current
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name)
}

/** DNS 层面的内网域名无法在此完全拦截，但拒绝字面量内网地址与 file 协议 */
function assertSafeUrl(raw: string): void {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('工具地址无效')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('出于安全考虑，仅允许 http/https 工具地址')
  }
  if (isPrivateHost(url.hostname)) {
    throw new Error('出于安全考虑，禁止访问本机或内网地址')
  }
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1' || host === '0.0.0.0' || host === '::') return true
  if (/^127\./.test(host)) return true
  if (/^10\./.test(host)) return true
  if (/^192\.168\./.test(host)) return true
  if (/^169\.254\./.test(host)) return true
  const match = host.match(/^172\.(\d+)\./)
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true
  return false
}

// ------------------------------------------------------- 远程目录清洗与合并

function mergeCatalog(remote: CatalogEntry[]): CatalogEntry[] {
  const builtinById = new Map(BUILTIN_PLUGINS.map((p) => [p.id, p]))
  const merged = new Map<string, CatalogEntry>(builtinById)
  const order = BUILTIN_PLUGINS.map((p) => p.id)

  for (const plugin of remote) {
    const builtin = builtinById.get(plugin.id)
    if (builtin) {
      // 同 id 以远程为准，但保留官方推荐标记
      merged.set(plugin.id, { ...plugin, featured: builtin.featured })
    } else {
      merged.set(plugin.id, plugin)
      order.push(plugin.id)
    }
  }

  const result: CatalogEntry[] = []
  for (const id of order) {
    const plugin = merged.get(id)
    if (plugin) result.push(plugin)
  }
  return result
}

function sanitizeRemotePlugin(raw: unknown): CatalogEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>

  const id = typeof o.id === 'string' ? o.id.trim() : ''
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  const version = typeof o.version === 'string' ? o.version.trim() : ''
  if (!id || !name || !version) return null
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return null

  const category: PluginCategory = PLUGIN_CATEGORIES.includes(o.category as PluginCategory)
    ? (o.category as PluginCategory)
    : 'tools'
  const installType: PluginManifest['installType'] =
    o.installType === 'declarative' || o.installType === 'mcp' || o.installType === 'builtin'
      ? o.installType
      : 'builtin'

  const plugin: CatalogEntry = {
    id,
    name,
    version,
    author: typeof o.author === 'string' && o.author ? o.author : '社区',
    description: typeof o.description === 'string' ? o.description : '',
    category,
    icon: typeof o.icon === 'string' && o.icon ? o.icon : '🧩',
    tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string') : [],
    installType,
    downloads: typeof o.downloads === 'number' && Number.isFinite(o.downloads) ? o.downloads : 0
  }
  if (typeof o.homepage === 'string') plugin.homepage = o.homepage

  if (installType === 'declarative') {
    const tools = Array.isArray(o.tools)
      ? o.tools.map(sanitizeRemoteTool).filter((t): t is PluginToolSpec => t !== null)
      : []
    if (!tools.length) return null
    plugin.tools = tools
  }

  if (installType === 'mcp') {
    const mcp = sanitizeRemoteMcp(o.mcp)
    if (!mcp) return null
    plugin.mcp = mcp
  }

  if (Array.isArray(o.skills)) {
    const skills = o.skills
      .map(sanitizeRemoteSkill)
      .filter((s): s is { name: string; description: string; prompt: string } => s !== null)
    if (skills.length) plugin.skills = skills
  }

  if (Array.isArray(o.agents)) {
    const agents = o.agents
      .map(sanitizeRemoteAgent)
      .filter((a): a is Omit<AgentPreset, 'builtin' | 'pluginId'> => a !== null)
    if (agents.length) plugin.agents = agents
  }

  return plugin
}

function sanitizeRemoteTool(raw: unknown): PluginToolSpec | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) return null

  const httpRaw = o.http
  if (!httpRaw || typeof httpRaw !== 'object' || Array.isArray(httpRaw)) return null
  const h = httpRaw as Record<string, unknown>
  const method = h.method === 'POST' ? 'POST' : h.method === 'GET' ? 'GET' : null
  if (!method) return null

  const url = typeof h.url === 'string' ? h.url.trim() : ''
  if (!url) return null
  try {
    assertSafeUrl(url.replace(/\{\{[^}]+\}\}/g, 'placeholder'))
  } catch {
    return null
  }

  const tool: PluginToolSpec = {
    name,
    description: typeof o.description === 'string' && o.description ? o.description : name,
    parameters:
      o.parameters && typeof o.parameters === 'object' && !Array.isArray(o.parameters)
        ? (o.parameters as Record<string, unknown>)
        : { type: 'object', properties: {} },
    http: { method, url }
  }

  if (h.headers && typeof h.headers === 'object' && !Array.isArray(h.headers)) {
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(h.headers as Record<string, unknown>)) {
      if (typeof value === 'string') headers[key] = value
    }
    if (Object.keys(headers).length) tool.http!.headers = headers
  }
  if (typeof h.bodyTemplate === 'string' && h.bodyTemplate) tool.http!.bodyTemplate = h.bodyTemplate
  if (typeof h.responsePath === 'string' && h.responsePath) tool.http!.responsePath = h.responsePath
  return tool
}

function sanitizeRemoteMcp(raw: unknown): { command: string; args?: string[]; env?: Record<string, string> } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const command = typeof o.command === 'string' ? o.command.trim() : ''
  if (!command) return null
  const mcp: { command: string; args?: string[]; env?: Record<string, string> } = { command }
  if (Array.isArray(o.args)) {
    mcp.args = o.args.filter((a): a is string => typeof a === 'string')
  }
  if (o.env && typeof o.env === 'object' && !Array.isArray(o.env)) {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(o.env as Record<string, unknown>)) {
      if (typeof value === 'string') env[key] = value
    }
    if (Object.keys(env).length) mcp.env = env
  }
  // 远程目录里的 MCP 命令必须在白名单内且不含 shell 元字符，否则整条插件直接丢弃
  const check = validateMcpSpec(mcp)
  if (!check.ok) {
    console.warn(`[plugins] rejected remote MCP plugin command: ${check.error}`)
    return null
  }
  return mcp
}

function sanitizeRemoteSkill(raw: unknown): { name: string; description: string; prompt: string } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  const prompt = typeof o.prompt === 'string' ? o.prompt : ''
  if (!name || !prompt) return null
  return {
    name,
    description: typeof o.description === 'string' ? o.description : name,
    prompt
  }
}

function sanitizeRemoteAgent(raw: unknown): Omit<AgentPreset, 'builtin' | 'pluginId'> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const id = typeof o.id === 'string' ? o.id.trim() : ''
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  const systemPrompt = typeof o.systemPrompt === 'string' ? o.systemPrompt : ''
  if (!id || !name || !systemPrompt) return null

  const category = AGENT_CATEGORIES.includes(o.category as (typeof AGENT_CATEGORIES)[number])
    ? (o.category as AgentPreset['category'])
    : 'general'

  const agent: Omit<AgentPreset, 'builtin' | 'pluginId'> = {
    id,
    name,
    icon: typeof o.icon === 'string' && o.icon ? o.icon : '🤖',
    description: typeof o.description === 'string' ? o.description : name,
    category,
    systemPrompt,
    tools: Array.isArray(o.tools) ? o.tools.filter((t): t is string => typeof t === 'string') : []
  }
  if (Array.isArray(o.recommendedModels)) {
    const models = o.recommendedModels.filter((m): m is string => typeof m === 'string')
    if (models.length) agent.recommendedModels = models
  }
  return agent
}
