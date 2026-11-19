import type { AihApi } from '@shared/ipc'

declare global {
  interface Window {
    aih: AihApi
    __AIH_BROWSER__?: boolean
  }
}

export {}
