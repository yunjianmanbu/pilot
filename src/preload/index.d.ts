import type { PilotBridge } from '../shared/types'

declare global {
  interface Window {
    pilot: PilotBridge
  }
}

export {}
