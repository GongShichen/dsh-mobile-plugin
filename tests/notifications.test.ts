import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { NotificationService } from '../src/notifications/service.js'
import { PushProviders } from '../src/notifications/providers.js'
import { parseNotificationImport } from '../src/notifications/configuration.js'
import { createOwnerCall } from '../src/client/contract.js'
import type { NotificationStorage, NotificationSecrets, OutboxRecord, DeliveryResult } from '../src/notifications/types.js'

class MemoryStorage implements NotificationStorage {
  rows = new Map<string, unknown>()
  get<T>(key: string): T | undefined { return structuredClone(this.rows.get(key)) as T | undefined }
  set<T>(key: string, value: T): void { this.rows.set(key, structuredClone(value)) }
  delete(key: string): void { this.rows.delete(key) }
  list<T>(prefix: string) { return [...this.rows.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) as T })) }
  transaction<T>(fn: () => T): T { const before = structuredClone(this.rows); try { return fn() } catch (error) { this.rows = before; throw error } }
}
class MemorySecrets implements NotificationSecrets {
  rows = new Map<string, string>()
  async get(key: string) { return this.rows.get(key) }
  async set(key: string, value: string) { this.rows.set(key, value) }
  async delete(key: string) { this.rows.delete(key) }
}
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const p8 = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const apnsImport = { provider: 'apns' as const, p8, keyId: 'ABCDEFGHIJ', teamId: '0123456789', bundleId: 'com.example.mobile', environment: 'sandbox' as const }
const token = 'ab'.repeat(32)

async function fixture(send: (item: OutboxRecord) => Promise<DeliveryResult> = async () => ({ accepted: true })) {
  const storage = new MemoryStorage(), secrets = new MemorySecrets()
  let time = 1000000
  const service = new NotificationService({ storage, secrets, now: () => time, autoStart: false, sender: { send: async (_config, _key, _token, item) => send(item) } })
  await service.importConfiguration(apnsImport)
  // These delivery tests begin after the one-time setup wizard window.
  // The automatic setup tests have their own coverage below.
  time += 10 * 60000 + 1
  await service.register('phone-1', { provider: 'apns', token, applicationId: 'com.example.mobile', environment: 'sandbox' })
  return { service, storage, secrets, advance: (ms: number) => { time += ms }, now: () => time }
}

test('persistent outbox deduplicates across restart and distinguishes provider acceptance from device receipt', async () => {
  let sent = 0
  const f = await fixture(async () => { sent++; return { accepted: true } })
  assert.equal(f.service.enqueue({ eventId: 'complete-1', kind: 'completed', sessionId: 's1' }).queued, 1)
  assert.equal(f.service.enqueue({ eventId: 'complete-1', kind: 'completed', sessionId: 's1' }).queued, 0)
  f.service.dispose()
  const restored = new NotificationService({ storage: f.storage, secrets: f.secrets, now: f.now, autoStart: false, sender: { send: async () => { sent++; return { accepted: true } } } })
  await restored.flush()
  assert.equal(sent, 1)
  assert.equal(restored.status().outbox[0].state, 'accepted')
  assert.equal(restored.enqueue({ eventId: 'complete-1', kind: 'completed' }).queued, 0)
  assert.equal(restored.received('different-phone', 'complete-1').acknowledged, false)
  assert.equal(restored.received('phone-1', 'complete-1').acknowledged, true)
  assert.equal(restored.status().outbox[0].state, 'received')
  const publicJson = JSON.stringify({ status: restored.status(), config: restored.configuration(), db: [...f.storage.rows.values()] })
  assert.ok(!publicJson.includes(token))
  assert.ok(!publicJson.includes('PRIVATE KEY'))
  restored.dispose()
})

test('retry persists its delay, expires at TTL and never sends a revoked device', async () => {
  let attempts = 0
  const f = await fixture(async () => { attempts++; return { accepted: false, retryable: true, code: 'apns_503', retryAfterMs: 10000 } })
  f.service.enqueue({ eventId: 'approval-1', kind: 'approval', expiresAt: f.now() + 5000 })
  await f.service.flush(); await f.service.flush()
  assert.equal(attempts, 1)
  f.advance(6000); await f.service.flush()
  assert.equal(f.service.status().outbox[0].state, 'expired')
  f.service.enqueue({ eventId: 'complete-2', kind: 'completed' })
  await f.service.revokeDevice('phone-1'); await f.service.flush()
  assert.equal(attempts, 1)
  assert.equal(f.service.status().tokens.length, 0)
  assert.equal([...f.secrets.rows.values()].filter(value => value === token).length, 0)
  f.service.dispose()
})

test('token rotation while provider is responding cannot invalidate the replacement token', async () => {
  let respond!: (value: DeliveryResult) => void
  const f = await fixture(async () => await new Promise<DeliveryResult>(resolve => { respond = resolve }))
  f.service.enqueue({ eventId: 'e1', kind: 'completed' })
  const pending = f.service.flush()
  await new Promise(resolve => setImmediate(resolve))
  await f.service.register('phone-1', { provider: 'apns', token: 'cd'.repeat(32), applicationId: 'com.example.mobile', environment: 'sandbox' })
  respond({ accepted: false, invalidToken: true, code: 'apns_410' })
  await pending
  assert.equal(f.service.status().tokens[0].enabled, true)
  assert.equal(f.service.status().outbox[0].state, 'queued')
  f.service.dispose()
})

test('expired APNs tokens disable registrations and a new OS registration restores them', async () => {
  const f = await fixture(async () => ({ accepted: false, invalidToken: true, code: 'apns_410' }))
  f.service.enqueue({ eventId: 'e1', kind: 'completed' }); await f.service.flush()
  assert.equal(f.service.status().tokens[0].enabled, false)
  assert.equal(f.service.enqueue({ eventId: 'e2', kind: 'completed' }).queued, 0)
  await f.service.register('phone-1', { provider: 'apns', token, applicationId: 'com.example.mobile', environment: 'sandbox' })
  assert.equal(f.service.status().tokens[0].enabled, true)
  f.service.dispose()
})

test('APNs uses HTTP/2, an ES256 provider JWT, bounded TTL and generic payload only', async () => {
  let headers: any, payload: any, origin = ''
  const session = Object.assign(new EventEmitter(), {
    closed: false, destroyed: false, close() {}, destroy() {},
    request(value: unknown) {
      headers = value
      const request = Object.assign(new EventEmitter(), { setEncoding() {}, close() {}, end(value: string) { payload = JSON.parse(value); queueMicrotask(() => { request.emit('response', { ':status': 200 }); request.emit('end') }) } })
      return request
    },
  })
  const sender = new PushProviders(fetch, () => 1000000, ((value: string) => { origin = value; return session }) as any)
  const config = parseNotificationImport(apnsImport).config
  const result = await sender.send(config, p8, token, { id: '7e8491e2-bbfe-4833-baaa-0e881b12984d', eventId: 'e1', kind: 'approval', expiresAt: 1600000, sessionId: 's1' } as OutboxRecord)
  assert.equal(result.accepted, true)
  assert.equal(origin, 'https://api.sandbox.push.apple.com')
  assert.equal(headers['apns-expiration'], '1600')
  const parts = headers.authorization.slice(7).split('.')
  assert.equal(verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: pair.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url')), true)
  assert.equal(payload.eventId, 'e1')
  assert.equal(payload.aps.alert.body, '有一项操作需要确认。')
  assert.ok(!JSON.stringify(payload).includes(p8))
  sender.dispose()
})

test('FCM import returns only selected public Firebase fields and OAuth uses the fixed Google endpoint', async () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const privateKey = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const parsed = parseNotificationImport({ provider: 'fcm', googleServicesJson: JSON.stringify({ project_info: { project_id: 'example-project', project_number: '123456' }, client: [{ client_info: { mobilesdk_app_id: '1:123456:android:abc', android_client_info: { package_name: 'com.example.mobile' } }, api_key: [{ current_key: 'PUBLIC_FIREBASE_KEY' }] }] }), serviceAccountJson: JSON.stringify({ type: 'service_account', project_id: 'example-project', client_email: 'sender@example-project.iam.gserviceaccount.com', private_key: privateKey, token_uri: 'https://invalid.example/steal' }) })
  const calls: Array<{ url: string; options: RequestInit }> = []
  const fetcher = (async (url: string | URL, options: RequestInit) => {
    calls.push({ url: String(url), options })
    return calls.length === 1 ? Response.json({ access_token: 'FAKE_OAUTH', expires_in: 3600 }) : Response.json({ error: { details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } }, { status: 404 })
  }) as typeof fetch
  const sender = new PushProviders(fetcher, () => 1000000)
  const result = await sender.send(parsed.config, parsed.privateKey, 'FCM_DEVICE_TOKEN', { eventId: 'e1', kind: 'completed', expiresAt: 1600000 } as OutboxRecord)
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token')
  assert.equal(calls[1].url, 'https://fcm.googleapis.com/v1/projects/example-project/messages:send')
  const assertion = new URLSearchParams(calls[0].options.body as URLSearchParams).get('assertion')!.split('.')
  assert.equal(verify('sha256', Buffer.from(`${assertion[0]}.${assertion[1]}`), rsa.publicKey, Buffer.from(assertion[2], 'base64url')), true)
  assert.equal(result.invalidToken, true)
  assert.ok(!JSON.stringify(parsed.config).includes(privateKey))
})

test('desktop management unwraps the real Connection envelope and never routes over P2P', async () => {
  const rpc = { call: async (channel: string, endpoint: string, params: unknown) => { assert.equal(channel, '/api'); assert.equal(endpoint, 'mobileAccess/status'); assert.deepEqual(params, {}); return { ok: true, value: { hostName: 'Mac' } } } }
  assert.deepEqual(await createOwnerCall(rpc)('status'), { hostName: 'Mac' })
  await assert.rejects(createOwnerCall({ call: async () => ({ ok: false, error: { message: 'owner required' } }) })('status'), /owner required/)
})
