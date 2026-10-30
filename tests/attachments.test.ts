import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AttachmentManager, MAX_CHUNK_BYTES } from '../src/attachments/index.ts'
import type { AttachmentBridge } from '../src/attachments/index.ts'
import type { MobilePeer, PeerScope } from '../src/bridge/types.ts'

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function peer(deviceId = 'phone'): MobilePeer { const controller = new AbortController(); return { deviceId, scope: { signal: controller.signal, async dispose() { controller.abort() } } } }

test('P2P upload is device bound, resumable, hash checked, and finalized once into a DSH receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-attachments-'))
  const payload = Buffer.alloc(MAX_CHUNK_BYTES + 13, 37)
  let uploads = 0
  const bridge: AttachmentBridge<PeerScope> = {
    async fetch(_peer, request) {
      uploads++
      assert.equal(new URL(request.url).pathname, '/api/session/uploadFileBinary')
      assert.equal(new URL(request.url).searchParams.get('sessionId'), 'session')
      assert.deepEqual(Buffer.from(await request.arrayBuffer()), payload)
      return Response.json({ ok: true, value: { receiptId: 'receipt', file: { path: 'host-staged' } } })
    },
    async readDownload() { return { data: payload } },
  }
  let manager = new AttachmentManager({ directory }, bridge)
  try {
    const begun = await manager.begin('phone', { sessionId: 'session', name: 'a.bin', size: payload.length, sha256: hash(payload) })
    await assert.rejects(manager.status('another-phone', begun.uploadId), { code: 'mobile/upload-not-found' })
    await assert.rejects(manager.writeChunk('phone', begun.uploadId, 1, payload.subarray(0, 12)), { code: 'mobile/upload-offset' })
    await manager.writeChunk('phone', begun.uploadId, 0, payload.subarray(0, MAX_CHUNK_BYTES))
    await manager.writeChunk('phone', begun.uploadId, 0, payload.subarray(0, MAX_CHUNK_BYTES))
    await assert.rejects(manager.writeChunk('phone', begun.uploadId, 0, Buffer.alloc(3, 1)), { code: 'mobile/chunk-conflict' })
    await manager.dispose()
    manager = new AttachmentManager({ directory }, bridge)
    assert.equal((await manager.status('phone', begun.uploadId)).offset, MAX_CHUNK_BYTES)
    await assert.rejects(manager.finalize(peer(), begun.uploadId), { code: 'mobile/upload-incomplete' })
    await manager.writeChunk('phone', begun.uploadId, MAX_CHUNK_BYTES, payload.subarray(MAX_CHUNK_BYTES))
    const [a, b] = await Promise.all([manager.finalize(peer(), begun.uploadId), manager.finalize(peer(), begun.uploadId)])
    assert.equal(a.receiptId, 'receipt')
    assert.deepEqual(a, b)
    assert.equal(uploads, 1)
    const download = await manager.createDownload(peer(), { sessionId: 'session', path: 'a.bin' })
    await assert.rejects(manager.readDownload('another-phone', download.downloadId, 0), { code: 'mobile/download-not-found' })
    const tail = await manager.readDownload('phone', download.downloadId, MAX_CHUNK_BYTES)
    assert.deepEqual(tail.bytes, payload.subarray(MAX_CHUNK_BYTES))
    assert.equal(tail.sha256, hash(tail.bytes))
    await manager.revokeDevice('phone')
    await assert.rejects(manager.status('phone', begun.uploadId), { code: 'mobile/device-revoked' })
    await manager.authorizeDevice('phone')
    await assert.rejects(manager.status('phone', begun.uploadId), { code: 'mobile/upload-not-found' })
    await manager.begin('phone', { sessionId: 'session', name: 'new.bin', size: payload.length, sha256: hash(payload) })
  } finally { await manager.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test('bad digests never reach DSH, quota includes reserved bytes, and expired handles fail', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-attachments-'))
  let now = 100
  let calls = 0
  const bridge: AttachmentBridge<PeerScope> = { async fetch() { calls++; return Response.json({}) }, async readDownload() { return { data: new Uint8Array() } } }
  const manager = new AttachmentManager({ directory, now: () => now, ttlMs: 10, maxFileBytes: 4, maxDeviceBytes: 4 }, bridge)
  try {
    const upload = await manager.begin('phone', { sessionId: 's', name: 'a', size: 4, sha256: hash(Buffer.from('nope')) })
    await assert.rejects(manager.begin('phone', { sessionId: 's', name: 'b', size: 1, sha256: hash(Buffer.from('b')) }), { code: 'mobile/upload-quota' })
    await manager.writeChunk('phone', upload.uploadId, 0, Buffer.from('data'))
    await assert.rejects(manager.finalize(peer(), upload.uploadId), { code: 'mobile/upload-hash' })
    assert.equal(calls, 0)
    now = 111
    await assert.rejects(manager.status('phone', upload.uploadId), { code: 'mobile/upload-expired' })
    await manager.expire()
    await manager.begin('phone', { sessionId: 's', name: 'b', size: 1, sha256: hash(Buffer.from('b')) })
  } finally { await manager.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test('revocation aborts an active official intake before a receipt can escape', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-attachments-'))
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const bridge: AttachmentBridge<PeerScope> = {
    async fetch(_peer, request) {
      started()
      await new Promise<void>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
      return Response.json({ ok: true, value: { receiptId: 'must-not-escape' } })
    }, async readDownload() { return {} },
  }
  const manager = new AttachmentManager({ directory }, bridge)
  try {
    const upload = await manager.begin('phone', { sessionId: 's', name: 'a', size: 1, sha256: hash(Buffer.from('x')) })
    await manager.writeChunk('phone', upload.uploadId, 0, Buffer.from('x'))
    const finishing = manager.finalize(peer(), upload.uploadId)
    const rejected = assert.rejects(finishing, /cancelled/)
    await ready
    await manager.revokeDevice('phone')
    await rejected
  } finally { await manager.dispose(); await rm(directory, { recursive: true, force: true }) }
})
