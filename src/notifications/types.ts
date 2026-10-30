export interface NotificationStorage {
  get<T>(key: string): T | undefined
  set<T>(key: string, value: T): void
  delete(key: string): void
  list<T>(prefix: string): Array<{ key: string; value: T }>
  transaction<T>(fn: () => T): T
}
export interface NotificationSecrets {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}
export type Provider = 'apns' | 'fcm'
export type NotificationKind = 'approval' | 'completed' | 'failed' | 'test'
/** Advisory app metadata supplied by an authenticated paired device, not proof of signing authority. */
export interface AppDescription {
  deviceId: string
  platform: 'android' | 'ios'
  applicationId: string
  teamId?: string
  environment?: 'sandbox' | 'production'
  updatedAt: number
}
export interface NotificationEvent {
  eventId: string
  deviceId?: string
  hostId?: string
  sessionId?: string
  kind: NotificationKind
  createdAt?: number
  expiresAt?: number
}
export interface PublicFirebaseOptions {
  applicationId: string
  apiKey: string
  projectId: string
  gcmSenderId: string
  storageBucket?: string
}
export type ProviderConfig = {
  provider: 'apns'; keyId: string; teamId: string; bundleId: string
  environment: 'sandbox' | 'production'; secretRef: string
} | {
  provider: 'fcm'; projectId: string; packageName: string; clientEmail: string
  secretRef: string; publicFirebaseOptions: PublicFirebaseOptions
}
export type NotificationImport = {
  provider: 'apns'; keyId: string; teamId: string; bundleId: string
  environment: 'sandbox' | 'production'; p8: string
} | {
  provider: 'fcm'; googleServicesJson: string; serviceAccountJson: string; applicationId?: string
}
export interface TokenRecord {
  deviceId: string; provider: Provider; applicationId: string; environment?: string
  secretRef: string; version: string; updatedAt: number; enabled: boolean
}
export interface OutboxRecord {
  id: string; eventId: string; deviceId: string; hostId?: string; sessionId?: string; kind: NotificationKind
  provider: Provider; tokenVersion: string; createdAt: number; expiresAt: number
  updatedAt: number; nextAttempt: number; attempts: number
  state: 'queued' | 'sending' | 'accepted' | 'received' | 'failed' | 'expired' | 'cancelled'
  error?: string; leaseUntil?: number
}
export interface DeliveryResult {
  accepted: boolean; retryable?: boolean; invalidToken?: boolean
  invalidatedAt?: number; code?: string; retryAfterMs?: number
}
export interface NotificationSender {
  send(config: ProviderConfig, privateKey: string, token: string, item: OutboxRecord): Promise<DeliveryResult>
  dispose?(): void
}
