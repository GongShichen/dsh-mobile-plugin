export interface HLNotificationStorage {
  get<T>(key: string): T | undefined
  set<T>(key: string, value: T): void
  delete(key: string): void
  list<T>(prefix: string): Array<{ key: string; value: T }>
  transaction<T>(fn: () => T): T
}
export interface HLNotificationSecrets {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}
export type HLProvider = 'apns' | 'fcm'
export type HLNotificationKind = 'approval' | 'completed' | 'failed' | 'test'
/** Advisory app metadata supplied by an authenticated paired device, not proof of signing authority. */
export interface HLAppDescription {
  deviceId: string
  platform: 'android' | 'ios'
  applicationId: string
  teamId?: string
  environment?: 'sandbox' | 'production'
  updatedAt: number
}
export interface HLNotificationEvent {
  eventId: string
  deviceId?: string
  hostId?: string
  sessionId?: string
  kind: HLNotificationKind
  createdAt?: number
  expiresAt?: number
}
export interface HLPublicFirebaseOptions {
  applicationId: string
  apiKey: string
  projectId: string
  gcmSenderId: string
  storageBucket?: string
}
export type HLProviderConfig = {
  provider: 'apns'; keyId: string; teamId: string; bundleId: string
  environment: 'sandbox' | 'production'; secretRef: string
} | {
  provider: 'fcm'; projectId: string; packageName: string; clientEmail: string
  secretRef: string; publicFirebaseOptions: HLPublicFirebaseOptions
}
export type HLNotificationImport = {
  provider: 'apns'; keyId: string; teamId: string; bundleId: string
  environment: 'sandbox' | 'production'; p8: string
} | {
  provider: 'fcm'; googleServicesJson: string; serviceAccountJson: string; applicationId?: string
}
export interface HLTokenRecord {
  deviceId: string; provider: HLProvider; applicationId: string; environment?: string
  secretRef: string; version: string; updatedAt: number; enabled: boolean
}
export interface HLOutboxRecord {
  id: string; eventId: string; deviceId: string; hostId?: string; sessionId?: string; kind: HLNotificationKind
  provider: HLProvider; tokenVersion: string; createdAt: number; expiresAt: number
  updatedAt: number; nextAttempt: number; attempts: number
  state: 'queued' | 'sending' | 'accepted' | 'received' | 'failed' | 'expired' | 'cancelled'
  error?: string; leaseUntil?: number
}
export interface HLDeliveryResult {
  accepted: boolean; retryable?: boolean; invalidToken?: boolean
  invalidatedAt?: number; code?: string; retryAfterMs?: number
}
export interface HLNotificationSender {
  send(config: HLProviderConfig, privateKey: string, token: string, item: HLOutboxRecord): Promise<HLDeliveryResult>
  dispose?(): void
}
