import { spawnSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, delimiter, dirname, join } from 'node:path'

/**
 * MCP 启动命令白名单与参数校验。
 *
 * 远程插件目录里的 `mcp.command` 最终会变成一个真实的子进程：
 * 一旦目录被投毒，攻击者可以直接执行任意程序。这里做四层限制：
 *  1. 命令名必须在白名单里（npx / node / uvx / python 等已知开发者工具）
 *  2. 参数不允许出现 shell 元字符，避免命令拼接
 *  3. Windows 上优先用 node.exe 直接跑 npx-cli.js，绕开 cmd.exe 的引号/编码问题
 *  4. 安装前必须由用户确认完整命令行（哈希记入设置，之后同一条命令不再重复询问）
 */

export interface McpLaunchSpec {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface McpValidation {
  ok: boolean
  error?: string
  warnings: string[]
  /** 启动预览（用于安装确认弹窗与错误信息） */
  display: string
  /** 命令 + 参数的指纹；环境变量值也计入哈希，但不会出现在提示里 */
  hash: string
  resolved: ResolvedCommand | null
}

export interface ResolvedCommand {
  /** 真正被 spawn 的可执行文件 */
  exe: string
  /** 放在用户参数前面的固定参数（例如 npx-cli.js） */
  prefixArgs: string[]
  /** 是否必须经由 cmd.exe 启动（.cmd/.bat） */
  viaShell: boolean
}

const ALLOWED_COMMANDS = new Set([
  'npx',
  'node',
  'npm',
  'uvx',
  'uv',
  'bunx',
  'deno',
  'python',
  'python3',
  'py'
])

/** cmd.exe 会解释的字符：参数里出现即拒绝，避免命令拼接 */
const SHELL_META = /[&|<>^"`\r\n%!\u0000-\u001f]/
/** cmd.exe 里以 \ 结尾的引号参数会吃掉结尾引号 */
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
/** 不允许插件覆盖的关键环境变量 */
const ENV_DENY = new Set([
  'path',
  'pathext',
  'comspec',
  'systemroot',
  'windir',
  'node_options',
  'node_path',
  'electron_run_as_node',
  'electron_no_asar',
  'pythonpath',
  'pythonhome'
])

const MAX_ARGS = 40
const MAX_ARG_LEN = 2000
const MAX_ENV_BYTES = 8192

const KNOWN_NODE_CLI: Record<string, string[]> = {
  // npx.cmd 旁边通常是 node_modules/npm/bin/npx-cli.js
  npx: [join('node_modules', 'npm', 'bin', 'npx-cli.js'), 'npx-cli.js'],
  npm: [join('node_modules', 'npm', 'bin', 'npm-cli.js'), 'npm-cli.js']
}

function stripExt(name: string): string {
  return name.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase()
}

function quoteForCmd(arg: string): string {
  // 参数里已拒绝引号与 shell 元字符，只需要处理空格
  return /\s/.test(arg) ? `"${arg}"` : arg
}

function findOnPath(command: string): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean)
  const wantsExt = /\.(exe|cmd|bat)$/i.test(command)
  for (const dir of dirs) {
    const candidates = wantsExt ? [command] : exts.map((ext) => command + ext)
    for (const candidate of candidates) {
      const full = join(dir, candidate)
      try {
        if (existsSync(full)) return full
      } catch {
        /* 忽略不可读目录 */
      }
    }
  }
  return null
}

function findOnPathViaWhere(command: string): string | null {
  try {
    const out = spawnSync('where.exe', [command], { encoding: 'utf8', timeout: 4000, windowsHide: true })
    if (out.status !== 0 || !out.stdout) return null
    const first = out.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
    return first && existsSync(first) ? first : null
  } catch {
    return null
  }
}

/** 把命令名解析成可 spawn 的绝对路径；解析失败返回 null（由调用方给出可读错误） */
export function resolveCommand(command: string): ResolvedCommand | null {
  const name = basename(command)
  const base = stripExt(name)
  const found = process.platform === 'win32' ? findOnPath(name) || findOnPathViaWhere(base) : findOnPath(base)
  if (!found) return null

  const isCmdScript = /\.(cmd|bat)$/i.test(found)
  if (!isCmdScript) {
    return { exe: found, prefixArgs: [], viaShell: false }
  }

  // .cmd / .bat：优先在附近找 node.exe + npx-cli.js，完全绕开 cmd.exe
  const cliCandidates = KNOWN_NODE_CLI[base]
  if (cliCandidates) {
    const dir = dirname(found)
    for (const rel of cliCandidates) {
      const cli = join(dir, rel)
      if (!existsSync(cli)) continue
      const node = [join(dir, 'node.exe'), join(dir, 'node')].find((p) => existsSync(p)) || findOnPath('node.exe')
      if (node) return { exe: node, prefixArgs: [cli], viaShell: false }
    }
  }
  return { exe: found, prefixArgs: [], viaShell: true }
}

function normalizeArgs(raw: unknown): { args: string[]; error?: string } {
  if (raw === undefined || raw === null) return { args: [] }
  if (!Array.isArray(raw)) return { args: [], error: 'MCP 参数必须是字符串数组' }
  if (raw.length > MAX_ARGS) return { args: [], error: `MCP 参数过多（最多 ${MAX_ARGS} 个）` }
  const args: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') return { args: [], error: 'MCP 参数必须是字符串数组' }
    if (item.length > MAX_ARG_LEN) return { args: [], error: `MCP 参数过长（单个最多 ${MAX_ARG_LEN} 字符）` }
    if (SHELL_META.test(item)) {
      return { args: [], error: `MCP 参数包含不允许的字符：${item.slice(0, 80)}` }
    }
    if (/\\$/.test(item)) {
      return { args: [], error: `MCP 参数不能以反斜杠结尾：${item.slice(0, 80)}` }
    }
    if (item.includes('..' + (process.platform === 'win32' ? '\\' : '/'))) {
      return { args: [], error: `MCP 参数不能包含上级目录跳转：${item.slice(0, 80)}` }
    }
    args.push(item)
  }
  return { args }
}

function normalizeEnv(raw: unknown): { env: Record<string, string>; error?: string; warnings: string[] } {
  const warnings: string[] = []
  if (raw === undefined || raw === null) return { env: {}, warnings }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { env: {}, warnings, error: 'MCP 环境变量必须是对象' }
  }
  const env: Record<string, string> = {}
  let bytes = 0
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') return { env: {}, warnings, error: `环境变量 ${key} 必须是字符串` }
    if (!ENV_KEY.test(key)) return { env: {}, warnings, error: `环境变量名不合法：${key}` }
    if (ENV_DENY.has(key.toLowerCase())) {
      return { env: {}, warnings, error: `不允许覆盖环境变量 ${key}` }
    }
    if (/[\r\n\u0000]/.test(value)) return { env: {}, warnings, error: `环境变量 ${key} 含换行符` }
    bytes += key.length + value.length
    if (bytes > MAX_ENV_BYTES) return { env: {}, warnings, error: 'MCP 环境变量总大小超限' }
    if (/token|key|secret|password/i.test(key)) warnings.push(`环境变量 ${key} 看起来是密钥`)
    env[key] = value
  }
  return { env, warnings }
}

export function hashMcpSpec(spec: { command: string; args: string[]; env: Record<string, string> }): string {
  const env = Object.keys(spec.env)
    .sort()
    .map((k) => `${k}=${spec.env[k]}`)
    .join('\n')
  return createHash('sha256')
    .update(`${spec.command}\n${spec.args.join('\n')}\n${env}`)
    .digest('hex')
}

export function describeMcpCommand(command: string, args: string[], env: Record<string, string> = {}): string {
  const head = [command, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')
  const envKeys = Object.keys(env)
  return envKeys.length ? `${head}  (env: ${envKeys.join(', ')})` : head
}

/** 校验一条 MCP 启动配置；不通过时给出可直接展示给用户的原因 */
export function validateMcpSpec(raw: McpLaunchSpec): McpValidation {
  const warnings: string[] = []
  const command = typeof raw.command === 'string' ? raw.command.trim() : ''
  const display = describeMcpCommand(command || '(空)', Array.isArray(raw.args) ? (raw.args as string[]).filter((a) => typeof a === 'string') : [])

  if (!command) {
    return { ok: false, error: 'MCP 启动命令为空', warnings, display, hash: '', resolved: null }
  }
  if (command.length > 200) {
    return { ok: false, error: 'MCP 启动命令过长', warnings, display, hash: '', resolved: null }
  }
  if (/[\\/]/.test(command)) {
    return {
      ok: false,
      error: 'MCP 启动命令不允许写路径，只能使用白名单里的命令名（如 npx、uvx）',
      warnings,
      display,
      hash: '',
      resolved: null
    }
  }
  const base = stripExt(basename(command))
  if (!ALLOWED_COMMANDS.has(base)) {
    return {
      ok: false,
      error: `MCP 启动命令「${command}」不在白名单内（允许：${[...ALLOWED_COMMANDS].join(' / ')}）`,
      warnings,
      display,
      hash: '',
      resolved: null
    }
  }

  const argsResult = normalizeArgs(raw.args)
  if (argsResult.error) {
    return { ok: false, error: argsResult.error, warnings, display, hash: '', resolved: null }
  }
  const envResult = normalizeEnv(raw.env)
  if (envResult.error) {
    return { ok: false, error: envResult.error, warnings, display, hash: '', resolved: null }
  }
  warnings.push(...envResult.warnings)

  const resolved = resolveCommand(command)
  const displayFull = describeMcpCommand(command, argsResult.args, envResult.env)
  if (!resolved) {
    return {
      ok: false,
      error: `本机找不到「${command}」（MCP 需要 Node.js 20+ 或对应的命令在 PATH 中）`,
      warnings,
      display: displayFull,
      hash: '',
      resolved: null
    }
  }
  if (resolved.viaShell) warnings.push('该命令需要经由 cmd.exe 启动，请确认命令来源可信')

  const hash = hashMcpSpec({ command, args: argsResult.args, env: envResult.env })
  return { ok: true, warnings, display: displayFull, hash, resolved }
}

/** 用校验后的解析结果启动 MCP 进程；不使用 shell:true，参数不会被再次解释 */
export function spawnMcp(spec: McpLaunchSpec, resolved: ResolvedCommand): ChildProcess {
  const args = [...resolved.prefixArgs, ...(spec.args || [])]
  const env = { ...process.env, ...(spec.env || {}) }
  if (process.platform !== 'win32' || !resolved.viaShell) {
    return spawn(resolved.exe, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      shell: false,
      windowsHide: true
    })
  }
  // .cmd/.bat 必须经过 cmd.exe；已校验无元字符，这里只做必要的引号包裹
  const line = `"${[resolved.exe, ...args].map(quoteForCmd).join(' ')}"`
  const comspec = process.env.ComSpec || 'cmd.exe'
  return spawn(comspec, ['/d', '/s', '/c', line], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    shell: false,
    windowsVerbatimArguments: true,
    windowsHide: true
  })
}

/** MCP 配置是否与已确认过的哈希一致 */
export function isApproved(hash: string, approved: string[] | undefined): boolean {
  if (!hash || !Array.isArray(approved)) return false
  return approved.includes(hash)
}
