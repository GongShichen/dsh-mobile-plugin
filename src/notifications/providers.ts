import { sign, createHash } from 'node:crypto'
import { connect, type ClientHttp2Session } from 'node:http2'
import type { DeliveryResult, NotificationSender, OutboxRecord, ProviderConfig } from './types.js'

const OAUTH = 'https://oauth2.googleapis.com/token'
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
function jwt(header: object, payload: object, key: string, alg: 'ES256' | 'RS256'): string {
  const value = `${b64(header)}.${b64(payload)}`
  const signature = sign('sha256', Buffer.from(value), alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key)
  return `${value}.${signature.toString('base64url')}`
}
const bodyText = { approval: '有一项操作需要确认。', completed: '任务已完成。', failed: '任务需要查看。', test: '这是一条测试通知。' }
function retryAfter(value: string | null | undefined, now: number): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now
  return Number.isFinite(delay) ? Math.max(1000, Math.min(delay, 3600000)) : undefined
}

/** Credentials remain here on the desktop. No arbitrary URLs from imported files are used. */
export class PushProviders implements NotificationSender {
  private sessions = new Map<string, ClientHttp2Session>()
  private auth = new Map<string, { value: string; expiresAt: number }>()
  private lifetime = new AbortController()
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly now: () => number = Date.now, private readonly connectHttp2: typeof connect = connect) {}

  async send(config: ProviderConfig, privateKey: string, token: string, item: OutboxRecord): Promise<DeliveryResult> {
    try {
      return config.provider === 'apns'
        ? await this.apns(config, privateKey, token, item)
        : await this.fcm(config, privateKey, token, item)
    } catch { return { accepted: false, retryable: true, code: 'provider_unreachable' } }
  }

  private async apns(config: Extract<ProviderConfig, { provider: 'apns' }>, key: string, token: string, item: OutboxRecord): Promise<DeliveryResult> {
    let auth = this.auth.get(config.secretRef)
    if (!auth || auth.expiresAt <= this.now()) {
      const iat = Math.floor(this.now() / 1000)
      auth = { value: jwt({ alg: 'ES256', kid: config.keyId }, { iss: config.teamId, iat }, key, 'ES256'), expiresAt: this.now() + 50 * 60000 }
      this.auth.set(config.secretRef, auth)
    }
    const origin = config.environment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com'
    const sessionKey = `${origin}/${config.secretRef}`
    let session = this.sessions.get(sessionKey)
    if (!session || session.closed || session.destroyed) {
      session = this.connectHttp2(origin)
      session.on('error', () => { session?.destroy(); this.sessions.delete(sessionKey) })
      session.on('goaway', () => { session?.close(); this.sessions.delete(sessionKey) })
      this.sessions.set(sessionKey, session)
    }
    const payload = JSON.stringify({ aps: { alert: { title: 'Harness Link', body: bodyText[item.kind] }, sound: 'default' }, eventId: item.eventId, ...(item.hostId ? { hostId: item.hostId } : {}), ...(item.sessionId ? { sessionId: item.sessionId } : {}), kind: item.kind })
    return await new Promise<DeliveryResult>((resolve) => {
      let status = 0, response = '', retry: string | undefined
      let settled = false
      const finish = (result: DeliveryResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result) } }
      const request = session!.request({ ':method': 'POST', ':path': `/3/device/${token}`, authorization: `bearer ${auth.value}`, 'apns-topic': config.bundleId, 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-expiration': String(Math.floor(item.expiresAt / 1000)), 'apns-id': item.id, 'apns-collapse-id': createHash('sha256').update(item.eventId).digest('hex'), 'content-type': 'application/json' })
      const timer = setTimeout(() => { request.close(); finish({ accepted: false, retryable: true, code: 'apns_timeout' }) }, 15000)
      request.on('response', headers => { status = Number(headers[':status']); retry = typeof headers['retry-after'] === 'string' ? headers['retry-after'] : undefined })
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { response += chunk; if (response.length > 65536) { request.close(); finish({ accepted: false, retryable: true, code: 'apns_response_limit' }) } })
      request.on('error', () => finish({ accepted: false, retryable: true, code: 'apns_connection_error' }))
      request.on('end', () => {
        if (status === 200) return finish({ accepted: true })
        let result: { reason?: string; timestamp?: number } = {}
        try { result = JSON.parse(response) } catch { /* Do not forward provider response bodies. */ }
        const invalidToken = status === 410 || result.reason === 'BadDeviceToken' || result.reason === 'DeviceTokenNotForTopic'
        if (result.reason === 'ExpiredProviderToken') this.auth.delete(config.secretRef)
        finish({ accepted: false, retryable: status === 429 || status >= 500 || result.reason === 'ExpiredProviderToken', invalidToken, invalidatedAt: typeof result.timestamp === 'number' ? result.timestamp : undefined, code: `apns_${status || 'response'}`, retryAfterMs: retryAfter(retry, this.now()) })
      })
      request.end(payload)
    })
  }

  private async fcm(config: Extract<ProviderConfig, { provider: 'fcm' }>, key: string, token: string, item: OutboxRecord): Promise<DeliveryResult> {
    let auth = this.auth.get(config.secretRef)
    if (!auth || auth.expiresAt <= this.now()) {
      const iat = Math.floor(this.now() / 1000)
      const assertion = jwt({ alg: 'RS256', typ: 'JWT' }, { iss: config.clientEmail, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: OAUTH, iat, exp: iat + 3600 }, key, 'RS256')
      const response = await this.fetcher(OAUTH, { method: 'POST', redirect: 'error', signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15000)]), headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) })
      if (!response.ok) return { accepted: false, retryable: response.status === 429 || response.status >= 500, code: `fcm_auth_${response.status}` }
      const body = await response.json() as { access_token?: string; expires_in?: number }
      if (typeof body.access_token !== 'string' || !body.access_token || typeof body.expires_in !== 'number') return { accepted: false, retryable: false, code: 'fcm_auth_response' }
      auth = { value: body.access_token, expiresAt: this.now() + Math.max(0, Math.min(body.expires_in - 60, 3540)) * 1000 }
      this.auth.set(config.secretRef, auth)
    }
    const response = await this.fetcher(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/messages:send`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15000)]),
      headers: { authorization: `Bearer ${auth.value}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { token, notification: { title: 'Harness Link', body: bodyText[item.kind] }, data: { eventId: item.eventId, kind: item.kind, ...(item.hostId ? { hostId: item.hostId } : {}), ...(item.sessionId ? { sessionId: item.sessionId } : {}) }, android: { priority: 'high', ttl: `${Math.max(0, Math.floor((item.expiresAt - this.now()) / 1000))}s`, restricted_package_name: config.packageName } } }),
    })
    if (response.ok) return { accepted: true }
    if (response.status === 401) this.auth.delete(config.secretRef)
    let body: any = {}
    try { body = await response.json() } catch { /* Provider data is not exposed. */ }
    const invalidToken = Array.isArray(body.error?.details) && body.error.details.some((entry: any) => entry['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError' && entry.errorCode === 'UNREGISTERED')
    return { accepted: false, invalidToken, retryable: response.status === 401 || response.status === 429 || response.status >= 500, code: `fcm_${response.status}`, retryAfterMs: retryAfter(response.headers.get('retry-after'), this.now()) }
  }

  dispose(): void { this.lifetime.abort(); for (const session of this.sessions.values()) session.destroy(); this.sessions.clear(); this.auth.clear() }
}
