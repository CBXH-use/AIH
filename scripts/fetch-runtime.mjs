import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

/**
 * 下载随安装包分发的 llama.cpp 运行时。
 * 仓库不提交 25MB 二进制文件；本地构建或 GitHub Actions 在打包前执行本脚本。
 */
const BUILD = 'b12359'
const ZIP = `llama-${BUILD}-bin-win-cpu-x64.zip`
const SHA256 = '837c1655e87df3b66989f4be33a792a1399c785bf259038dc75c900096683e69'
const GH = `https://github.com/ggml-org/llama.cpp/releases/download/${BUILD}/${ZIP}`
const URLS = [
  GH,
  `https://gh-proxy.com/${GH}`,
  `https://ghfast.top/${GH}`,
  `https://ghproxy.net/${GH}`
]

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dest = join(root, 'build', 'runtime', ZIP)

async function fileSha256(path) {
  const { createReadStream } = await import('node:fs')
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })
}

async function alreadyValid() {
  try {
    await stat(dest)
    return (await fileSha256(dest)) === SHA256
  } catch {
    return false
  }
}

async function download(url) {
  const tmp = `${dest}.part`
  const controller = new AbortController()
  let idle = null
  const touch = () => {
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => controller.abort(), 45000)
  }
  try {
    touch()
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    const total = Number(res.headers.get('content-length')) || 0
    const hash = createHash('sha256')
    const out = createWriteStream(tmp)
    let received = 0
    let lastReport = 0
    for await (const chunk of Readable.fromWeb(res.body)) {
      touch()
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', () => resolve()))
      hash.update(chunk)
      received += chunk.length
      const now = Date.now()
      if (now - lastReport > 1500) {
        lastReport = now
        const mb = (received / 1024 / 1024).toFixed(1)
        const of = total ? ` / ${(total / 1024 / 1024).toFixed(1)} MB` : ''
        process.stdout.write(`\r下载运行时 ${mb} MB${of}`)
      }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())))
    process.stdout.write('\n')
    const digest = hash.digest('hex')
    if (digest !== SHA256) throw new Error('SHA-256 校验失败')
    await rename(tmp, dest)
  } catch (err) {
    await unlink(tmp).catch(() => undefined)
    throw err
  } finally {
    if (idle) clearTimeout(idle)
  }
}

if (await alreadyValid()) {
  console.log(`运行时已存在：${dest}`)
  process.exit(0)
}

await mkdir(dirname(dest), { recursive: true })
let lastError = null
for (const url of URLS) {
  try {
    console.log(`尝试下载：${url}`)
    await download(url)
    console.log(`运行时已就绪：${dest}`)
    process.exit(0)
  } catch (err) {
    lastError = err
    console.warn(`下载失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

console.error(`无法下载内置运行时，请检查网络后重试。${lastError ? `\n${String(lastError)}` : ''}`)
process.exit(1)
