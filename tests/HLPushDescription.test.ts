import test from 'node:test'
import assert from 'node:assert/strict'
import { HLNotificationService } from '../src/notifications/HLNotificationService.js'
import { HLSQLiteStore } from '../src/storage/HLSQLiteStore.js'

test('app metadata arrives before provider setup and is bound to the authenticated peer', async () => {
  const store = new HLSQLiteStore(':memory:')
  const service = new HLNotificationService({ storage: store, secrets: { async get() { return undefined }, async set() {}, async delete() {} }, autoStart: false })
  try {
    const result = await service.handle('actual-peer', 'push.describe', { deviceId: 'spoofed-peer', platform: 'ios', applicationId: 'io.github.gongshichen.dshmobile', teamId: 'ABCDEFGHIJ', environment: 'sandbox', privateKey: 'not-accepted' })
    assert.deepEqual(result, { described: true })
    const status = service.status()
    assert.deepEqual(status.configured, { apns: false, fcm: false })
    assert.equal(status.apps.length, 1)
    assert.equal(status.apps[0].deviceId, 'actual-peer')
    assert.equal(status.apps[0].teamId, 'ABCDEFGHIJ')
    assert.ok(!JSON.stringify(status).includes('not-accepted'))
    await assert.rejects(service.describe('other-peer', { platform: 'ios', applicationId: 'valid.app', teamId: 'invalid' }), /team/)
    await service.revokeDevice('actual-peer')
    assert.equal(service.status().apps.length, 0)
  } finally { await service.dispose(); store.close() }
})

test('disposing push service rejects future configuration mutations', async () => {
  const store = new HLSQLiteStore(':memory:')
  const service = new HLNotificationService({ storage: store, secrets: { async get() { return undefined }, async set() {}, async delete() {} }, autoStart: false })
  await service.dispose()
  store.close()
  await assert.rejects(service.describe('device', { platform: 'android', applicationId: 'valid.app' }), /stopped/)
})
