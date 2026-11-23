// 本地 mock LLM：OpenAI 兼容 + 按任务脚本返回工具调用，用于端到端验证评测与工具协议降级。
// 用法：node scripts/mock-llm.mjs [port]
import { createServer } from 'node:http'

const PORT = Number(process.argv[2] || 18999)

function textOf(message) {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) {
    return message.content
      .filter((p) => p && p.type === 'text')
      .map((p) => p.text)
      .join('\n')
  }
  return ''
}

function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return textOf(messages[i])
  }
  return ''
}

/** 已经发生过多少次工具调用/工具结果，用来决定下一步 */
function stepOf(messages) {
  return messages.filter(
    (m) =>
      (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) ||
      (m.role === 'user' && /^\[工具 /.test(textOf(m)))
  ).length
}

function toolCall(name, args, id = 'call_1') {
  return { name, arguments: args, id }
}

/** 每个任务需要执行的动作序列（原生工具模式） */
function planFor(prompt) {
  const p = prompt
  if (/hello\.txt/i.test(p)) return [toolCall('write_file', { path: 'hello.txt', content: 'Hello AIH\n' }), '已完成']
  if (/src\/utils\/math\.ts/i.test(p))
    return [toolCall('write_file', { path: 'src/utils/math.ts', content: 'export function add(a, b) {\n  return a + b\n}\n' }), '已创建']
  if (/API_BASE/.test(p))
    return [
      toolCall('read_file', { path: 'src/config.ts' }),
      toolCall('edit_file', {
        path: 'src/config.ts',
        find: "'http://old.local'",
        replace: "'https://new.local'"
      }),
      '已修改 API_BASE'
    ]
  if (/package\.json/.test(p) && /2\.0\.0/.test(p))
    return [
      toolCall('read_file', { path: 'package.json' }),
      toolCall('edit_file', {
        path: 'package.json',
        find: '"version": "1.0.0"',
        replace: '"version": "2.0.0"'
      }),
      '已把 version 改成 2.0.0'
    ]
  if (/notes\.md/.test(p)) return [toolCall('read_file', { path: 'notes.md' }), 'SQLite']
  if (/列出工作区根目录/.test(p)) return [toolCall('list_dir', { path: '.' }), 'a.md、b.txt']
  if (/包含 TODO/.test(p)) return [toolCall('grep', { pattern: 'TODO', path: '.' }), 'src/a.ts 包含 TODO']
  if (/所有 \.ts 文件/.test(p)) return [toolCall('glob', { pattern: '**/*.ts' }), 'src/x.ts、src/y.ts']
  if (/echo aih-eval-ok/.test(p)) return [toolCall('shell', { command: 'echo aih-eval-ok' }), '输出是 aih-eval-ok']
  if (/创建目录 build\/out/.test(p))
    return [toolCall('shell', { command: 'New-Item -ItemType Directory -Force -Path build/out | Out-Null' }), '目录已创建']
  if (/README\.md/.test(p) && /index\.js/.test(p))
    return [
      toolCall('write_file', { path: 'README.md', content: '# Demo\n' }),
      toolCall('write_file', { path: 'index.js', content: "console.log('hi')\n" }),
      '已创建两个文件'
    ]
  if (/data\.csv/.test(p))
    return [
      toolCall('read_file', { path: 'data.csv' }),
      toolCall('edit_file', { path: 'data.csv', find: 'b,2', replace: 'b,2\nc,3' }),
      '已追加 c,3'
    ]
  if (/old-name\.txt/.test(p))
    return [toolCall('shell', { command: 'Move-Item -Force old-name.txt new-name.txt' }), '已重命名']
  if (/删除 temp\.txt/.test(p)) return [toolCall('shell', { command: 'Remove-Item -Force temp.txt' }), '已删除']
  if (/删除 protected\.txt/.test(p))
    return [toolCall('shell', { command: 'Remove-Item -Force protected.txt' }), '只读模式，已阻止删除']
  if (/60% 是女生/.test(p)) return ['24']
  if (/总结 long\.md/.test(p)) return [toolCall('read_file', { path: 'long.md' }), 'AIH 是本地 AI 工作台']
  if (/index\.html/.test(p))
    return [
      toolCall('write_file', {
        path: 'index.html',
        content: '<!doctype html>\n<html>\n<body>\n<h1>AIH</h1>\n</body>\n</html>\n'
      }),
      '已创建 index.html'
    ]
  if (/greet 的返回值/.test(p))
    return [
      toolCall('read_file', { path: 'src/app.js' }),
      toolCall('edit_file', { path: 'src/app.js', find: "return 'hi'", replace: "return 'hello'" }),
      '已改成 hello'
    ]
  return ['你好，我是 AIH 助手。']
}

/** 文本协议（模型不支持原生工具时）返回内容 */
function promptProtocolFor(prompt) {
  const p = prompt
  if (/hello\.txt/i.test(p)) {
    return '<aih_write path="hello.txt">Hello AIH\n</aih_write>'
  }
  if (/src\/utils\/math\.ts/i.test(p)) {
    return '<aih_write path="src/utils/math.ts">export function add(a, b) {\n  return a + b\n}\n</aih_write>'
  }
  if (/README\.md/.test(p) && /index\.js/.test(p)) {
    return '```json\n{"tool":"write_file","arguments":{"path":"README.md","content":"# Demo\\n"}}\n```'
  }
  if (/API_BASE/.test(p)) {
    return '```json\n{"tool":"read_file","arguments":{"path":"src/config.ts"}}\n```'
  }
  return null
}

function sseChunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function sendText(res, text, usage) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  res.write(sseChunk({ choices: [{ index: 0, delta: { role: 'assistant', content: text } }] }))
  res.write(sseChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }))
  res.write('data: [DONE]\n\n')
  res.end()
}

function sendToolCall(res, call, usage) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  res.write(
    sseChunk({
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.arguments) }
              }
            ]
          }
        }
      ]
    })
  )
  res.write(sseChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage }))
  res.write('data: [DONE]\n\n')
  res.end()
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'mock' }, { id: 'mock-prompt' }] }))
    return
  }
  if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
    res.writeHead(404).end('not found')
    return
  }
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    let payload = {}
    try {
      payload = JSON.parse(body)
    } catch {
      res.writeHead(400).end('bad json')
      return
    }
    const messages = Array.isArray(payload.messages) ? payload.messages : []
    const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0
    const model = String(payload.model || 'mock')
    // mock-prompt：模拟不支持原生工具的模型，强制走文本协议降级
    if (model.includes('prompt') && hasTools) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'tools are not supported by this model' } }))
      return
    }
    const prompt = lastUser(messages)
    const step = stepOf(messages)
    const usage = { prompt_tokens: 120, completion_tokens: 24, total_tokens: 144 }

    if (!hasTools) {
      const scripted = promptProtocolFor(prompt)
      const plan = planFor(prompt)
      if (step === 0 && scripted) {
        sendText(res, scripted, usage)
        return
      }
      if (step >= 1) {
        const final = typeof plan[plan.length - 1] === 'string' ? plan[plan.length - 1] : '已完成'
        sendText(res, final, usage)
        return
      }
      sendText(res, typeof plan[0] === 'string' ? plan[0] : '已完成', usage)
      return
    }

    const plan = planFor(prompt)
    const action = plan[step]
    if (!action || typeof action === 'string') {
      sendText(res, typeof action === 'string' ? action : '已完成', usage)
      return
    }
    sendToolCall(res, action, usage)
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-llm] listening on http://127.0.0.1:${PORT}/v1`)
})
