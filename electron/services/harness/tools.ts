import { spawn } from 'child_process'
import { promises as fsp } from 'fs'
import { basename, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'path'
import type { PermissionMode, RiskAssessment, WebSearchResult } from '@shared/types'
import type { AppSettings } from '@shared/types'
import type { KnowledgeService } from '../knowledgeService'
import type { PluginService } from '../pluginService'
import type { Store } from '../store'

export interface ToolContext {
  sessionId: string
  workspaceDir: string | null
  permissionMode: PermissionMode
  settings: AppSettings
  store: Store
  knowledge: KnowledgeService
  plugins: PluginService
  /** local: 本地模型 harness，允许更宽容的路径与内容修正 */
  profile?: 'local' | 'api'
}

export interface ToolExecResult {
  output: string
  isError?: boolean
}

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
  readOnly: boolean
  assess: (args: Record<string, unknown>, ctx: ToolContext) => RiskAssessment
  execute: (args: Record<string, unknown>, ctx: ToolContext, signal: AbortSignal) => Promise<ToolExecResult>
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.next', '.nuxt', 'target', 'build', '__pycache__', '.venv', 'venv', '.idea', '.vscode', '.aih'])
const MAX_READ_CHARS = 160_000
const MAX_OUTPUT = 24_000

const SENSITIVE = /(^|[\\/])(\.ssh|\.aws|\.gnupg|\.config[\\/]gcloud)([\\/]|$)|(^|[\\/])(\.env(\.|$)|id_rsa|id_ed25519|credentials|\.git-credentials|\.npmrc|Cookies|Login Data)/i

export function isInside(child: string, parent: string | null): boolean {
  if (!parent) return false
  const rel = relative(normalize(parent), normalize(child))
  // rel === '' 表示 child 就是 parent 本身（例如工作区根目录），必须视为在工作区内
  if (rel === '') return true
  return !rel.startsWith('..') && !isAbsolute(rel)
}

export function resolvePath(input: string, ctx: ToolContext): { abs: string; inside: boolean } {
  const base = ctx.workspaceDir || process.cwd()
  let raw = input.trim()
  // 本地小模型常把工作区相对路径写成 /src/App.tsx；Windows 上按工作区相对路径处理
  if (process.platform === 'win32' && /^[\\/](?![\\/])/.test(raw) && !/^[a-zA-Z]:/.test(raw)) {
    raw = raw.replace(/^[\\/]+/, '')
  }
  const abs = isAbsolute(raw) ? normalize(raw) : resolve(base, raw)
  return { abs, inside: isInside(abs, ctx.workspaceDir) }
}

function fmtPath(abs: string, ctx: ToolContext): string {
  if (ctx.workspaceDir && isInside(abs, ctx.workspaceDir)) return relative(ctx.workspaceDir, abs).split(sep).join('/')
  return abs
}

function clamp(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n…（已截断，共 ${text.length} 字符）`
}

function low(reasons: string[] = []): RiskAssessment {
  return { level: 'low', reasons }
}

function medium(reason: string): RiskAssessment {
  return { level: 'medium', reasons: [reason] }
}

function high(reason: string): RiskAssessment {
  return { level: 'high', reasons: [reason] }
}

function isBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000)
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true
  return false
}

async function readText(abs: string): Promise<string> {
  const st = await fsp.stat(abs).catch(() => null)
  if (!st || !st.isFile()) throw new Error('文件不存在或不是普通文件')
  if (st.size > 12 * 1024 * 1024) {
    throw new Error(`文件过大（${(st.size / 1024 / 1024).toFixed(1)}MB），请用 grep 或 offset/limit 分段读取`)
  }
  const buf = await fsp.readFile(abs)
  if (isBinary(buf)) throw new Error('该文件是二进制文件，无法作为文本读取')
  return buf.toString('utf8')
}

/** web_fetch 的出站地址校验：拒绝本机、内网与常见私有网段，避免 Agent 被诱导访问本地服务 */
function assertSafeUrl(raw: string): URL {
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只支持 http/https 链接')
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^0\./.test(host)
  ) {
    throw new Error('不允许访问本机或内网地址')
  }
  const m = /^172\.(\d+)\./.exec(host)
  if (m) {
    const second = Number(m[1])
    if (second >= 16 && second <= 31) throw new Error('不允许访问内网地址')
  }
  return url
}

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.scss', '.less', '.html', '.json',
  '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.vue', '.svelte', '.sql', '.yml', '.yaml',
  '.toml', '.sh', '.ps1'
])

/** 修正本地小模型写文件时的常见问题：代码文件被整段包进代码围栏、换行被二次转义 */
function normalizeLocalFileContent(raw: string, absPath: string): string {
  let content = raw
  if (CODE_EXTENSIONS.has(extname(absPath).toLowerCase())) {
    const fenced = /^\s*```[^\n]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(content)
    if (fenced) content = fenced[1]
  }
  if (!content.includes('\n') && /\\[nrt"]/.test(content)) {
    content = content
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
  return content
}

/** 缩进/行尾空白不一致时的宽松匹配，仅用于本地模型 */
function findLooseBlock(text: string, find: string): { start: number; end: number } | null {
  const findLines = find.split('\n').map((line) => line.trim())
  while (findLines.length && findLines[0] === '') findLines.shift()
  while (findLines.length && findLines[findLines.length - 1] === '') findLines.pop()
  if (!findLines.some((line) => line !== '')) return null
  const fileLines = text.split('\n')
  const offsets: number[] = []
  let offset = 0
  for (const line of fileLines) {
    offsets.push(offset)
    offset += line.length + 1
  }
  for (let i = 0; i + findLines.length <= fileLines.length; i++) {
    let matched = true
    for (let j = 0; j < findLines.length; j++) {
      if (fileLines[i + j].trim() !== findLines[j]) {
        matched = false
        break
      }
    }
    if (matched) {
      const last = i + findLines.length - 1
      return { start: offsets[i], end: offsets[last] + fileLines[last].length }
    }
  }
  return null
}

async function walk(
  dir: string,
  opts: { maxEntries?: number; maxDepth?: number; signal?: AbortSignal; skip?: Set<string> }
): Promise<string[]> {
  const out: string[] = []
  const maxEntries = opts.maxEntries ?? 4000
  const maxDepth = opts.maxDepth ?? 12
  const skip = opts.skip ?? SKIP_DIRS
  let entries = 0
  const rec = async (d: string, depth: number) => {
    if (depth > maxDepth || out.length >= maxEntries || opts.signal?.aborted) return
    let dirents
    try {
      dirents = await fsp.readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of dirents) {
      entries++
      if (entries > 60000 || out.length >= maxEntries || opts.signal?.aborted) return
      if (item.name.startsWith('.') && item.isDirectory()) continue
      const full = join(d, item.name)
      if (item.isDirectory()) {
        if (skip.has(item.name)) continue
        await rec(full, depth + 1)
      } else if (item.isFile()) {
        out.push(full)
      }
    }
  }
  await rec(dir, 0)
  return out
}

function globToRegExp(pattern: string): RegExp {
  const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '')
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '*') {
      if (p[i + 1] === '*') {
        i++
        if (p[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else re += '.*'
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if ('+.^$(){}|[]\\'.includes(c)) re += '\\' + c
    else re += c
  }
  return new RegExp('^' + re + '$', 'i')
}

function matchesGlob(relPath: string, pattern: string): boolean {
  const p = relPath.split(sep).join('/')
  const re = globToRegExp(pattern)
  if (re.test(p)) return true
  if (!pattern.includes('/')) return re.test(basename(p))
  return false
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const CATASTROPHIC = [
  /format\s+[a-z]:/i,
  /diskpart/i,
  /bcdedit/i,
  /reg\s+delete.*(hklm|hkey_local_machine)/i,
  /remove-item.*-recurse.*-force\s+[a-z]:\\?\s*$/i,
  /del\s+\/[sq].*[a-z]:\\\s*$/i,
  /rd\s+\/s\s+\/q\s+[a-z]:\\?\s*$/i,
  /shutdown\s+(-s|-r|\/s|\/r)/i,
  /mkfs\./i,
  /dd\s+if=.*of=\/dev\//i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/i
]

function shellRisk(command: string, ctx: ToolContext): RiskAssessment {
  const trimmed = command.trim()
  for (const p of CATASTROPHIC) {
    if (p.test(trimmed)) return { level: 'high', reasons: ['catastrophic', '检测到可能破坏系统或删除磁盘的命令'] }
  }
  for (const deny of ctx.settings.harness.safety.denyPatterns || []) {
    if (deny && trimmed.toLowerCase().includes(deny.toLowerCase())) {
      return { level: 'high', reasons: ['blocked-pattern', `命中危险命令规则：${deny}`] }
    }
  }
  // 先按命令分隔符切段：只读前缀匹配必须逐段判断，否则 `git status; Remove-Item ...` 会被误判为只读
  const segments = trimmed
    .split(/\r?\n|;|&&|\|\||\||`|\$\(/)
    .map((s) => s.trim())
    .filter(Boolean)
  const safe = /^(git\s+(status|diff|log|show|branch|remote|rev-parse)|dir|ls|cat|type|where|which|node\s+-v|npm\s+-v|python\s+--version|pip\s+--version|echo|pwd|Get-ChildItem|Get-Content|Get-Location|Test-Path)\b/i
  if (segments.length > 0 && segments.every((s) => safe.test(s))) return medium('运行只读命令')
  return high('执行 Shell 命令可能修改文件或系统状态')
}

async function runShell(
  command: string,
  cwd: string,
  timeoutSec: number,
  signal: AbortSignal
): Promise<ToolExecResult> {
  return new Promise((resolvePromise) => {
    const isWin = process.platform === 'win32'
    const shell = isWin ? 'powershell.exe' : 'bash'
    const args = isWin ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-lc', command]
    let child
    try {
      child = spawn(shell, args, { cwd, windowsHide: true, env: { ...process.env } })
    } catch (err) {
      resolvePromise({ output: `无法启动 Shell：${String(err)}`, isError: true })
      return
    }
    let output = ''
    const append = (d: Buffer) => {
      output += d.toString()
      if (output.length > 400_000) output = output.slice(-200_000)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    let settled = false
    const finish = (result: ToolExecResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolvePromise(result)
    }
    const killTree = () => {
      if (child.pid && isWin) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      } else {
        child.kill('SIGKILL')
      }
    }
    const onAbort = () => {
      killTree()
      finish({ output: clamp(output) + '\n[已中止]', isError: true })
    }
    const timer = setTimeout(() => {
      killTree()
      finish({ output: clamp(output) + `\n[命令超时 ${timeoutSec}s，已被终止]`, isError: true })
    }, Math.max(5, timeoutSec) * 1000)
    signal.addEventListener('abort', onAbort, { once: true })
    child.on('error', (err) => finish({ output: `命令执行失败：${String(err)}`, isError: true }))
    child.on('close', (code) => {
      const text = clamp(output.trim() || '(无输出)')
      finish({ output: `退出码 ${code}\n${text}`, isError: code !== 0 })
    })
  })
}

export async function searchWeb(query: string, signal?: AbortSignal): Promise<WebSearchResult[]> {
  const ua =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'
  const results: WebSearchResult[] = []
  const decode = (s: string) =>
    s
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;|&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .trim()

  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': ua, Accept: 'text/html' },
      signal: signal || AbortSignal.timeout(15000)
    })
    if (res.ok) {
      const html = await res.text()
      const blocks = html.split(/<div[^>]+class="[^"]*result[^"]*"/i).slice(1, 8)
      for (const block of blocks) {
        const link = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
        if (!link) continue
        let url = link[1]
        const redirect = url.match(/uddg=([^&]+)/)
        if (redirect) url = decodeURIComponent(redirect[1])
        const snippetRaw = block.match(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
        results.push({
          title: decode(link[2]),
          url,
          snippet: snippetRaw ? decode(snippetRaw[1]) : ''
        })
        if (results.length >= 6) break
      }
    }
  } catch {
    /* try fallback */
  }

  if (!results.length) {
    try {
      const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`, {
        headers: { 'User-Agent': ua, Accept: 'text/html' },
        signal: AbortSignal.timeout(12000)
      })
      if (res.ok) {
        const html = await res.text()
        const blocks = html.split(/<li class="b_algo"/i).slice(1, 7)
        for (const block of blocks) {
          const link = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
          if (!link) continue
          const snippetRaw = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
          results.push({ title: decode(link[2]), url: link[1], snippet: snippetRaw ? decode(snippetRaw[1]) : '' })
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (!results.length) throw new Error('联网搜索不可用（可能没有网络或搜索源被拦截），请改用 web_fetch 直接访问已知网址')
  return results
}

function schema(props: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties: props, required, additionalProperties: false }
}

function str(description: string): Record<string, unknown> {
  return { type: 'string', description }
}

export function buildTools(): Record<string, ToolSpec> {
  const tools: ToolSpec[] = []

  tools.push({
    name: 'list_dir',
    description: '列出目录内容（树状，最多 300 项）。当你不确定项目结构时先调用它。',
    parameters: schema({ path: str('相对工作区的目录路径，默认为 .'), depth: { type: 'number', description: '递归深度，默认 2，最大 4' } }),
    readOnly: true,
    assess: (args, ctx) => {
      const { abs, inside } = resolvePath(String(args.path || '.'), ctx)
      if (!inside) return medium('读取工作区之外的目录')
      void abs
      return low()
    },
    async execute(args, ctx, signal) {
      const { abs } = resolvePath(String(args.path || '.'), ctx)
      const depth = Math.min(4, Math.max(1, Number(args.depth) || 2))
      const lines: string[] = []
      let count = 0
      const rec = async (dir: string, d: number, prefix: string) => {
        if (d > depth || count >= 300 || signal.aborted) return
        let dirents
        try {
          dirents = await fsp.readdir(dir, { withFileTypes: true })
        } catch (err) {
          lines.push(`${prefix}[无法读取: ${String(err)}]`)
          return
        }
        dirents.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        for (const item of dirents) {
          if (count >= 300) {
            lines.push(`${prefix}…（已截断）`)
            return
          }
          if (SKIP_DIRS.has(item.name)) continue
          count++
          if (item.isDirectory()) {
            lines.push(`${prefix}${item.name}/`)
            await rec(join(dir, item.name), d + 1, prefix + '  ')
          } else {
            const st = await fsp.stat(join(dir, item.name)).catch(() => null)
            lines.push(`${prefix}${item.name}${st ? `  (${st.size} B)` : ''}`)
          }
        }
      }
      const st = await fsp.stat(abs).catch(() => null)
      if (!st) return { output: `目录不存在：${fmtPath(abs, ctx)}`, isError: true }
      if (!st.isDirectory()) return { output: '路径不是目录，请用 read_file', isError: true }
      lines.push(`${fmtPath(abs, ctx)}/`)
      await rec(abs, 1, '  ')
      return { output: clamp(lines.join('\n')) }
    }
  })

  tools.push({
    name: 'read_file',
    description: '读取文本文件，返回带行号的内容。修改文件前必须先读取。offset 从 1 开始。',
    parameters: schema(
      { path: str('文件路径（相对工作区或绝对路径）'), offset: { type: 'number', description: '起始行，默认 1' }, limit: { type: 'number', description: '最多读取行数，默认 2000' } },
      ['path']
    ),
    readOnly: true,
    assess: (args, ctx) => {
      const { abs, inside } = resolvePath(String(args.path || ''), ctx)
      if (SENSITIVE.test(abs)) return medium('读取可能包含密钥的敏感文件')
      if (!inside) return medium('读取工作区之外的文件')
      return low()
    },
    async execute(args, ctx) {
      const { abs } = resolvePath(String(args.path || ''), ctx)
      let text = await readText(abs)
      let sizeTruncated = false
      if (text.length > MAX_READ_CHARS) {
        text = text.slice(0, MAX_READ_CHARS)
        sizeTruncated = true
      }
      const lines = text.split(/\r?\n/)
      const offset = Math.max(1, Number(args.offset) || 1)
      const limit = Math.min(4000, Math.max(1, Number(args.limit) || 2000))
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      const body = slice.map((line, i) => `${String(offset + i).padStart(5, ' ')}→${line}`).join('\n')
      const tail = sizeTruncated
        ? '\n…（文件过大，仅读取前 16 万字符，可用 offset/limit 精确读取）'
        : offset - 1 + limit < lines.length
          ? '\n…（还有更多内容，可用 offset 继续读取）'
          : ''
      return {
        output: clamp(`文件：${fmtPath(abs, ctx)}（共 ${lines.length} 行）\n${body}${tail}`)
      }
    }
  })

  tools.push({
    name: 'write_file',
    description: '创建或整体覆盖写入文件。目录会自动创建；覆盖前会自动备份。修改已有文件优先用 edit_file。',
    parameters: schema({ path: str('文件路径'), content: str('完整文件内容') }, ['path', 'content']),
    readOnly: false,
    assess: (args, ctx) => {
      const { abs, inside } = resolvePath(String(args.path || ''), ctx)
      if (!ctx.workspaceDir) return high('尚未设置工作区目录')
      if (!inside) return high('写入工作区之外的文件')
      if (SENSITIVE.test(abs)) return high('写入敏感配置文件')
      return medium('写入文件')
    },
    async execute(args, ctx) {
      const { abs, inside } = resolvePath(String(args.path || ''), ctx)
      if (ctx.workspaceDir && !inside && ctx.settings.harness.safety.workspaceOnly && ctx.permissionMode !== 'full') {
        return { output: '安全策略：当前模式只允许写入工作区内的文件。请修改工作区或让用户在弹窗中放行。', isError: true }
      }
      const rawContent = String(args.content ?? '')
      const content = ctx.profile === 'local' ? normalizeLocalFileContent(rawContent, abs) : rawContent
      await fsp.mkdir(join(abs, '..'), { recursive: true })
      let backup: string | null = null
      const existed = await fsp.stat(abs).then((s) => s.isFile()).catch(() => false)
      if (existed && ctx.settings.harness.safety.backupBeforeWrite) {
        backup = await backupFile(abs, ctx)
      }
      await fsp.writeFile(abs, content, 'utf8')
      return {
        output: `${existed ? '已覆盖' : '已创建'} ${fmtPath(abs, ctx)}（${content.split(/\r?\n/).length} 行，${content.length} 字符）${backup ? `\n备份：${backup}` : ''}`
      }
    }
  })

  tools.push({
    name: 'edit_file',
    description: '对文件做精确字符串替换。find 必须在文件中唯一匹配（或设置 replaceAll）。修改前请先 read_file。',
    parameters: schema(
      { path: str('文件路径'), find: str('要被替换的原文（包含足够上下文以唯一匹配）'), replace: str('替换后的文本'), replaceAll: { type: 'boolean', description: '是否替换全部匹配，默认 false' } },
      ['path', 'find', 'replace']
    ),
    readOnly: false,
    assess: (args, ctx) => {
      const { abs, inside } = resolvePath(String(args.path || ''), ctx)
      if (!ctx.workspaceDir) return high('尚未设置工作区目录')
      if (!inside) return high('修改工作区之外的文件')
      if (SENSITIVE.test(abs)) return high('修改敏感配置文件')
      return medium('修改文件')
    },
    async execute(args, ctx) {
      const { abs, inside } = resolvePath(String(args.path || ''), ctx)
      if (ctx.workspaceDir && !inside && ctx.settings.harness.safety.workspaceOnly && ctx.permissionMode !== 'full') {
        return { output: '安全策略：当前模式只允许修改工作区内的文件。', isError: true }
      }
      const findRaw = String(args.find ?? '')
      const replaceRaw = String(args.replace ?? '')
      if (!findRaw) return { output: 'find 不能为空', isError: true }
      const rawText = await readText(abs)
      // 统一按 LF 匹配，写回时再恢复原文件的换行风格，兼容 Windows 下的 CRLF
      const eol = rawText.includes('\r\n') ? '\r\n' : '\n'
      const text = eol === '\r\n' ? rawText.split('\r\n').join('\n') : rawText
      const find = findRaw.replace(/\r\n/g, '\n')
      const replace = replaceRaw.replace(/\r\n/g, '\n')
      let count = text.split(find).length - 1
      let next: string | null = null
      let matchedAt = text.indexOf(find)
      if (count > 0) {
        if (count > 1 && !args.replaceAll) {
          return { output: `匹配到 ${count} 处，请提供更长的上下文，或设置 replaceAll: true。`, isError: true }
        }
        next = args.replaceAll ? text.split(find).join(replace) : text.replace(find, replace)
      } else if (ctx.profile === 'local') {
        // 本地模型常见的缩进/行尾空白偏差：按整行去空白后再匹配一次
        const loose = findLooseBlock(text, find)
        if (loose) {
          count = 1
          matchedAt = loose.start
          next = text.slice(0, loose.start) + replace + text.slice(loose.end)
        }
      }
      if (next === null) {
        return { output: '未找到匹配内容。请先 read_file 确认原文，并把 find 设置为文件中的原文（注意缩进与换行）。', isError: true }
      }
      const written = eol === '\r\n' ? next.split('\n').join('\r\n') : next
      const backup = ctx.settings.harness.safety.backupBeforeWrite ? await backupFile(abs, ctx) : null
      await fsp.writeFile(abs, written, 'utf8')
      const start = Math.max(0, matchedAt - 80)
      const tail = Math.min(text.length, matchedAt + find.length + 80)
      return {
        output: `已修改 ${fmtPath(abs, ctx)}（${count} 处）${backup ? `\n备份：${backup}` : ''}\n变更位置：\n${text.slice(start, tail)}`
      }
    }
  })

  tools.push({
    name: 'glob',
    description: '按通配符查找文件，例如 "src/**/*.tsx"、"**/*.md"。返回相对路径列表。',
    parameters: schema({ pattern: str('glob 模式，如 **/*.ts'), path: str('搜索根目录，默认工作区') }, ['pattern']),
    readOnly: true,
    assess: () => low(),
    async execute(args, ctx, signal) {
      const { abs } = resolvePath(String(args.path || '.'), ctx)
      const pattern = String(args.pattern || '**/*')
      const files = await walk(abs, { maxEntries: 6000, signal })
      const hits = files
        .map((f) => (ctx.workspaceDir && isInside(f, ctx.workspaceDir) ? relative(ctx.workspaceDir, f) : f))
        .filter((f) => matchesGlob(f, pattern))
        .slice(0, 200)
      return { output: hits.length ? hits.join('\n') : '没有匹配的文件' }
    }
  })

  tools.push({
    name: 'grep',
    description: '在文件中搜索正则表达式，返回 文件:行号:内容。适合定位实现位置。',
    parameters: schema(
      { pattern: str('正则表达式'), path: str('搜索目录，默认工作区'), include: str('文件通配符，如 *.ts'), ignoreCase: { type: 'boolean' } },
      ['pattern']
    ),
    readOnly: true,
    assess: () => low(),
    async execute(args, ctx, signal) {
      const { abs } = resolvePath(String(args.path || '.'), ctx)
      let re: RegExp
      try {
        re = new RegExp(String(args.pattern || ''), args.ignoreCase ? 'i' : '')
      } catch (err) {
        return { output: `正则表达式无效：${String(err)}`, isError: true }
      }
      const include = args.include ? String(args.include) : null
      const files = await walk(abs, { maxEntries: 4000, signal })
      const hits: string[] = []
      for (const file of files) {
        if (signal.aborted || hits.length >= 100) break
        if (include && !matchesGlob(file.split(sep).join('/'), include)) continue
        const st = await fsp.stat(file).catch(() => null)
        if (!st || st.size > 1.5 * 1024 * 1024) continue
        const buf = await fsp.readFile(file).catch(() => null)
        if (!buf || isBinary(buf)) continue
        const lines = buf.toString('utf8').split(/\r?\n/)
        for (let i = 0; i < lines.length && hits.length < 100; i++) {
          if (re.test(lines[i])) hits.push(`${fmtPath(file, ctx)}:${i + 1}: ${lines[i].trim().slice(0, 240)}`)
        }
      }
      return { output: hits.length ? clamp(hits.join('\n')) : '没有匹配内容' }
    }
  })

  tools.push({
    name: 'shell',
    description: '在工作区执行 PowerShell 命令（Windows）。用于构建、测试、运行脚本。优先使用只读命令，危险命令会被拦截。',
    parameters: schema({ command: str('要执行的命令'), cwd: str('工作目录（可选，必须在工作区内）') }, ['command']),
    readOnly: false,
    assess: (args, ctx) => shellRisk(String(args.command || ''), ctx),
    async execute(args, ctx, signal) {
      const command = String(args.command || '').trim()
      if (!command) return { output: '命令不能为空', isError: true }
      const cwdArg = args.cwd ? String(args.cwd) : ctx.workspaceDir || process.cwd()
      const { abs, inside } = resolvePath(cwdArg, ctx)
      if (ctx.workspaceDir && ctx.settings.harness.safety.workspaceOnly && !inside && ctx.permissionMode !== 'full') {
        return { output: '安全策略：命令工作目录必须在工作区内。', isError: true }
      }
      const st = await fsp.stat(abs).catch(() => null)
      if (!st?.isDirectory()) return { output: `工作目录不存在：${fmtPath(abs, ctx)}`, isError: true }
      return runShell(command, abs, ctx.settings.harness.safety.shellTimeoutSec, signal)
    }
  })

  tools.push({
    name: 'todo_write',
    description: '维护当前任务的待办清单。多步骤任务开始时创建，执行中更新状态。',
    parameters: schema(
      {
        items: {
          type: 'array',
          description: '待办项',
          items: schema({ content: str('事项'), status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }, ['content', 'status'])
        }
      },
      ['items']
    ),
    readOnly: true,
    assess: () => low(),
    async execute(args) {
      const items = Array.isArray(args.items) ? (args.items as any[]) : []
      const mark: Record<string, string> = { completed: '[x]', in_progress: '[>]', pending: '[ ]' }
      const out = items
        .map((it) => `${mark[String(it.status)] || '[ ]'} ${String(it.content || '')}`)
        .join('\n')
      return { output: out || '（空清单）' }
    }
  })

  tools.push({
    name: 'web_search',
    description: '联网搜索最新信息（DuckDuckGo / Bing）。离线时不可用。',
    parameters: schema({ query: str('搜索关键词') }, ['query']),
    readOnly: true,
    assess: () => medium('访问互联网'),
    async execute(args, _ctx, signal) {
      const query = String(args.query || '').trim()
      if (!query) return { output: 'query 不能为空', isError: true }
      const results = await searchWeb(query, signal)
      return { output: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n') }
    }
  })

  tools.push({
    name: 'web_fetch',
    description: '抓取指定网页并转为纯文本（截断 12000 字符）。只支持 http/https。',
    parameters: schema({ url: str('完整网址') }, ['url']),
    readOnly: true,
    assess: () => medium('访问互联网'),
    async execute(args, _ctx, signal) {
      const raw = String(args.url || '').trim()
      let url: URL
      try {
        url = assertSafeUrl(raw)
      } catch (err) {
        return { output: err instanceof Error ? err.message : '网址不合法', isError: true }
      }
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AIH/0.1)' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(20000)])
      })
      if (!res.ok) return { output: `抓取失败：HTTP ${res.status}`, isError: true }
      const declared = Number(res.headers.get('content-length') || 0)
      if (declared > 5 * 1024 * 1024) {
        return { output: `响应过大（${(declared / 1024 / 1024).toFixed(1)}MB），已拒绝抓取`, isError: true }
      }
      const type = res.headers.get('content-type') || ''
      let body = ''
      if (res.body) {
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let bytes = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.byteLength
          body += decoder.decode(value, { stream: true })
          if (bytes > 2 * 1024 * 1024) {
            await reader.cancel().catch(() => undefined)
            break
          }
          if (signal.aborted) throw new Error('已取消')
        }
        body += decoder.decode()
      } else {
        body = await res.text()
      }
      const text = type.includes('html') ? stripHtml(body) : body
      return { output: text.length > 12000 ? text.slice(0, 12000) + '\n…（已截断）' : text }
    }
  })

  tools.push({
    name: 'knowledge_search',
    description: '搜索当前会话关联的知识库，获取与问题相关的资料片段。',
    parameters: schema({ query: str('要检索的问题或关键词') }, ['query']),
    readOnly: true,
    assess: () => low(),
    async execute(args, ctx) {
      const session = ctx.store.getSession(ctx.sessionId)
      const ids = session?.knowledgeBaseIds?.length ? session.knowledgeBaseIds : ctx.knowledge.list().map((k) => k.id)
      if (!ids.length) return { output: '当前没有可用知识库，请先在「知识库」页面创建或导入资料。' }
      const query = String(args.query || '')
      const hits: string[] = []
      for (const id of ids) {
        const kb = ctx.knowledge.list().find((k) => k.id === id)
        for (const hit of ctx.knowledge.search(id, query, 4)) {
          hits.push(`【${kb?.name || '知识库'}】${hit.title}\n${hit.snippet}`)
        }
      }
      hits.sort()
      return { output: hits.length ? clamp(hits.slice(0, 8).join('\n\n---\n\n')) : '知识库中没有找到相关内容' }
    }
  })

  const map: Record<string, ToolSpec> = {}
  for (const tool of tools) map[tool.name] = tool
  return map
}

async function backupFile(abs: string, ctx: ToolContext): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const rel = ctx.workspaceDir && isInside(abs, ctx.workspaceDir) ? relative(ctx.workspaceDir, abs) : basename(abs)
  const backup = join(ctx.store.dir, 'backups', ctx.sessionId, stamp, rel)
  await fsp.mkdir(join(backup, '..'), { recursive: true })
  await fsp.copyFile(abs, backup)
  return backup
}

/** 将插件工具包装为 ToolSpec；插件工具统一视为联网/第三方操作。 */
export function pluginToolSpecs(plugins: PluginService): ToolSpec[] {
  return plugins.getTools().map((spec) => ({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters || { type: 'object', properties: {} },
    readOnly: false,
    assess: () => medium('调用插件提供的第三方能力'),
    execute: async (args) => {
      const res = await plugins.executeTool(spec.name, args)
      return { output: res.output, isError: !res.ok }
    }
  }))
}

export function toolSchemaOf(tools: Record<string, ToolSpec>): { name: string; description: string; parameters: Record<string, unknown> }[] {
  return Object.values(tools).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
}

export { stripHtml, SENSITIVE, CATASTROPHIC }
