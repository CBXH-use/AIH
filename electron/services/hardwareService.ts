import { execFileSync } from 'child_process'
import { cpus, freemem, totalmem } from 'os'
import type { HardwareInfo } from '@shared/types'

function shell(command: string, timeout = 4000): string | null {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      timeout,
      windowsHide: true
    })
    return out.trim() || null
  } catch {
    return null
  }
}

function detectGpu(): { gpuName?: string; vramGb?: number } {
  try {
    const out = execFileSync(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', timeout: 3500, windowsHide: true }
    )
    const line = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
    if (line) {
      const [name, vram] = line.split(',').map((s) => s.trim())
      const vramGb = Number(vram)
      return { gpuName: name, vramGb: Number.isFinite(vramGb) && vramGb > 0 ? Math.round((vramGb / 1024) * 10) / 10 : undefined }
    }
  } catch {
    /* 没有 nvidia-smi，尝试 WMI */
  }
  const name = shell('(Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty Name)')
  return name ? { gpuName: name } : {}
}

async function comfyOnline(): Promise<boolean> {
  try {
    const res = await fetch('http://127.0.0.1:8188/system_stats', { signal: AbortSignal.timeout(1200) })
    return res.ok
  } catch {
    return false
  }
}

export async function getHardwareInfo(): Promise<HardwareInfo> {
  const totalRamGb = Math.round((totalmem() / 1024 ** 3) * 10) / 10
  const freeRamGb = Math.round((freemem() / 1024 ** 3) * 10) / 10
  const gpu = detectGpu()
  const comfyuiOnline = await comfyOnline()
  const tier: HardwareInfo['tier'] =
    (gpu.vramGb || 0) >= 16 || totalRamGb >= 32 ? 'high' : totalRamGb >= 16 ? 'mid' : 'low'
  return {
    cpu: cpus()[0]?.model?.trim() || 'Unknown CPU',
    totalRamGb,
    freeRamGb,
    gpuName: gpu.gpuName,
    vramGb: gpu.vramGb,
    comfyuiOnline,
    tier
  }
}
