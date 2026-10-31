import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { HLSQLiteStore } from '../src/storage/HLSQLiteStore.js'
import { loadIdentity, type HLSecretStore } from '../src/storage/HLSecretStore.js'
import { HLOperationLedger } from '../src/storage/HLOperationLedger.js'
import { HLPairingManager } from '../src/pairing/HLPairingManager.js'
import { encodeFrame, readFrame, MAX_FRAME_BYTES, HLFrameWriter } from '../src/transport/HLFraming.js'

test('framing preserves UTF-8 and rejects oversized, truncated and invalid input', async () => {
  const encoded = encodeFrame({ text: '手机连接 🐋' })
  let offset = 0
  const reader = { async readExact(n: number) { const part = encoded.slice(offset, offset + n); offset += n; return part } }
  assert.deepEqual(await readFrame(reader), { text: '手机连接 🐋' })
  const header = Buffer.alloc(4); header.writeUInt32BE(MAX_FRAME_BYTES + 1)
  await assert.rejects(readFrame({ async readExact() { return header } }), { code: 'FRAME_TOO_LARGE' })
  await assert.rejects(readFrame({ async readExact() { return new Uint8Array(0) } }), { code: 'TRUNCATED_FRAME' })
  assert.throws(() => encodeFrame('x'.repeat(MAX_FRAME_BYTES)), { code: 'FRAME_TOO_LARGE' })
})

test('framed writes serialize and impose bounded backpressure', async () => {
  let finish!: () => void
  const sent: number[][] = []
  const writer = new HLFrameWriter({ async writeAll(bytes) { await new Promise<void>(resolve => { finish = resolve }); sent.push(bytes) } }, 1)
  const first = writer.write({ n: 1 })
  await Promise.resolve()
  await assert.rejects(writer.write({ n: 2 }), { code: 'BACKPRESSURE' })
  finish(); await first
  assert.equal(sent.length, 1)
})

test('pairing binds actual peer, expires invitations and atomically consumes a confirmed invitation', () => {
  const store = new HLSQLiteStore(':memory:')
  let now = 1000
  const pairing = new HLPairingManager(store, () => now)
  const invite = pairing.create('desktop-key', 'ticket', 'Mac')
  const input = { pairingId: invite.invitation.pairingId, secret: invite.invitation.secret, name: 'Phone', platform: 'ios' as const }
  const a = pairing.request('phone-a', input)
  const b = pairing.request('phone-b', input)
  assert.throws(() => pairing.status('phone-b', a.requestId), { code: 'PAIRING_NOT_FOUND' })
  const device = pairing.approve(a.requestId)
  assert.equal(device.id, 'phone-a')
  assert.equal(pairing.status('phone-b', b.requestId), 'expired')
  assert.throws(() => pairing.request('phone-c', input), { code: 'PAIRING_INVALID' })
  pairing.revoke('phone-a')
  assert.equal(pairing.device('phone-a'), undefined)
  const next = pairing.create('desktop-key', 'ticket', 'Mac')
  now += 300_001
  assert.throws(() => pairing.request('phone-c', { ...input, pairingId: next.invitation.pairingId, secret: next.invitation.secret }), { code: 'PAIRING_INVALID' })
  assert.equal(pairing.current(), undefined)
  store.close()
})

test('pairing rate-limits unauthenticated repeated guesses', () => {
  const store = new HLSQLiteStore(':memory:')
  const pairing = new HLPairingManager(store)
  const invite = pairing.create('desktop', 'ticket', 'Mac')
  const input = { pairingId: invite.invitation.pairingId, secret: 'wrong', name: 'Phone', platform: 'android' as const }
  for (let i = 0; i < 5; i++) assert.throws(() => pairing.request('attacker', input), { code: 'PAIRING_INVALID' })
  assert.throws(() => pairing.request('attacker', input), { code: 'PAIRING_RATE_LIMITED' })
  store.close()
})

test('SQLite transactions roll back and namespaces remain independent', () => {
  const store = new HLSQLiteStore(':memory:')
  store.set('a/1', { a: 1 }); store.set('ab/1', { a: 2 })
  assert.throws(() => store.transaction(() => { store.set('a/1', { a: 3 }); throw Error('rollback') }))
  assert.deepEqual(store.list('a/'), [{ key: 'a/1', value: { a: 1 } }])
  store.close()
})

test('operation retries return the existing result and reject id reuse with changed content', async () => {
  const store = new HLSQLiteStore(':memory:')
  const ledger = new HLOperationLedger(store)
  let calls = 0
  const invoke = async () => { calls++; return { title: 'new' } }
  await Promise.all([ledger.execute('phone', 'op', 'sessions.rename', { title: 'new' }, invoke), ledger.execute('phone', 'op', 'sessions.rename', { title: 'new' }, invoke)])
  assert.equal(calls, 1)
  assert.deepEqual(await ledger.execute('phone', 'op', 'sessions.rename', { title: 'new' }, invoke), { title: 'new' })
  await assert.rejects(ledger.execute('phone', 'op', 'sessions.rename', { title: 'other' }, invoke), { code: 'OPERATION_CONFLICT' })
  store.close()
})

test('unknown non-idempotent outcomes never replay; prompts preserve retry identity', async () => {
  const store = new HLSQLiteStore(':memory:')
  const ledger = new HLOperationLedger(store)
  await assert.rejects(ledger.execute('phone', 'fork-op', 'sessions.fork', { sessionId: 's' }, async () => { throw Error('lost response') }))
  const recovered = new HLOperationLedger(store)
  await assert.rejects(recovered.execute('phone', 'fork-op', 'sessions.fork', { sessionId: 's' }, async () => null), { code: 'OPERATION_OUTCOME_UNKNOWN' })
  const prompt = { requestId: 'req', sessionId: 's', content: 'hello' }
  await assert.rejects(ledger.execute('phone', 'prompt-op', 'sessions.prompt', prompt, async () => { throw Error('network') }))
  assert.deepEqual(await recovered.execute('phone', 'prompt-op', 'sessions.prompt', prompt, async () => ({ accepted: true })), { accepted: true })
  await assert.rejects(recovered.execute('phone', 'other-op', 'sessions.prompt', { ...prompt, content: 'different' }, async () => null), { code: 'OPERATION_CONFLICT' })
  store.close()
})

test('identity persists and invalid key storage never silently rotates it', async () => {
  const data = new Map<string, string>()
  const secrets: HLSecretStore = { async get(k) { return data.get(k) }, async set(k, v) { data.set(k, v) }, async delete(k) { data.delete(k) } }
  const first = await loadIdentity(secrets)
  assert.equal(first.length, 32)
  assert.deepEqual(await loadIdentity(secrets), first)
  data.set('iroh-identity', randomBytes(16).toString('base64'))
  await assert.rejects(loadIdentity(secrets), /invalid/)
})
