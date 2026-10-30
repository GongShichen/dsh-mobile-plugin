import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { NotificationService } from '../src/notifications/service.js'
import { SqliteStore } from '../src/storage/store.js'

const p8 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const input = { provider: 'apns' as const, p8, keyId: 'ABCDEFGHIJ', teamId: '0123456789', bundleId: 'com.example.mobile', environment: 'sandbox' as const }
const registration = { provider: 'apns' as const, token: 'ab'.repeat(32), applicationId: input.bundleId, environment: input.environment }

test('one-click configuration waits for registration, sends one test per generation, and preserves phone receipt', async () => {
  const store = new SqliteStore(':memory:')
  const secrets = new Map<string, string>()
  let sent = 0
  const service = new NotificationService({ storage: store, autoStart: false,
    secrets: { async get(k) { return secrets.get(k) }, async set(k, v) { secrets.set(k, v) }, async delete(k) { secrets.delete(k) } },
    sender: { async send() { sent++; return { accepted: true } } },
  })
  try {
    await service.importConfiguration(input)
    assert.equal(service.status().setup[0].waitingForDevice, true)
    await service.register('phone', registration)
    assert.equal(service.status().setup[0].waitingForDevice, false)
    assert.equal(service.status().outbox.length, 1)
    await service.register('phone', registration)
    assert.equal(service.status().outbox.length, 1)
    await service.flush()
    assert.equal(sent, 1)
    assert.equal(service.status().outbox[0].state, 'accepted')
    const event = store.list<{ eventId: string }>('notifications:outbox:')[0].value.eventId
    assert.equal(service.received('phone', event).acknowledged, true)
    assert.equal(service.status().outbox[0].state, 'received')
    await service.importConfiguration(input)
    assert.equal(service.status().outbox.length, 2)
    await service.register('phone', registration)
    await service.flush()
    assert.equal(sent, 2)
    await service.revokeDevice('phone')
    assert.equal(service.status().tokens.length, 0)
  } finally { await service.dispose(); store.close() }
})

test('expired setup windows do not send late tests and replacing credentials cancels pending old tests', async () => {
  const store = new SqliteStore(':memory:')
  const secrets = new Map<string, string>()
  let now = 1000
  const service = new NotificationService({ storage: store, autoStart: false, now: () => now,
    secrets: { async get(k) { return secrets.get(k) }, async set(k, v) { secrets.set(k, v) }, async delete(k) { secrets.delete(k) } },
    sender: { async send() { return { accepted: true } } },
  })
  try {
    await service.importConfiguration(input)
    now += 600_001
    await service.register('phone', registration)
    assert.equal(service.status().outbox.length, 0)
    await service.importConfiguration(input)
    assert.equal(service.status().outbox.length, 1)
    await service.importConfiguration(input)
    assert.equal(service.status().outbox.filter(item => item.state === 'cancelled').length, 1)
    assert.equal(service.status().outbox.filter(item => item.state === 'queued').length, 1)
    await service.revokeDevice('phone')
    assert.equal(service.status().outbox.filter(item => item.state === 'queued').length, 0)
  } finally { await service.dispose(); store.close() }
})
