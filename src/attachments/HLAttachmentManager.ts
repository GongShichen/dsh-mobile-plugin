import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { HLBridgeError, paramsOf, record, textField } from '../bridge/HLBridgeError.ts'
import type { HLPeer, HLPeerScope } from '../bridge/HLBridgeTypes.ts'

export const MAX_CHUNK_BYTES = 64 * 1024

export interface HLAttachmentBridge<S extends HLPeerScope> {
  fetch(peer: HLPeer<S>, request: Request): Promise<Response>
  readDownload(peer: HLPeer<S>, params: unknown, signal?: AbortSignal): Promise<unknown>
}

export interface HLAttachmentOptions {
  directory: string
  maxFileBytes?: number
  maxDeviceBytes?: number
  maxUploadsPerDevice?: number
  ttlMs?: number
  now?: () => number
}

interface HLUpload {
  uploadId: string
  deviceId: string
  sessionId: string
  name: string
  size: number
  sha256: string
  mediaType?: string
  offset: number
  expiresAt: number
  receipt?: Record<string, unknown>
}

interface HLDownload {
  deviceId: string
  length: number
  sha256: string
  expiresAt: number
}

/** Device-owned staging with resumable P2P intake; DSH still receives one complete upload. */
export class HLAttachmentManager<S extends HLPeerScope = HLPeerScope> {
  private readonly uploads = new Map<string, HLUpload>()
  private readonly downloads = new Map<string, HLDownload>()
  private readonly jobs = new Map<string, Promise<unknown>>()
  private readonly active = new Map<string, AbortController>()
  private readonly revoked = new Set<string>()
  private readonly ready: Promise<void>
  private readonly now: () => number
  private readonly maxFileBytes: number
  private readonly maxDeviceBytes: number
  private readonly maxUploads: number
  private readonly ttlMs: number
  private closed = false

  constructor(private readonly options: HLAttachmentOptions, private readonly bridge: HLAttachmentBridge<S>) {
    this.now = options.now ?? Date.now
    this.maxFileBytes = limit(options.maxFileBytes ?? 32 * 1024 * 1024, 'maxFileBytes')
    this.maxDeviceBytes = limit(options.maxDeviceBytes ?? 128 * 1024 * 1024, 'maxDeviceBytes')
    this.maxUploads = limit(options.maxUploadsPerDevice ?? 32, 'maxUploadsPerDevice')
    this.ttlMs = limit(options.ttlMs ?? 60 * 60 * 1000, 'ttlMs')
    this.ready = this.restore()
  }

  private file(id: string, suffix: 'json' | 'part' | 'download'): string { return join(this.options.directory, `${id}.${suffix}`) }

  private assertDevice(deviceId: string): void {
    textField(deviceId, 'deviceId')
    if (this.closed || this.revoked.has(deviceId)) throw new HLBridgeError('mobile/device-revoked', 'Attachment access is closed')
  }

  private async restore(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
    for (const file of await readdir(this.options.directory)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue
      try {
        const raw: unknown = JSON.parse(await readFile(join(this.options.directory, file), 'utf8'))
        if (!record(raw) || raw.uploadId !== file.slice(0, -5)) throw new Error('Invalid staging metadata')
        const upload = parseUpload(raw)
        if (upload.expiresAt <= this.now() || upload.size > this.maxFileBytes) {
          await this.removeFiles(upload.uploadId)
          continue
        }
        const info = await stat(this.file(upload.uploadId, 'part'))
        if (!info.isFile() || info.size < upload.offset) throw new Error('Incomplete staging file')
        // Bytes written before a crash but not checkpointed are safe to retransmit.
        if (info.size !== upload.offset) await truncate(this.file(upload.uploadId, 'part'), upload.offset)
        this.uploads.set(upload.uploadId, upload)
      } catch (error) {
        // Invalid or incomplete private staging files cannot grant a receipt.
        if (!(error instanceof Error)) throw error
        await this.removeFiles(file.slice(0, -5))
      }
    }
    // Download handles are connection-era state; discard their bytes after restart.
    for (const file of await readdir(this.options.directory)) {
      if (/^[0-9a-f-]{36}\.download$/.test(file)) await rm(join(this.options.directory, file), { force: true })
    }
  }

  private serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const before = this.jobs.get(id) ?? Promise.resolve()
    const job = before.catch(() => undefined).then(operation)
    this.jobs.set(id, job)
    void job.finally(() => { if (this.jobs.get(id) === job) this.jobs.delete(id) }).catch(() => undefined)
    return job
  }

  private async save(upload: HLUpload): Promise<void> {
    const { receipt: _receipt, ...metadata } = upload
    const temp = `${this.file(upload.uploadId, 'json')}.tmp`
    const handle = await open(temp, 'w', 0o600)
    try { await handle.writeFile(JSON.stringify(metadata)); await handle.sync() } finally { await handle.close() }
    await rename(temp, this.file(upload.uploadId, 'json'))
  }

  private reserved(deviceId: string): number {
    return [...this.uploads.values()].filter(u => u.deviceId === deviceId).reduce((sum, u) => sum + u.size, 0)
      + [...this.downloads.values()].filter(d => d.deviceId === deviceId).reduce((sum, d) => sum + d.length, 0)
  }

  async begin(deviceId: string, value: unknown): Promise<ReturnType<typeof uploadStatus>> {
    await this.ready
    return this.serialize('allocation', async () => {
      this.assertDevice(deviceId)
      await this.expire()
      const request = paramsOf(value)
      const sessionId = textField(request.sessionId, 'sessionId')
      const name = textField(request.name, 'name')
      const size = nonnegative(request.size, 'size')
      const sha256 = hashField(request.sha256)
      const mediaType = request.mediaType === undefined ? undefined : textField(request.mediaType, 'mediaType')
      if (size > this.maxFileBytes || this.reserved(deviceId) + size > this.maxDeviceBytes
        || [...this.uploads.values()].filter(u => u.deviceId === deviceId).length >= this.maxUploads) {
        throw new HLBridgeError('mobile/upload-quota', 'Attachment quota exceeded')
      }
      const upload: HLUpload = { uploadId: randomUUID(), deviceId, sessionId, name, size, sha256,
        offset: 0, expiresAt: this.now() + this.ttlMs, ...(mediaType === undefined ? {} : { mediaType }) }
      const file = await open(this.file(upload.uploadId, 'part'), 'wx', 0o600)
      await file.close()
      this.uploads.set(upload.uploadId, upload)
      try { await this.save(upload) } catch (error) { this.uploads.delete(upload.uploadId); await this.removeFiles(upload.uploadId); throw error }
      return uploadStatus(upload)
    })
  }

  private upload(deviceId: string, uploadId: string): HLUpload {
    this.assertDevice(deviceId)
    const upload = this.uploads.get(uploadId)
    if (upload === undefined || upload.deviceId !== deviceId) throw new HLBridgeError('mobile/upload-not-found', 'Upload is unavailable')
    if (upload.expiresAt <= this.now()) throw new HLBridgeError('mobile/upload-expired', 'Upload expired')
    return upload
  }

  async status(deviceId: string, uploadId: string): Promise<ReturnType<typeof uploadStatus>> {
    await this.ready
    return this.serialize(uploadId, async () => uploadStatus(this.upload(deviceId, uploadId)))
  }

  async writeChunk(deviceId: string, uploadId: string, offset: number, bytes: Uint8Array): Promise<ReturnType<typeof uploadStatus>> {
    await this.ready
    return this.serialize(uploadId, async () => {
      const upload = this.upload(deviceId, uploadId)
      nonnegative(offset, 'offset')
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_CHUNK_BYTES || offset + bytes.byteLength > upload.size) {
        throw new HLBridgeError('mobile/invalid-chunk', 'Chunk is empty, oversized, or outside the file')
      }
      if (offset > upload.offset) throw new HLBridgeError('mobile/upload-offset', `Expected offset ${upload.offset}`)
      const handle = await open(this.file(uploadId, 'part'), 'r+')
      try {
        if (offset < upload.offset) {
          if (offset + bytes.byteLength > upload.offset) throw new HLBridgeError('mobile/upload-offset', 'Chunk overlaps an uncommitted range')
          const prior = Buffer.alloc(bytes.byteLength)
          await handle.read(prior, 0, prior.length, offset)
          if (!timingSafeEqual(prior, bytes)) throw new HLBridgeError('mobile/chunk-conflict', 'Repeated chunk differs from stored bytes')
          return uploadStatus(upload)
        }
        if (upload.receipt !== undefined) throw new HLBridgeError('mobile/upload-finalized', 'Upload has already been finalized')
        let written = 0
        while (written < bytes.byteLength) {
          const result = await handle.write(bytes, written, bytes.byteLength - written, offset + written)
          if (result.bytesWritten === 0) throw new Error('Staging write made no progress')
          written += result.bytesWritten
        }
        await handle.sync()
        upload.offset += bytes.byteLength
        await this.save(upload)
      } finally { await handle.close() }
      return uploadStatus(upload)
    })
  }

  async finalize(peer: HLPeer<S>, uploadId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    await this.ready
    return this.serialize(uploadId, async () => {
      const upload = this.upload(peer.deviceId, uploadId)
      peer.scope.signal.throwIfAborted()
      signal?.throwIfAborted()
      if (upload.receipt !== undefined) return upload.receipt
      if (upload.offset !== upload.size) throw new HLBridgeError('mobile/upload-incomplete', 'Upload has not received all bytes')
      const controller = new AbortController()
      this.active.set(uploadId, controller)
      const lifetime = AbortSignal.any([peer.scope.signal, controller.signal, ...(signal === undefined ? [] : [signal])])
      try {
        const digest = createHash('sha256')
        for await (const bytes of createReadStream(this.file(uploadId, 'part'), { signal: lifetime })) digest.update(bytes)
        if (digest.digest('hex') !== upload.sha256) throw new HLBridgeError('mobile/upload-hash', 'Attachment checksum did not match')
        lifetime.throwIfAborted()
        this.assertDevice(peer.deviceId)
        const url = new URL('http://dsh.internal/api/session/uploadFileBinary')
        url.searchParams.set('sessionId', upload.sessionId)
        url.searchParams.set('name', upload.name)
        if (upload.mediaType !== undefined) url.searchParams.set('mediaType', upload.mediaType)
        const source = createReadStream(this.file(uploadId, 'part'), { signal: lifetime })
        try {
          const init: RequestInit & { duplex: 'half' } = { method: 'POST', duplex: 'half', signal: lifetime,
            headers: { 'content-type': 'application/octet-stream', 'content-length': String(upload.size) },
            body: Readable.toWeb(source) as ReadableStream<Uint8Array> }
          const response = await this.bridge.fetch(peer, new Request(url, init))
          const result: unknown = await response.json()
          lifetime.throwIfAborted()
          this.assertDevice(peer.deviceId)
          if (!response.ok || !record(result) || result.ok !== true || !record(result.value)
            || typeof result.value.receiptId !== 'string') {
            const error = record(result) && record(result.error) ? result.error : undefined
            throw new HLBridgeError(typeof error?.code === 'string' ? error.code : 'mobile/upload-rejected',
              typeof error?.message === 'string' ? error.message : 'DSH rejected the attachment')
          }
          upload.receipt = { uploadId, ...result.value }
          return upload.receipt
        } finally { source.destroy() }
      } finally { this.active.delete(uploadId) }
    })
  }

  async cancel(deviceId: string, uploadId: string): Promise<{ cancelled: true }> {
    await this.ready
    this.upload(deviceId, uploadId)
    this.active.get(uploadId)?.abort()
    return this.serialize(uploadId, async () => {
      this.uploads.delete(uploadId)
      await this.removeFiles(uploadId)
      return { cancelled: true }
    })
  }

  private async removeFiles(id: string): Promise<void> {
    await Promise.all(['json', 'part', 'json.tmp'].map(suffix => rm(join(this.options.directory, `${id}.${suffix}`), { force: true })))
  }

  async expire(): Promise<void> {
    for (const upload of [...this.uploads.values()]) if (upload.expiresAt <= this.now() && !this.jobs.has(upload.uploadId)) {
      this.uploads.delete(upload.uploadId)
      await this.removeFiles(upload.uploadId)
    }
    for (const [id, download] of this.downloads) if (download.expiresAt <= this.now()) {
      this.downloads.delete(id)
      await rm(this.file(id, 'download'), { force: true })
    }
  }

  async createDownload(peer: HLPeer<S>, params: unknown, signal?: AbortSignal): Promise<{ downloadId: string; length: number; sha256: string; expiresAt: number }> {
    await this.ready
    this.assertDevice(peer.deviceId)
    const result = await this.bridge.readDownload(peer, params, signal)
    if (!record(result) || !(result.data instanceof Uint8Array)) throw new HLBridgeError('mobile/upstream-response', 'DSH returned invalid file bytes')
    const bytes = result.data
    return this.serialize('allocation', async () => {
      this.assertDevice(peer.deviceId)
      peer.scope.signal.throwIfAborted()
      signal?.throwIfAborted()
      await this.expire()
      if (bytes.byteLength > this.maxFileBytes || this.reserved(peer.deviceId) + bytes.byteLength > this.maxDeviceBytes) {
        throw new HLBridgeError('mobile/upload-quota', 'Attachment quota exceeded')
      }
      const downloadId = randomUUID()
      const download: HLDownload = { deviceId: peer.deviceId, length: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), expiresAt: this.now() + this.ttlMs }
      await writeFile(this.file(downloadId, 'download'), bytes, { flag: 'wx', mode: 0o600 })
      this.downloads.set(downloadId, download)
      return { downloadId, length: download.length, sha256: download.sha256, expiresAt: download.expiresAt }
    })
  }

  async readDownload(deviceId: string, downloadId: string, offset: number): Promise<{ bytes: Uint8Array; length: number; sha256: string }> {
    await this.ready
    this.assertDevice(deviceId)
    const download = this.downloads.get(downloadId)
    if (download === undefined || download.deviceId !== deviceId || download.expiresAt <= this.now()) {
      throw new HLBridgeError('mobile/download-not-found', 'Download is unavailable')
    }
    if (nonnegative(offset, 'offset') > download.length) throw new HLBridgeError('mobile/download-offset', 'Offset is outside the file')
    const bytes = (await readFile(this.file(downloadId, 'download'))).subarray(offset)
    this.assertDevice(deviceId)
    return { bytes, length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.ready
    this.revoked.add(deviceId)
    await this.serialize('allocation', async () => {
      const ids = [...this.uploads.values()].filter(u => u.deviceId === deviceId).map(u => u.uploadId)
      for (const id of ids) this.active.get(id)?.abort()
      await Promise.all(ids.map(id => this.serialize(id, async () => { this.uploads.delete(id); await this.removeFiles(id) })))
      for (const [id, download] of this.downloads) if (download.deviceId === deviceId) {
        this.downloads.delete(id)
        await rm(this.file(id, 'download'), { force: true })
      }
    })
  }

  /** Called only after transport has checked a renewed desktop device grant. */
  async authorizeDevice(deviceId: string): Promise<void> {
    await this.ready
    textField(deviceId, 'deviceId')
    await this.serialize('allocation', async () => {
      if (this.closed) throw new HLBridgeError('mobile/device-revoked', 'Attachment manager is closed')
      this.revoked.delete(deviceId)
    })
  }

  async dispose(): Promise<void> {
    this.closed = true
    await this.ready
    for (const controller of this.active.values()) controller.abort()
    await Promise.allSettled([...this.jobs.values()])
    // Upload checkpoints intentionally survive a normal host restart.
    for (const id of this.downloads.keys()) await rm(this.file(id, 'download'), { force: true })
    this.downloads.clear()
  }
}

function nonnegative(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new HLBridgeError('mobile/invalid-params', `${name} must be a nonnegative integer`)
  return value
}
function limit(value: number, name: string): number {
  if (nonnegative(value, name) === 0) throw new HLBridgeError('mobile/invalid-config', `${name} must be positive`)
  return value
}
function hashField(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) throw new HLBridgeError('mobile/invalid-params', 'sha256 must be a hex digest')
  return value.toLowerCase()
}
function uploadStatus(upload: HLUpload) {
  return { uploadId: upload.uploadId, sessionId: upload.sessionId, size: upload.size, offset: upload.offset,
    expiresAt: upload.expiresAt, finalized: upload.receipt !== undefined, maxChunkBytes: MAX_CHUNK_BYTES }
}
function parseUpload(raw: Record<string, unknown>): HLUpload {
  if (nonnegative(raw.offset, 'offset') > nonnegative(raw.size, 'size')) throw new Error('Checkpoint offset exceeds upload size')
  return { uploadId: textField(raw.uploadId, 'uploadId'), deviceId: textField(raw.deviceId, 'deviceId'),
    sessionId: textField(raw.sessionId, 'sessionId'), name: textField(raw.name, 'name'), size: nonnegative(raw.size, 'size'),
    sha256: hashField(raw.sha256), offset: nonnegative(raw.offset, 'offset'), expiresAt: nonnegative(raw.expiresAt, 'expiresAt'),
    ...(raw.mediaType === undefined ? {} : { mediaType: textField(raw.mediaType, 'mediaType') }) }
}
