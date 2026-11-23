// 最小 MCP stdio 服务（JSON-RPC 2.0，换行分隔），用于自检 MCP 客户端与白名单启动。
import { createInterface } from 'node:readline'

const rl = createInterface({ input: process.stdin })
const TOOLS = [
  {
    name: 'echo',
    description: '原样返回输入内容',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
  }
]

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n')
}

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    return
  }
  if (message.id === undefined || message.id === null) return
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'aih-fake-mcp', version: '1.0.0' }
      }
    })
    return
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } })
    return
  }
  if (message.method === 'tools/call') {
    const name = message.params?.name
    if (name !== 'echo') {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown tool ${name}` } })
      return
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: String(message.params?.arguments?.text ?? '') }] }
    })
    return
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } })
})
