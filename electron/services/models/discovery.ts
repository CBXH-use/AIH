import { execFileSync } from 'child_process'
import { existsSync, statfsSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { app } from 'electron'
import type { ModelInfo } from '@shared/types'
import { promises as fsp } from 'fs'

/**
 * 本地模型发现：不依赖 Ollama 服务是否运行，直接查看磁盘。
 * 支持 Ollama 安装在非 C 盘、模型目录被移动到其他盘，以及散落的 GGUF 文件。
 */

const DRIVE_LETTERS = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

export function fixedDrives(): string[] {
  return DRIVE_LETTERS.map((letter) => `${letter}:\\`).filter((drive) => {
    try {
      return existsSync(drive)
    } catch {
      return false
    }
  })
}

function expandEnv(value: string): string {
  return value
    .trim()
    .replace(/^"|"$/g, '')
    .replace(/%([^%]+)%/g, (_, key: string) => process.env[key] || '')
}

function registryOllamaDirs(): string[] {
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
  ]
  const dirs: string[] = []
  for (const root of roots) {
    try {
      const out = execFileSync('reg.exe', ['query', root, '/s', '/f', 'Ollama', '/d'], {
        encoding: 'utf8',
        timeout: 4000,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024
      })
      for (const line of out.split(/\r?\n/)) {
        if (!/REG_(SZ|EXPAND_SZ)/.test(line)) continue
        const value = expandEnv(line.split(/REG_(?:SZ|EXPAND_SZ)/)[1] || '')
        if (!value) continue
        const dir = /\.exe$/i.test(value) ? dirname(value) : value
        if (existsSync(join(dir, 'ollama.exe'))) dirs.push(dir)
      }
    } catch {
      /* 注册表不存在或查询超时，继续用常见路径 */
    }
  }
  return dirs
}

const BINARY_SUBPATHS = [
  'ollama.exe',
  join('Programs', 'Ollama', 'ollama.exe'),
  join('Program Files', 'Ollama', 'ollama.exe'),
  join('Program Files (x86)', 'Ollama', 'ollama.exe'),
  join('Ollama', 'ollama.exe'),
  join('Apps', 'Ollama', 'ollama.exe'),
  join('Software', 'Ollama', 'ollama.exe'),
  join('tools', 'Ollama', 'ollama.exe'),
  join('AI', 'Ollama', 'ollama.exe'),
  join('LLM', 'Ollama', 'ollama.exe')
]

let binaryCache: { at: number; value: string | null } | null = null

/** 返回任意盘符上的 ollama.exe；找不到返回 null。结果缓存 60 秒。 */
export function findOllamaBinary(): string | null {
  const now = Date.now()
  if (binaryCache && now - binaryCache.at < 60_000) return binaryCache.value

  const candidates: string[] = []
  try {
    const out = execFileSync('where.exe', ['ollama'], { encoding: 'utf8', timeout: 3000, windowsHide: true })
    candidates.push(...out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
  } catch {
    /* 不在 PATH 中 */
  }

  candidates.push(
    join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
    join(process.env.APPDATA || '', 'Ollama', 'ollama.exe'),
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Ollama', 'ollama.exe'),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Ollama', 'ollama.exe'),
    join(homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe')
  )
  if (process.env.OLLAMA_INSTALL_DIR) candidates.push(join(process.env.OLLAMA_INSTALL_DIR, 'ollama.exe'))
  if (process.env.OLLAMA_HOME) candidates.push(join(process.env.OLLAMA_HOME, 'ollama.exe'))

  for (const base of registryOllamaDirs()) candidates.push(join(base, 'ollama.exe'))

  // Ollama 被装在 D/E 盘任意常见目录时也能找到
  for (const drive of fixedDrives()) {
    for (const sub of BINARY_SUBPATHS) candidates.push(join(drive, sub))
  }

  const found = candidates.find((p) => {
    try {
      return !!p && existsSync(p)
    } catch {
      return false
    }
  }) || null
  binaryCache = { at: now, value: found }
  return found
}

function looksLikeOllamaModelsDir(dir: string): boolean {
  try {
    return existsSync(join(dir, 'manifests')) && existsSync(join(dir, 'blobs'))
  } catch {
    return false
  }
}

const MODELS_SUBPATHS = [
  join('ollama', 'models'),
  join('Ollama', 'models'),
  join('models', 'ollama'),
  join('models', 'Ollama'),
  join('AI', 'ollama', 'models'),
  join('AI', 'Ollama', 'models'),
  join('LLM', 'ollama', 'models'),
  join('.ollama', 'models'),
  join('ProgramData', 'ollama', 'models')
]

/** 找出所有可能的 Ollama 模型目录（含环境变量、安装目录旁、其他盘）。 */
export function findOllamaModelDirs(binary?: string | null): string[] {
  const dirs: string[] = []
  const push = (dir?: string) => {
    if (!dir) return
    const normalized = dir.trim().replace(/[\\/]+$/, '')
    if (normalized && looksLikeOllamaModelsDir(normalized) && !dirs.includes(normalized)) dirs.push(normalized)
  }

  push(process.env.OLLAMA_MODELS)
  push(join(homedir(), '.ollama', 'models'))
  if (binary) {
    push(join(dirname(binary), 'models'))
    push(join(dirname(binary), '..', 'models'))
  }
  for (const drive of fixedDrives()) {
    for (const sub of MODELS_SUBPATHS) push(join(drive, sub))
  }
  return dirs
}

/** AIH 自己的模型目录：优先设置值，否则选剩余空间最大的磁盘。 */
export function resolveAihModelsDir(configured?: string): string {
  if (configured?.trim()) return configured.trim()

  let best: { dir: string; free: number } | null = null
  for (const drive of fixedDrives()) {
    try {
      const stat = statfsSync(drive)
      const free = Number(stat.bavail) * Number(stat.bsize)
      if (!best || free > best.free) best = { dir: drive, free }
    } catch {
      /* 忽略无法读取的盘符 */
    }
  }

  if (!best) return join(homedir(), 'AIH Models')
  if (/^c:/i.test(best.dir)) return join(app.getPath('documents'), 'AIH Models')
  return join(best.dir, 'AIH Models')
}

export function isModelFileName(name: string): boolean {
  return /\.gguf$/i.test(name)
}

interface OllamaLayer {
  mediaType?: string
  digest?: string
  size?: number
}

interface OllamaManifest {
  layers?: OllamaLayer[]
  config?: { digest?: string; size?: number }
}

interface OllamaModelConfig {
  model_family?: string
  model_families?: string[]
  model_type?: string
  file_type?: string
  quantization_level?: string
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

function blobPath(modelsDir: string, digest?: string): string | null {
  if (!digest?.startsWith('sha256:')) return null
  return join(modelsDir, 'blobs', `sha256-${digest.slice('sha256:'.length)}`)
}

/**
 * 直接读取 Ollama 的 manifests/blobs，列出模型。
 * 不要求 Ollama 正在运行，也不要求安装在 C 盘。
 */
export async function listOllamaDiskModels(modelsDir: string): Promise<ModelInfo[]> {
  const manifestRoot = join(modelsDir, 'manifests')
  const models: ModelInfo[] = []
  const seen = new Set<string>()

  const walk = async (dir: string, parts: string[], depth: number): Promise<void> => {
    if (models.length >= 200 || depth > 4) return
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (models.length >= 200) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue
        await walk(full, [...parts, entry.name], depth + 1)
        continue
      }
      if (parts.length < 3) continue
      const manifest = await readJson<OllamaManifest>(full)
      if (!manifest) continue

      // manifests/<registry>/<namespace>/<model>/<tag>
      const tag = entry.name
      const model = parts[parts.length - 1]
      const namespace = parts[parts.length - 2]
      if (!namespace || !model || !tag) continue
      const name = namespace === 'library' ? `${model}:${tag}` : `${namespace}/${model}:${tag}`
      if (seen.has(name)) continue
      seen.add(name)

      let size = 0
      for (const layer of manifest.layers || []) {
        if (layer?.mediaType === 'application/vnd.ollama.image.model' && typeof layer.size === 'number') size = layer.size
        else if (!size && typeof layer?.size === 'number') size += layer.size
      }

      let family: string | undefined
      let parameterSize: string | undefined
      let quantization: string | undefined
      const cfgPath = blobPath(modelsDir, manifest.config?.digest)
      if (cfgPath && existsSync(cfgPath)) {
        const cfg = await readJson<OllamaModelConfig>(cfgPath)
        family = cfg?.model_family || cfg?.model_families?.[0]
        parameterSize = cfg?.model_type
        quantization = cfg?.quantization_level || cfg?.file_type
      }

      models.push({
        id: `ollama::${name}`,
        remoteId: name,
        providerId: 'ollama',
        providerKind: 'ollama',
        name,
        family,
        parameterSize,
        quantization,
        sizeBytes: size || undefined,
        status: 'ready'
      })
    }
  }

  await walk(manifestRoot, [], 0)
  return models
}

/** 读取 GGUF 文件名里的参数量/量化信息，尽量让列表更可读。 */
export function guessGgufMeta(fileName: string): { parameterSize?: string; quantization?: string } {
  const base = fileName.replace(/\.gguf$/i, '')
  const quant = base.match(/(IQ\d+[A-Z_]*|Q\d+[A-Z_]*|F16|BF16|F32)/i)?.[1]
  const params = base.match(/(\d+(?:\.\d+)?B)/i)?.[1]
  return {
    parameterSize: params?.toUpperCase(),
    quantization: quant?.toUpperCase()
  }
}
