import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { Endpoint, EndpointAddr } from '@number0/iroh'
import { MobileRuntime, MOBILE_ALPN, type AttachmentPort, type BridgePort } from '../src/transport/runtime.js'
import { encodeFrame, readFrame } from '../src/transport/framing.js'
import { SqliteStore } from '../src/storage/store.js'
import type { MobilePeer } from '../src/bridge/types.js'

async function localEndpoint(secret?: Uint8Array) {
  const builder = Endpoint.builder()
  builder.applyMinimal()
  builder.bindAddr('127.0.0.1:0')
  builder.alpns([Array.from(Buffer.from(MOBILE_ALPN))])
  if (secret) builder.secretKey(Array.from(secret))
  return builder.bind()
}

test('real encrypted iroh pairing, permission gate, RPC, event stream and revocation', { timeout: 25_000 }, async () => {
  const store = new SqliteStore(':memory:')
  const secrets = new Map<string, string>()
  let host!: Endpoint
  let disposed = 0
  const largeText = '中文🐋\n'.repeat(180_000)
  const bridge: BridgePort = {
    createPeer(deviceId) { const controller = new AbortController(); return { deviceId, scope: { signal: controller.signal, async dispose() { disposed++; controller.abort() } } } },
    async disposePeer(peer: MobilePeer) { await peer.scope.dispose() },
    async invoke(_peer, method, params) { assert.equal(method, 'sessions.list'); return params && typeof params === 'object' && 'large' in params ? { text: largeText } : { sessions: [{ id: 'session-one' }] } },
    async *subscribe() { yield { type: 'snapshot', cursor: 1, text: largeText }; yield { type: 'event', seq: 2 } },
  }
  const unsupported = async (): Promise<never> => { throw Error('Not used by this encrypted transport test') }
  const binary = Uint8Array.from([0, 255, 128, 34, 92, 10, 13])
  const sha256 = createHash('sha256').update(binary).digest('hex')
  let uploadOwner: string | undefined
  const attachments: AttachmentPort = {
    begin: unsupported, status: unsupported, finalize: unsupported, cancel: unsupported, revokeDevice: async () => {},
    async writeChunk(deviceId, uploadId, offset, bytes) { uploadOwner = deviceId; assert.equal(uploadId, 'upload-one'); assert.equal(offset, 0); assert.deepEqual(bytes, binary); return { offset: bytes.length } },
    async createDownload() { return { downloadId: 'download-one', length: binary.length, sha256 } },
    async readDownload(deviceId, downloadId, offset) { assert.equal(deviceId, uploadOwner); assert.equal(downloadId, 'download-one'); assert.equal(offset, 0); return { bytes: binary, length: binary.length, sha256 } },
  }
  const runtime = new MobileRuntime({ store, secretStore: { async get(k) { return secrets.get(k) }, async set(k, v) { secrets.set(k, v) }, async delete(k) { secrets.delete(k) } }, bridge, attachments, hostName: 'Test Mac', dshVersion: 'test', endpointFactory: async secret => { host = await localEndpoint(secret); return host } })
  let phone: Endpoint | undefined
  try {
    await runtime.start()
    phone = await localEndpoint()
    const addr = new EndpointAddr(host.id(), undefined, host.boundSockets())
    const connection = await phone.connect(addr, Array.from(Buffer.from(MOBILE_ALPN)))
    assert.equal(connection.remoteId().toString(), host.id().toString())
    const rpc = await connection.openBi()
    await rpc.send.writeAll(Array.from(encodeFrame({ v: 1, type: 'stream', kind: 'rpc' })))
    async function call(method: string, params: Record<string, unknown> = {}) {
      const id = randomUUID()
      await rpc.send.writeAll(Array.from(encodeFrame({ v: 1, id, method, params })))
      const response = await readFrame(rpc.recv, { allowLarge: true }) as { id: string; result: Record<string, unknown>; error?: { code: string } }
      assert.equal(response.id, id)
      return response
    }
    assert.equal((await call('sessions.list')).error?.code, 'UNAUTHORIZED')
    assert.equal((await call('hello')).result.authorized, false)
    const qr = runtime.createInvitation()
    const data = JSON.parse(Buffer.from(new URL(qr.uri).searchParams.get('data')!, 'base64url').toString()) as { pairingId: string; secret: string }
    const pending = await call('pairing.request', { ...data, name: 'Test phone', platform: 'ios' })
    runtime.approve(pending.result.requestId as string)
    const eventStreamPromise = connection.acceptBi()
    assert.equal((await call('pairing.status', { requestId: pending.result.requestId })).result.status, 'approved')
    const events = await eventStreamPromise
    assert.deepEqual(await readFrame(events.recv), { v: 1, type: 'stream', kind: 'events' })
    await runtime.broadcastPushConfigurationChanged()
    assert.deepEqual(await readFrame(events.recv), { v: 1, type: 'notice', name: 'push-configuration-changed' })
    assert.deepEqual((await call('sessions.list')).result, { sessions: [{ id: 'session-one' }] })
    assert.equal((await call('sessions.list', { large: true })).result.text, largeText)
    const subscribed = await call('subscribe', { topic: 'session', request: { address: { sessionId: 'session-one' } } })
    const frame = await readFrame(events.recv, { allowLarge: true }) as { subscriptionId: string; event: unknown }
    assert.equal(frame.subscriptionId, subscribed.result.subscriptionId)
    assert.deepEqual(frame.event, { type: 'snapshot', cursor: 1, text: largeText })
    const upload = await connection.openBi()
    await upload.send.writeAll(Array.from(encodeFrame({ v: 1, type: 'stream', kind: 'upload', uploadId: 'upload-one', offset: 0, length: binary.length })))
    await upload.send.writeAll(Array.from(binary))
    assert.deepEqual(await readFrame(upload.recv), { result: { offset: binary.length } })
    assert.equal(uploadOwner, phone.id().toString())
    assert.equal((await call('files.download', { sessionId: 'session-one', path: 'image.png' })).result.downloadId, 'download-one')
    const download = await connection.openBi()
    await download.send.writeAll(Array.from(encodeFrame({ v: 1, type: 'stream', kind: 'download', downloadId: 'download-one', offset: 0 })))
    assert.deepEqual(await readFrame(download.recv), { length: binary.length, sha256 })
    assert.deepEqual(Uint8Array.from(await download.recv.readExact(binary.length)), binary)
    connection.close(0n, [])
    await connection.closed()
    const reconnected = await phone.connect(addr, Array.from(Buffer.from(MOBILE_ALPN)))
    const secondRpc = await reconnected.openBi()
    await secondRpc.send.writeAll(Array.from(encodeFrame({ v: 1, type: 'stream', kind: 'rpc' })))
    await secondRpc.send.writeAll(Array.from(encodeFrame({ v: 1, id: 'hello-again', method: 'hello', params: {} })))
    assert.equal((await readFrame(secondRpc.recv) as { result: { authorized: boolean } }).result.authorized, true)
    await runtime.revoke(phone.id().toString())
    await reconnected.closed()
    assert.equal(runtime.listDevices().length, 0)
    assert.equal(disposed, 2)
  } finally { await runtime.stop(); await phone?.close(); store.close() }
})

test('stopping during asynchronous identity loading never leaves a late native listener alive', { timeout: 10_000 }, async () => {
  const store = new SqliteStore(':memory:')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let endpoint: Endpoint | undefined
  const unused = async (): Promise<never> => { throw new Error('No peer is connected during this lifecycle test') }
  const runtime = new MobileRuntime({
    store, hostName: 'Late start', dshVersion: 'test',
    secretStore: { async get() { await gate; return undefined }, async set() {}, async delete() {} },
    bridge: { createPeer() { throw new Error('Unexpected peer') }, disposePeer: unused, invoke: unused, async *subscribe() {} },
    attachments: { begin: unused, status: unused, writeChunk: unused, finalize: unused, cancel: unused, revokeDevice: unused, createDownload: unused, readDownload: unused },
    endpointFactory: async secret => { endpoint = await localEndpoint(secret); return endpoint },
  })
  try {
    const starting = runtime.start()
    const stopping = runtime.stop()
    release()
    await Promise.all([starting, stopping])
    assert.equal(runtime.status().running, false)
    assert.equal(endpoint?.isClosed(), true)
  } finally { release(); await runtime.stop(); store.close() }
})
