import { createHash, randomUUID } from 'node:crypto'
import { parseNotificationImport } from './HLConfiguration.js'
import { HLPushProviders } from './HLPushProviders.js'
import type { HLAppDescription, HLNotificationEvent, HLNotificationImport, HLNotificationSecrets, HLNotificationSender, HLNotificationStorage, HLOutboxRecord, HLProvider, HLProviderConfig, HLTokenRecord } from './HLNotificationTypes.js'

const PREFIX = 'notifications:'
const tokenKey = (device: string) => `${PREFIX}token:${device}`
const appKey = (device: string) => `${PREFIX}app:${device}`
const boxKey = (id: string) => `${PREFIX}outbox:${id}`
const configKey = (provider: HLProvider) => `${PREFIX}config:${provider}`
const setupKey = (provider: HLProvider) => `${PREFIX}setup:${provider}`
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const dedupKey = (event: string, device: string) => `${PREFIX}dedup:${digest(JSON.stringify([event, device]))}`
const terminal = new Set(['accepted', 'received', 'failed', 'expired', 'cancelled'])
const RETENTION = 7 * 86400000
interface HLSetupTest { id: string; provider: HLProvider; expiresAt: number }
function identifier(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid notification identifier')
  return value
}

export interface HLNotificationServiceOptions {
  storage: HLNotificationStorage
  secrets: HLNotificationSecrets
  sender?: HLNotificationSender
  now?: () => number
  autoStart?: boolean
  hostId?: string | (() => string)
}

/** One durable queue worker per plugin instance. Nothing logs tokens, keys or imported JSON. */
export class HLNotificationService {
  private readonly db: HLNotificationStorage
  private readonly secrets: HLNotificationSecrets
  private readonly sender: HLNotificationSender
  private readonly now: () => number
  private timer?: ReturnType<typeof setInterval>
  private draining?: Promise<void>
  private stopped = false
  private changes = new Map<string, Promise<unknown>>()
  private readonly hostId?: string | (() => string)

  constructor(options: HLNotificationServiceOptions) {
    this.db = options.storage; this.secrets = options.secrets
    this.hostId = options.hostId
    this.now = options.now ?? Date.now; this.sender = options.sender ?? new HLPushProviders(fetch, this.now)
    if (options.autoStart !== false) this.start()
  }

  start(): void {
    if (this.timer) return
    this.stopped = false
    this.timer = setInterval(() => { void this.flush().catch(() => { /* Durable lease recovers on next tick. */ }) }, 1000)
    this.timer.unref()
    void this.flush().catch(() => { /* Never expose a storage/provider exception with credentials. */ })
  }

  /** Desktop owner-only entry. The caller must never expose it in the P2P method allowlist. */
  importConfiguration(input: HLNotificationImport): Promise<ReturnType<HLNotificationService['configuration']>> {
    return this.serialize(`config:${input.provider}`, () => this.importProvider(input))
  }

  private async importProvider(input: HLNotificationImport): Promise<ReturnType<HLNotificationService['configuration']>> {
    const { config, privateKey } = parseNotificationImport(input)
    const previous = this.db.get<HLProviderConfig>(configKey(config.provider))
    await this.secrets.set(config.secretRef, privateKey)
    try { this.db.set(configKey(config.provider), config) }
    catch { await this.secrets.delete(config.secretRef); throw new Error('Could not save notification configuration') }
    if (previous) await this.secrets.delete(previous.secretRef)
    this.db.transaction(() => {
      // Replacing credentials starts a new setup attempt. Old unsent tests must
      // not be delivered later against a different account/environment.
      for (const { key, value } of this.db.list<HLOutboxRecord>(`${PREFIX}outbox:`)) {
        if (value.provider === config.provider && value.eventId.startsWith('setup:') && !terminal.has(value.state)) {
          this.db.set(key, { ...value, state: 'cancelled', updatedAt: this.now() })
        }
      }
      this.db.set<HLSetupTest>(setupKey(config.provider), { id: randomUUID(), provider: config.provider, expiresAt: this.now() + 10 * 60_000 })
      for (const { value: token } of this.db.list<HLTokenRecord>(`${PREFIX}token:`)) this.enqueueSetupTest(token.deviceId, config.provider)
    })
    return this.configuration()
  }

  configuration() {
    const apns = this.db.get<HLProviderConfig>(configKey('apns'))
    const fcm = this.db.get<HLProviderConfig>(configKey('fcm'))
    return {
      ...(apns?.provider === 'apns' ? { apns: { bundleId: apns.bundleId, environment: apns.environment } } : {}),
      ...(fcm?.provider === 'fcm' ? { publicFirebaseOptions: { ...fcm.publicFirebaseOptions } } : {}),
    }
  }

  register(deviceId: string, params: { provider: HLProvider; token: string; applicationId: string; environment?: string }): Promise<{ registered: true }> {
    return this.serialize(deviceId, () => this.registerDevice(deviceId, params))
  }

  describe(deviceId: string, input: unknown): Promise<{ described: true }> {
    return this.serialize(deviceId, async () => {
      identifier(deviceId)
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid app metadata')
      const params = input as Record<string, unknown>
      if (params.platform !== 'android' && params.platform !== 'ios') throw new Error('Invalid app platform')
      if (typeof params.applicationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(params.applicationId)) throw new Error('Invalid app identifier')
      if (params.teamId !== undefined && (typeof params.teamId !== 'string' || !/^[A-Z0-9]{10}$/.test(params.teamId))) throw new Error('Invalid app team identifier')
      if (params.environment !== undefined && params.environment !== 'sandbox' && params.environment !== 'production') throw new Error('Invalid app push environment')
      this.db.set<HLAppDescription>(appKey(deviceId), {
        deviceId, platform: params.platform, applicationId: params.applicationId, updatedAt: this.now(),
        ...(params.platform === 'ios' && typeof params.teamId === 'string' ? { teamId: params.teamId } : {}),
        ...(params.platform === 'ios' && (params.environment === 'sandbox' || params.environment === 'production') ? { environment: params.environment } : {}),
      })
      return { described: true }
    })
  }

  private async registerDevice(deviceId: string, params: { provider: HLProvider; token: string; applicationId: string; environment?: string }): Promise<{ registered: true }> {
    identifier(deviceId)
    if (params.provider !== 'apns' && params.provider !== 'fcm') throw new Error('Invalid push provider')
    if (typeof params.token !== 'string' || params.token.length < 16 || params.token.length > 8192 || /[\s\x00-\x1f\x7f]/.test(params.token)) throw new Error('Invalid device token')
    if (params.provider === 'apns' && !/^[a-fA-F0-9]{32,512}$/.test(params.token)) throw new Error('Invalid APNs token')
    const config = this.db.get<HLProviderConfig>(configKey(params.provider))
    if (!config) throw new Error('Push provider is not configured')
    const app = config.provider === 'apns' ? config.bundleId : config.packageName
    if (params.applicationId !== app || (config.provider === 'apns' && params.environment !== config.environment)) throw new Error('Push application or environment mismatch')
    const previous = this.db.get<HLTokenRecord>(tokenKey(deviceId))
    // The registration timestamp is refreshed even if the OS reports the same token.
    const version = randomUUID(), secretRef = `${PREFIX}device-token:${version}`
    await this.secrets.set(secretRef, params.token)
    try {
      this.db.transaction(() => {
        this.db.set<HLTokenRecord>(tokenKey(deviceId), { deviceId, provider: params.provider, applicationId: app, ...(params.environment ? { environment: params.environment } : {}), secretRef, version, updatedAt: this.now(), enabled: true })
        for (const { key, value } of this.db.list<HLOutboxRecord>(`${PREFIX}outbox:`)) {
          if (value.deviceId === deviceId && (value.state === 'queued' || value.state === 'sending')) {
            this.db.set(key, { ...value, tokenVersion: version, provider: params.provider, state: 'queued', nextAttempt: this.now(), updatedAt: this.now() })
          }
        }
      })
    } catch { await this.secrets.delete(secretRef); throw new Error('Could not save device registration') }
    if (previous) await this.secrets.delete(previous.secretRef)
    this.enqueueSetupTest(deviceId, params.provider)
    return { registered: true }
  }

  private enqueueSetupTest(deviceId: string, provider: HLProvider): void {
    const setup = this.db.get<HLSetupTest>(setupKey(provider))
    const token = this.db.get<HLTokenRecord>(tokenKey(deviceId))
    const config = this.db.get<HLProviderConfig>(configKey(provider))
    if (!setup || setup.expiresAt <= this.now() || !token?.enabled || token.provider !== provider || !config) return
    if (config.provider === 'apns' ? config.bundleId !== token.applicationId || config.environment !== token.environment : config.packageName !== token.applicationId) return
    this.enqueue({ eventId: `setup:${setup.id}:${deviceId}`, deviceId, kind: 'test', expiresAt: setup.expiresAt })
  }

  revokeDevice(deviceId: string): Promise<void> { return this.serialize(deviceId, () => this.removeDevice(deviceId)) }

  private async removeDevice(deviceId: string): Promise<void> {
    identifier(deviceId)
    const token = this.db.get<HLTokenRecord>(tokenKey(deviceId))
    this.db.transaction(() => {
      this.db.delete(tokenKey(deviceId))
      this.db.delete(appKey(deviceId))
      for (const { key, value } of this.db.list<HLOutboxRecord>(`${PREFIX}outbox:`)) if (value.deviceId === deviceId && !terminal.has(value.state)) this.db.set(key, { ...value, state: 'cancelled', updatedAt: this.now() })
    })
    if (token) await this.secrets.delete(token.secretRef)
  }

  /** Root supplies global session/approval events; the queue contains only a generic notification. */
  enqueue(event: HLNotificationEvent): { eventId: string; queued: number; ids: string[] } {
    identifier(event.eventId)
    if (event.sessionId !== undefined) identifier(event.sessionId)
    if (!['approval', 'completed', 'failed', 'test'].includes(event.kind)) throw new Error('Invalid notification kind')
    const now = this.now()
    const hostId = event.hostId ?? (typeof this.hostId === 'function' ? this.hostId() : this.hostId)
    if (hostId !== undefined) identifier(hostId)
    const createdAt = event.createdAt ?? now
    const expiresAt = Math.min(event.expiresAt ?? createdAt + (event.kind === 'approval' ? 15 * 60000 : 3600000), createdAt + 86400000)
    if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || createdAt > now + 60000) throw new Error('Invalid notification lifetime')
    const ids: string[] = []
    this.db.transaction(() => {
      for (const { value: token } of this.db.list<HLTokenRecord>(`${PREFIX}token:`)) {
        if (!token.enabled || (event.deviceId && event.deviceId !== token.deviceId) || expiresAt <= now) continue
        const dedup = dedupKey(event.eventId, token.deviceId)
        if (this.db.get(dedup)) continue
        const id = randomUUID()
        const item: HLOutboxRecord = { id, eventId: event.eventId, deviceId: token.deviceId, ...(hostId ? { hostId } : {}), ...(event.sessionId ? { sessionId: event.sessionId } : {}), kind: event.kind, provider: token.provider, tokenVersion: token.version, createdAt, expiresAt, updatedAt: now, nextAttempt: now, attempts: 0, state: 'queued' }
        this.db.set(boxKey(id), item)
        this.db.set(dedup, { id, expiresAt: now + RETENTION })
        ids.push(id)
      }
    })
    return { eventId: event.eventId, queued: ids.length, ids }
  }

  testNotification(deviceId: string) {
    if (!this.db.get<HLTokenRecord>(tokenKey(identifier(deviceId)))?.enabled) throw new Error('This device has not registered for push notifications')
    const eventId = `test:${randomUUID()}`
    this.enqueue({ eventId, deviceId, kind: 'test', expiresAt: this.now() + 5 * 60000 })
    return { eventId, status: 'queued' as const }
  }

  received(deviceId: string, eventId: string): { acknowledged: boolean } {
    const entry = this.db.get<{ id: string }>(dedupKey(identifier(eventId), identifier(deviceId)))
    const item = entry && this.db.get<HLOutboxRecord>(boxKey(entry.id))
    if (!item || item.deviceId !== deviceId || item.state === 'cancelled') return { acknowledged: false }
    this.db.set(boxKey(item.id), { ...item, state: 'received', updatedAt: this.now() })
    return { acknowledged: true }
  }

  cancelEvent(eventId: string): void {
    for (const { key, value } of this.db.list<HLOutboxRecord>(`${PREFIX}outbox:`)) if (value.eventId === eventId && !terminal.has(value.state)) this.db.set(key, { ...value, state: 'cancelled', updatedAt: this.now() })
  }

  private serialize<T>(deviceId: string, operation: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Notification service is stopped'))
    const previous = this.changes.get(deviceId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    this.changes.set(deviceId, next)
    const release = () => { if (this.changes.get(deviceId) === next) this.changes.delete(deviceId) }
    void next.then(release, release)
    return next
  }

  async handle(deviceId: string, method: string, params: any): Promise<unknown> {
    switch (method) {
      case 'push.describe': return this.describe(deviceId, params)
      case 'push.configuration': return this.configuration()
      case 'push.register': return this.register(deviceId, params)
      case 'push.unregister': await this.revokeDevice(deviceId); return { unregistered: true }
      case 'push.received': return this.received(deviceId, params?.eventId)
      default: throw new Error('Unknown push method')
    }
  }

  status() {
    return {
      apps: this.db.list<HLAppDescription>(`${PREFIX}app:`).map(({ value }) => value),
      setup: this.db.list<HLSetupTest>(`${PREFIX}setup:`).map(({ value }) => value).filter(value => value.expiresAt > this.now()).map(value => ({
        provider: value.provider, expiresAt: value.expiresAt,
        waitingForDevice: !this.db.list<HLOutboxRecord>(`${PREFIX}outbox:`).some(({ value: item }) => item.eventId.startsWith(`setup:${value.id}:`) && item.state !== 'cancelled'),
      })),
      configured: { apns: !!this.db.get(configKey('apns')), fcm: !!this.db.get(configKey('fcm')) },
      tokens: this.db.list<HLTokenRecord>(`${PREFIX}token:`).map(({ value }) => ({ deviceId: value.deviceId, provider: value.provider, updatedAt: value.updatedAt, enabled: value.enabled })),
      outbox: this.db.list<HLOutboxRecord>(`${PREFIX}outbox:`).map(({ value }) => value).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50).map(item => ({ id: item.id, deviceId: item.deviceId, kind: item.kind, state: item.state, attempts: item.attempts, updatedAt: item.updatedAt, ...(item.error ? { error: item.error } : {}) })),
    }
  }

  flush(): Promise<void> {
    if (this.draining) return this.draining
    if (this.stopped) return Promise.resolve()
    this.draining = this.drain().finally(() => { this.draining = undefined })
    return this.draining
  }

  private async drain(): Promise<void> {
    const now = this.now()
    for (const { key, value } of this.db.list<{ expiresAt: number }>(`${PREFIX}dedup:`)) if (value.expiresAt <= now) this.db.delete(key)
    const items = this.db.list<HLOutboxRecord>(`${PREFIX}outbox:`).sort((a, b) => a.value.createdAt - b.value.createdAt)
    for (const { key } of items) {
      if (this.stopped) break
      const item = this.db.get<HLOutboxRecord>(key)
      if (!item) continue
      if (terminal.has(item.state)) { if (item.updatedAt + RETENTION <= now) this.db.delete(key); continue }
      if (item.expiresAt <= this.now()) { this.db.set(key, { ...item, state: 'expired', updatedAt: this.now() }); continue }
      if (item.nextAttempt > this.now() || (item.state === 'sending' && (item.leaseUntil ?? 0) > this.now())) continue
      const token = this.db.get<HLTokenRecord>(tokenKey(item.deviceId))
      const config = this.db.get<HLProviderConfig>(configKey(item.provider))
      if (!token?.enabled || token.version !== item.tokenVersion) { this.db.set(key, { ...item, state: 'cancelled', updatedAt: this.now() }); continue }
      if (!config || (config.provider === 'apns' ? config.bundleId !== token.applicationId || config.environment !== token.environment : config.packageName !== token.applicationId)) { this.db.set(key, { ...item, state: 'failed', error: 'provider_configuration_mismatch', updatedAt: this.now() }); continue }
      const sending: HLOutboxRecord = { ...item, state: 'sending', attempts: item.attempts + 1, leaseUntil: this.now() + 45000, updatedAt: this.now() }
      this.db.set(key, sending)
      let result
      try {
        const privateKey = await this.secrets.get(config.secretRef)
        const deviceToken = await this.secrets.get(token.secretRef)
        if (!privateKey || !deviceToken) result = { accepted: false, retryable: false, code: 'credentials_unavailable' }
        else {
          const latest = this.db.get<HLTokenRecord>(tokenKey(token.deviceId))
          const queued = this.db.get<HLOutboxRecord>(key)
          if (latest?.version !== token.version || !latest.enabled || queued?.state !== 'sending' || this.stopped) continue
          result = await this.sender.send(config, privateKey, deviceToken, sending)
        }
      } catch { result = { accepted: false, retryable: true, code: 'push_delivery_unavailable' } }
      const current = this.db.get<HLOutboxRecord>(key)
      // Revocation, token rotation and a phone receipt can occur while a send awaits the provider.
      if (!current || current.state !== 'sending' || current.tokenVersion !== sending.tokenVersion || this.stopped) continue
      const stamp = this.now()
      if (result.invalidToken && (!result.invalidatedAt || token.updatedAt <= result.invalidatedAt)) {
        const latest = this.db.get<HLTokenRecord>(tokenKey(token.deviceId))
        if (latest?.version === token.version) { this.db.set(tokenKey(token.deviceId), { ...latest, enabled: false }); await this.secrets.delete(token.secretRef) }
      }
      const state: HLOutboxRecord['state'] = result.accepted ? 'accepted' : stamp >= current.expiresAt ? 'expired' : result.retryable && current.attempts < 8 ? 'queued' : 'failed'
      const nextAttempt = stamp + Math.max(result.retryAfterMs ?? 0, Math.min(1000 * 2 ** Math.min(current.attempts, 10), 300000))
      const error = result.code && /^[a-zA-Z0-9_:-]{1,80}$/.test(result.code) ? result.code : result.accepted ? undefined : 'push_delivery_failed'
      this.db.set(key, { ...current, state, nextAttempt, updatedAt: stamp, leaseUntil: undefined, error })
    }
  }

  async dispose(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.sender.dispose?.()
    await Promise.allSettled([...this.changes.values(), ...(this.draining ? [this.draining] : [])])
  }
}

export function createNotificationService(options: HLNotificationServiceOptions): HLNotificationService { return new HLNotificationService(options) }
