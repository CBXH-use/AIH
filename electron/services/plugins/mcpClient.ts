import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawnMcp, type McpLaunchSpec, type ResolvedCommand } from './mcpGuard'

/** MCP 工具描述，供 Harness 暴露给模型 */
export interface McpToolInfo {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpCallResult {
  ok: boolean
  output: string
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: NodeJS.Timeout
}

interface JsonRpcMessage {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

const PROTOCOL_VERSION = '2024-11-05'
const REQUEST_TIMEOUT_MS = 30_000
const STDERR_LIMIT = 4_000
const STDOUT_BUFFER_LIMIT = 4_000_000

/**
 * 极简 MCP stdio 客户端。
 * 协议为 JSON-RPC 2.0，消息以换行符分隔（不是 LSP 的 Content-Length 头）。
 * 只实现插件广场需要的 initialize / tools/list / tools/call。
 */
export class McpClient {
  readonly name: string
  private readonly spec: McpLaunchSpec
  private readonly resolved: ResolvedCommand
  private child: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<number, PendingRequest>()
  private nextId = 1
  private buffer = ''
  private stderrBuf = ''
  private closed = false
  private connected = false
  private tools: McpToolInfo[] = []

  constructor(name: string, spec: McpLaunchSpec, resolved: ResolvedCommand) {
    this.name = name
    this.spec = spec
    this.resolved = resolved
  }

  /** 启动子进程并完成 initialize 握手 */
  async connect(): Promise<void> {
    if (this.connected) return
    this.closed = false
    this.stderrBuf = ''
    this.buffer = ''

    let child: ChildProcessWithoutNullStreams
    try {
      // 白名单校验通过后才启动；spawnMcp 不使用 shell:true，参数不会被二次解释
      child = spawnMcp(this.spec, this.resolved) as ChildProcessWithoutNullStreams
    } catch (err) {
      throw new Error(`无法启动 MCP 进程：${errorMessage(err)}`)
    }

    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderrBuf = (this.stderrBuf + chunk).slice(-STDERR_LIMIT)
    })
    // 避免未处理的 stdin 错误导致主进程退出
    child.stdin.on('error', () => undefined)

    child.on('error', (err) => {
      this.failAll(new Error(this.withStderr(`启动 MCP 进程失败：${err.message}`)))
    })

    child.on('exit', (code, signal) => {
      if (this.closed) return
      this.closed = true
      this.connected = false
      this.child = null
      this.failAll(
        new Error(
          this.withStderr(
            `MCP 进程已退出（code=${code === null ? 'null' : code}${signal ? `, signal=${signal}` : ''}）`
          )
        )
      )
    })

    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'AIH', version: '0.1.0' }
    })
    this.notify('notifications/initialized', {})
    this.connected = true
  }

  /** 拉取服务端工具列表 */
  async listTools(): Promise<McpToolInfo[]> {
    if (!this.connected) throw new Error('MCP 连接尚未建立')
    const result = await this.request('tools/list', {})
    const raw = result && typeof result === 'object' ? (result as Record<string, unknown>).tools : undefined
    const tools: McpToolInfo[] = []
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (!item || typeof item !== 'object') continue
        const t = item as Record<string, unknown>
        if (typeof t.name !== 'string' || !t.name) continue
        tools.push({
          name: t.name,
          description: typeof t.description === 'string' && t.description ? t.description : t.name,
          inputSchema:
            t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema)
              ? (t.inputSchema as Record<string, unknown>)
              : { type: 'object', properties: {} }
        })
      }
    }
    this.tools = tools
    return tools
  }

  /** 已缓存的工具列表（未 connect 时为空） */
  getToolInfos(): McpToolInfo[] {
    return this.tools
  }

  /** 调用工具并把 MCP content 数组拼成纯文本 */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    if (!this.connected) throw new Error('MCP 连接尚未建立')
    const result = (await this.request('tools/call', { name, arguments: args })) as {
      content?: unknown
      isError?: unknown
      structuredContent?: unknown
    } | null

    const parts: string[] = []
    if (result && Array.isArray(result.content)) {
      for (const item of result.content) {
        if (!item || typeof item !== 'object') {
          parts.push(String(item))
          continue
        }
        const c = item as Record<string, unknown>
        if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text)
        else if (c.type === 'image') parts.push('[图片结果，已省略]')
        else if (typeof c.text === 'string') parts.push(c.text)
        else parts.push(JSON.stringify(c))
      }
    }

    let output = parts.join('\n').trim()
    if (!output && result) output = JSON.stringify(result.structuredContent ?? result)
    if (!output) output = '(MCP 工具没有返回内容)'
    return { ok: result?.isError !== true, output }
  }

  /** 关闭连接并终止子进程 */
  close(): void {
    const child = this.child
    this.closed = true
    this.connected = false
    this.child = null
    this.failAll(new Error('MCP 连接已关闭'))
    if (!child) return
    try {
      child.stdin.end()
    } catch {
      // 忽略已经关闭的管道
    }
    try {
      if (process.platform === 'win32' && child.pid) {
        // shell 模式下 npx 会派生子进程，用 taskkill 终止整棵进程树
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true
        })
      } else {
        child.kill()
      }
    } catch {
      // 进程可能已退出
    }
  }

  private onStdout(chunk: string) {
    this.buffer += chunk
    if (this.buffer.length > STDOUT_BUFFER_LIMIT) this.buffer = ''
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line) this.handleLine(line)
      index = this.buffer.indexOf('\n')
    }
  }

  private handleLine(line: string) {
    let message: JsonRpcMessage
    try {
      message = JSON.parse(line) as JsonRpcMessage
    } catch {
      // 服务端偶尔向 stdout 打日志，直接忽略非 JSON 行
      return
    }
    if (message.id === undefined || message.id === null) return
    const id = typeof message.id === 'number' ? message.id : Number(message.id)
    if (!Number.isInteger(id)) return
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (message.error) {
      pending.reject(new Error(`MCP 错误：${message.error.message ?? '未知错误'}`))
    } else {
      pending.resolve(message.result)
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const child = this.child
    if (!child || this.closed) return Promise.reject(new Error('MCP 连接未建立'))
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP 请求超时（${REQUEST_TIMEOUT_MS / 1000}s）：${method}`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`写入 MCP 请求失败：${errorMessage(err)}`))
      }
    })
  }

  private notify(method: string, params: unknown) {
    const child = this.child
    if (!child || this.closed) return
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    } catch {
      // 通知失败不阻塞主流程
    }
  }

  private failAll(err: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.pending.clear()
  }

  private withStderr(message: string): string {
    const tail = this.stderrBuf.trim()
    if (!tail) return message
    return `${message}：${tail.slice(-600)}`
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
