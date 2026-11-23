import type { BackupPayload, BackupSummary, TrustedDevice } from '../shared/types'
import type { LinkConfig, LinkStatus } from './linkedApi'
import type { NativeAvatar, NativeModel } from './localApi'

export type MobileMode = 'local' | 'linked'

export interface MobileControls {
  mode(): MobileMode
  setMode(mode: MobileMode): Promise<void>
  linkStatus(): LinkStatus
  linkError(): string
  onLinkStatus(listener: (status: LinkStatus) => void): () => void
  linkConfig(): LinkConfig
  setLink(config: LinkConfig): void
  trustedDevices(): Promise<TrustedDevice[]>
  revokeDevice(id: string): Promise<void>
  allowDevice(id: string): Promise<void>
  scanQr(): Promise<string>
  reconnectLink(): void
  models(): Promise<NativeModel[]>
  pickModel(): Promise<NativeModel>
  avatarFiles(): Promise<NativeAvatar[]>
  importBundle(): Promise<BackupSummary>
  exportBundle(): Promise<void>
  importPayload(payload: BackupPayload): Promise<BackupSummary>
  pull(): Promise<BackupSummary>
  push(): Promise<void>
}

declare global {
  interface Window {
    virtuaMobile: MobileControls
  }
}

export {}
