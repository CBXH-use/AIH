/** 更新相关的纯函数，主进程与自检脚本共用（不依赖 electron，方便单独验证） */

export interface ReleaseAssetLike {
  name?: string
  browser_download_url?: string
  size?: number
}

export interface PickedAssets {
  installer?: ReleaseAssetLike
  portable?: ReleaseAssetLike
  checksums?: ReleaseAssetLike
}

export function parseVersion(version: string): number[] {
  return String(version || '')
    .trim()
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map((part) => Number(part) || 0)
}

/** 语义化版本比较（忽略预发布后缀的细节，只比较主版本号） */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let i = 0; i < Math.max(left.length, right.length, 3); i++) {
    const x = left[i] || 0
    const y = right[i] || 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

export function isNewerVersion(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0
}

/** 解析 SHA256SUMS.txt：`<hash>  <file>`，兼容多余的空白与 CRLF */
export function parseChecksums(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$/.exec(line.trim())
    if (!match) continue
    out[match[2]] = match[1].toLowerCase()
  }
  return out
}

/** 从 Release 资产里挑出安装包、便携包与校验文件 */
export function pickReleaseAssets(assets: ReleaseAssetLike[] | undefined): PickedAssets {
  const list = Array.isArray(assets) ? assets.filter((a) => a && a.name) : []
  const byName = (re: RegExp) => list.find((a) => re.test(a.name || ''))
  return {
    installer: byName(/^AIH-.*-setup\.exe$/i),
    portable: byName(/^AIH-.*-win-(x64|arm64)\.zip$/i),
    checksums: byName(/^SHA256SUMS\.txt$/i)
  }
}

/** 只允许 http(s) 下载地址，避免 Release 数据被篡改后执行本地文件 */
export function isSafeDownloadUrl(url: string): boolean {
  try {
    const parsed = new URL(String(url))
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}
