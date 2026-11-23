import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { net } from 'electron'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AttachmentService } from './attachments'
import { validateMcpSpec } from './plugins/mcpGuard'
import { McpClient } from './plugins/mcpClient'
import { readGgufMeta } from './models/gguf'
import { scoreModelFit } from './models/fit'
import { BUILTIN_PLUGINS } from './plugins/catalog'
import { isSimpleRequest } from './chatEngine'
import { UpdateService } from './updateService'
import { EVAL_TASKS } from '@shared/evalTasks'
import { compareVersions, isNewerVersion, parseChecksums, pickReleaseAssets } from '@shared/update'
import type { HardwareInfo, ModelInfo, Session } from '@shared/types'

export interface SelfTestCheck {
  name: string
  ok: boolean
  detail: string
}

export interface SelfTestResult {
  ok: boolean
  passed: number
  total: number
  checks: SelfTestCheck[]
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(value)
  return b
}

function u64(value: number): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(value))
  return b
}

function ggufString(value: string): Buffer {
  const body = Buffer.from(value, 'utf8')
  return Buffer.concat([u64(body.length), body])
}

function kvString(key: string, value: string): Buffer {
  return Buffer.concat([ggufString(key), u32(8), ggufString(value)])
}

function kvU32(key: string, value: number): Buffer {
  return Buffer.concat([ggufString(key), u32(4), u32(value)])
}

function kvArrayU32(key: string, values: number[]): Buffer {
  return Buffer.concat([
    ggufString(key),
    u32(9),
    u32(4),
    u64(values.length),
    ...values.map((v) => u32(v))
  ])
}

function tensorInfo(name: string, dims: number[]): Buffer {
  return Buffer.concat([
    ggufString(name),
    u32(dims.length),
    ...dims.map((d) => u64(d)),
    u32(0),
    u64(0)
  ])
}

/** 生成一个结构合法的最小 GGUF v3 文件，用于验证元数据解析 */
function buildSyntheticGguf(): Buffer {
  const kvs = Buffer.concat([
    kvString('general.architecture', 'qwen3'),
    kvString('general.name', 'Synthetic Qwen3 Test'),
    kvU32('general.file_type', 15),
    kvU32('qwen3.context_length', 4096),
    kvU32('qwen3.embedding_length', 1024),
    kvU32('qwen3.block_count', 4),
    kvU32('qwen3.attention.head_count', 8),
    kvArrayU32('qwen3.attention.head_count_kv', [2, 2]),
    kvString(
      'tokenizer.chat_template',
      '{% if tools %}{{ tools | tojson }}{% endif %}{% if enable_thinking %}think{% endif %}<|im_start|>'
    )
  ])
  const header = Buffer.concat([
    u32(0x46554747), // GGUF
    u32(3),
    u64(2),
    u64(9)
  ])
  const tensors = Buffer.concat([tensorInfo('blk.0.attn_q.weight', [2, 3]), tensorInfo('token_embd.weight', [4])])
  return Buffer.concat([header, kvs, tensors])
}

function check(checks: SelfTestCheck[], name: string, fn: () => string | null) {
  try {
    const detail = fn()
    checks.push({ name, ok: detail === null, detail: detail || 'ok' })
  } catch (err) {
    checks.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * 主进程自检：不依赖网络与真实模型，验证这次改动里最容易出错的纯逻辑。
 * 用 `AIH.exe --self-test` 或 `electron . --self-test --user-data-dir=<临时目录>` 运行。
 */
export async function runSelfTest(options: { attachments?: AttachmentService } = {}): Promise<SelfTestResult> {
  const checks: SelfTestCheck[] = []
  const temp = mkdtempSync(join(tmpdir(), 'aih-selftest-'))
  try {
    check(checks, 'update.version-compare', () => {
      if (compareVersions('0.1.3', '0.1.2') !== 1) return '0.1.3 应大于 0.1.2'
      if (compareVersions('v0.1.2', '0.1.2') !== 0) return 'v 前缀应被忽略'
      if (isNewerVersion('0.1.2', '0.1.2')) return '相同版本不应判定为更新'
      return null
    })

    check(checks, 'update.checksums', () => {
      const hash = 'a'.repeat(64)
      const sums = parseChecksums(`${hash}  AIH-0.1.3-setup.exe\n${'b'.repeat(64)} *AIH-0.1.3-win-x64.zip\n\r\n`)
      if (sums['AIH-0.1.3-setup.exe'] !== hash) return '安装包哈希解析失败'
      if (sums['AIH-0.1.3-win-x64.zip'] !== 'b'.repeat(64)) return 'zip 哈希解析失败'
      const picked = pickReleaseAssets([
        { name: 'AIH-0.1.3-setup.exe', browser_download_url: 'https://x/setup.exe' },
        { name: 'AIH-0.1.3-win-x64.zip', browser_download_url: 'https://x/a.zip' },
        { name: 'SHA256SUMS.txt', browser_download_url: 'https://x/s.txt' }
      ])
      if (!picked.installer || !picked.portable || !picked.checksums) return '资产识别失败'
      return null
    })

    check(checks, 'mcp.allowlist', () => {
      const good = validateMcpSpec({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] })
      if (!good.ok) return `npx 应被允许：${good.error}`
      const bad = validateMcpSpec({ command: 'powershell', args: ['-Command', 'whoami'] })
      if (bad.ok) return 'powershell 不应被允许'
      const inject = validateMcpSpec({ command: 'npx', args: ['-y', 'pkg', 'a && del C:\\'] })
      if (inject.ok) return 'shell 元字符应被拒绝'
      const path = validateMcpSpec({ command: 'C:\\evil\\npx.exe', args: [] })
      if (path.ok) return '路径形式命令应被拒绝'
      const env = validateMcpSpec({ command: 'npx', args: ['-y', 'pkg'], env: { PATH: 'C:\\evil' } })
      if (env.ok) return '不应允许覆盖 PATH'
      return null
    })

    check(checks, 'mcp.resolve-without-shell', () => {
      const result = validateMcpSpec({ command: 'npx', args: ['--version'] })
      if (!result.ok || !result.resolved) return `npx 解析失败：${result.error}`
      if (typeof result.hash !== 'string' || result.hash.length !== 64) return '缺少命令指纹'
      if (/\.cmd$/i.test(result.resolved.exe)) return 'npx 仍会经由 .cmd（应解析到 node.exe）'
      return null
    })

    check(checks, 'gguf.parse-metadata', () => {
      const file = join(temp, 'synthetic.gguf')
      writeFileSync(file, buildSyntheticGguf())
      const meta = readGgufMeta(file)
      if (!meta) return '解析返回 null'
      if (meta.contextLength !== 4096) return `contextLength=${meta.contextLength}（应为 4096）`
      if (meta.blockCount !== 4) return `blockCount=${meta.blockCount}`
      if (meta.headCountKv !== 2) return `headCountKv=${meta.headCountKv}（数组应取均值 2）`
      if (meta.quantization !== 'Q4_K_M') return `量化=${meta.quantization}（应为 Q4_K_M）`
      if (meta.parameterCount !== 10) return `参数量=${meta.parameterCount}（2*3+4=10）`
      if (meta.supportsTools !== true) return 'chat template 里的 tools 未识别'
      if (meta.supportsThinking !== true) return 'chat template 里的 think 未识别'
      if (!meta.hasChatTemplate) return 'chat template 未标记'
      return null
    })

    check(checks, 'gguf.reject-non-gguf', () => {
      const file = join(temp, 'not-a-model.bin')
      writeFileSync(file, Buffer.from('this is definitely not a gguf file, just some bytes...'))
      if (readGgufMeta(file) !== null) return '非 GGUF 文件应返回 null'
      return null
    })

    const attachments = new AttachmentService(join(temp, 'attachments'))
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const saved = await attachments.save(png, 'dot.png').catch(() => null)
    const savedAgain = await attachments.save(png, 'dot.png').catch(() => null)
    check(checks, 'attachments.save-dedupe', () => {
      if (!saved) return '保存失败'
      if (!savedAgain || savedAgain.file !== saved.file) return '相同内容没有复用同一个文件'
      return null
    })
    check(checks, 'attachments.path-guard', () => {
      if (!saved) return '保存失败'
      if (!attachments.resolve(saved.file)) return '按相对路径找不到文件'
      if (attachments.resolve('../outside.png')) return '路径穿越未被阻止'
      return null
    })
    check(checks, 'attachments.roundtrip', () => {
      if (!saved) return '保存失败'
      const back = attachments.dataUrlOf(saved.file)
      if (back !== png) return '读回的 dataUrl 与原图不一致'
      return null
    })
    const legacySession: Session = {
      id: 's1',
      title: 't',
      projectId: 'default',
      agentId: 'general',
      model: null,
      permissionMode: 'ask',
      messages: [
        {
          id: 'm1',
          role: 'user',
          parts: [{ type: 'image', dataUrl: png, name: 'dot.png' }],
          createdAt: Date.now()
        }
      ],
      workspaceDir: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'idle',
      tokenUsage: { input: 0, output: 0, compressed: 0 },
      knowledgeBaseIds: []
    }
    const migrated = await attachments.migrateInlineImages([legacySession]).catch(() => -1)
    check(checks, 'attachments.migrate-inline', () => {
      if (migrated !== 1) return `迁移数量 ${migrated}（应为 1）`
      const part = legacySession.messages[0].parts[0]
      if (part.type !== 'image') return '图片 part 丢失'
      if (!part.file) return '迁移后没有写入 file 路径'
      if (part.dataUrl) return '迁移后仍保留内联 dataUrl'
      if (attachments.stats().count < 1) return '附件统计不可用'
      return null
    })

    // 自定义协议：渲染层 <img src="aih-attachment://..."> 必须能取到真实字节
    if (options.attachments) {
      const real = options.attachments
      const savedReal = await real.save(png, 'protocol.png').catch(() => null)
      try {
        const response = savedReal ? await net.fetch(real.urlOf(savedReal.file)) : null
        const bytes = response ? Buffer.from(await response.arrayBuffer()) : Buffer.alloc(0)
        const expected = Buffer.from(png.split(',')[1], 'base64')
        check(checks, 'attachments.protocol-serve', () => {
          if (!savedReal) return '保存失败'
          if (!response || !response.ok) return `协议请求失败：${response ? response.status : 'no response'}`
          if (!bytes.equals(expected)) return '协议返回的字节与图片不一致'
          if (response.headers.get('content-type') !== 'image/png') return 'Content-Type 不是 image/png'
          return null
        })
      } catch (err) {
        checks.push({ name: 'attachments.protocol-serve', ok: false, detail: String(err) })
      }
    }

    check(checks, 'fit.score', () => {
      const model: ModelInfo = {
        id: 'runtime::big',
        remoteId: 'big',
        providerId: 'aih-runtime',
        providerKind: 'llamacpp',
        name: 'big',
        sizeBytes: 5 * 1024 ** 3,
        contextLength: 8192,
        gguf: {
          version: 3,
          architecture: 'qwen3',
          contextLength: 8192,
          blockCount: 32,
          headCount: 32,
          headCountKv: 8,
          embeddingLength: 4096,
          tensorCount: 100,
          kvCount: 20,
          hasChatTemplate: true,
          supportsThinking: true,
          sizeBytes: 5 * 1024 ** 3
        },
        status: 'ready'
      }
      const lowEnd: HardwareInfo = { cpu: 'x', totalRamGb: 8, freeRamGb: 4, tier: 'low' }
      const highEnd: HardwareInfo = { cpu: 'x', totalRamGb: 32, freeRamGb: 24, tier: 'high' }
      const heavy = scoreModelFit(model, lowEnd)
      const great = scoreModelFit(model, highEnd)
      if (heavy.level !== 'heavy') return `8GB 内存应判为 heavy，实际 ${heavy.level}`
      if (great.level !== 'great') return `32GB 内存应判为 great，实际 ${great.level}`
      if (!(heavy.kvCacheGb > 0)) return 'KV cache 估算为 0'
      return null
    })

    check(checks, 'chat.adaptive-thinking-heuristic', () => {
      if (!isSimpleRequest('你好，介绍一下你自己', 60)) return '短问答应被判定为简单任务'
      if (isSimpleRequest('帮我创建 hello.txt 并运行测试', 60)) return '含动作词的请求不应跳过思考'
      if (isSimpleRequest('```ts\nconst a = 1\n```', 60)) return '含代码块的请求不应跳过思考'
      return null
    })

    check(checks, 'eval.tasks', () => {
      if (EVAL_TASKS.length !== 20) return `任务数 ${EVAL_TASKS.length}（应为 20）`
      const ids = new Set(EVAL_TASKS.map((t) => t.id))
      if (ids.size !== EVAL_TASKS.length) return '任务 id 重复'
      if (EVAL_TASKS.some((t) => typeof t.validate !== 'function')) return '缺少校验函数'
      return null
    })

    check(checks, 'plugins.builtin-mcp-valid', () => {
      const mcpPlugins = BUILTIN_PLUGINS.filter((p) => p.installType === 'mcp')
      if (!mcpPlugins.length) return '内置目录里没有 MCP 插件'
      for (const plugin of mcpPlugins) {
        const result = validateMcpSpec({ command: plugin.mcp?.command || '', args: plugin.mcp?.args || [] })
        if (!result.ok) return `${plugin.id}: ${result.error}`
      }
      return null
    })

    // MCP 端到端：用 node 启动一个假的 MCP 服务，验证「无 shell 启动 + 握手 + 工具调用」
    const fakeMcp = join(process.cwd(), 'scripts', 'fake-mcp-server.mjs')
    if (existsSync(fakeMcp)) {
      const spec = validateMcpSpec({ command: 'node', args: [fakeMcp] })
      if (!spec.ok || !spec.resolved) {
        checks.push({ name: 'mcp.spawn-and-call', ok: false, detail: spec.error || '命令未通过校验' })
      } else {
        const client = new McpClient('selftest', { command: 'node', args: [fakeMcp] }, spec.resolved)
        try {
          await client.connect()
          const tools = await client.listTools()
          const result = await client.callTool('echo', { text: 'ping' })
          check(checks, 'mcp.spawn-and-call', () => {
            if (!tools.some((t) => t.name === 'echo')) return 'tools/list 没有返回 echo'
            if (!result.ok || result.output !== 'ping') return `tools/call 返回异常：${result.output}`
            return null
          })
        } catch (err) {
          checks.push({
            name: 'mcp.spawn-and-call',
            ok: false,
            detail: err instanceof Error ? err.message : String(err)
          })
        } finally {
          client.close()
        }
      }
    }

    // 更新流程端到端：本地 mock GitHub Release + 校验文件，验证下载与 SHA-256 校验
    const installerBytes = Buffer.from('MZ fake installer for self-test\n'.repeat(200), 'utf8')
    const installerHash = createHash('sha256').update(installerBytes).digest('hex')
    let corruptChecksum = false
    const updateServer = createServer((req, res) => {
      const port = (updateServer.address() as AddressInfo).port
      const base = `http://127.0.0.1:${port}`
      if (req.url === '/repos/CBXH-use/AIH/releases/latest') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            tag_name: 'v9.9.9',
            html_url: 'https://example.com/release',
            body: 'self-test release',
            assets: [
              {
                name: 'AIH-9.9.9-setup.exe',
                browser_download_url: `${base}/AIH-9.9.9-setup.exe`,
                size: installerBytes.length
              },
              { name: 'AIH-9.9.9-win-x64.zip', browser_download_url: `${base}/AIH-9.9.9-win-x64.zip`, size: 1234 },
              { name: 'SHA256SUMS.txt', browser_download_url: `${base}/SHA256SUMS.txt` }
            ]
          })
        )
        return
      }
      if (req.url === '/AIH-9.9.9-setup.exe') {
        res.writeHead(200, { 'Content-Length': String(installerBytes.length) })
        res.end(installerBytes)
        return
      }
      if (req.url === '/SHA256SUMS.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end(`${corruptChecksum ? 'c'.repeat(64) : installerHash}  AIH-9.9.9-setup.exe\n`)
        return
      }
      res.writeHead(404).end('not found')
    })
    await new Promise<void>((resolve) => updateServer.listen(0, '127.0.0.1', () => resolve()))
    try {
      const port = (updateServer.address() as AddressInfo).port
      const apiBase = `http://127.0.0.1:${port}`
      const service = new UpdateService({
        userDataDir: join(temp, 'updates-ok'),
        currentVersion: '0.1.2',
        apiBase,
        emit: () => undefined,
        quit: () => undefined
      })
      const checked = await service.check(true)
      check(checks, 'update.check-release', () => {
        if (!checked.ok || !checked.data) return checked.error || '检查更新失败'
        if (!checked.data.hasUpdate) return '没有识别出新版本 9.9.9'
        if (!checked.data.canAutoInstall) return '应支持应用内自动安装'
        return null
      })
      const downloaded = await service.download()
      check(checks, 'update.download-and-verify', () => {
        if (!downloaded.ok || !downloaded.data) return downloaded.error || '下载失败'
        if (!existsSync(downloaded.data.path)) return '下载文件不存在'
        const actual = createHash('sha256').update(readFileSync(downloaded.data.path)).digest('hex')
        if (actual !== installerHash) return '下载文件哈希不一致'
        return null
      })

      corruptChecksum = true
      const bad = new UpdateService({
        userDataDir: join(temp, 'updates-bad'),
        currentVersion: '0.1.2',
        apiBase,
        emit: () => undefined,
        quit: () => undefined
      })
      const badCheck = await bad.check(true)
      const badDownload = await bad.download()
      check(checks, 'update.reject-bad-checksum', () => {
        if (!badCheck.ok) return badCheck.error || '检查更新失败'
        if (badDownload.ok) return '错误校验值却下载成功'
        return null
      })
    } finally {
      updateServer.close()
    }
  } finally {
    try {
      rmSync(temp, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }

  const passed = checks.filter((c) => c.ok).length
  return { ok: passed === checks.length, passed, total: checks.length, checks }
}
