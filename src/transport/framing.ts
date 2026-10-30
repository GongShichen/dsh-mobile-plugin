import { MobileError } from './errors.js'

export const MAX_FRAME_BYTES = 1024 * 1024
export const MAX_LOGICAL_JSON_BYTES = 16 * 1024 * 1024
export const JSON_CHUNK_BYTES = 64 * 1024
export interface ByteReader { readExact(length: number): Promise<Array<number> | Uint8Array> }
export interface ByteWriter { writeAll(bytes: Array<number>): Promise<void> }

function parseJson(body: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown }
  catch { throw new MobileError('INVALID_FRAME', 'Frame is not valid UTF-8 JSON') }
}

/** The host never opts into large inbound messages; only client-side readers may do so. */
export async function readFrame(reader: ByteReader, options: { allowLarge?: boolean } = {}): Promise<unknown> {
  const header = Buffer.from(await reader.readExact(4))
  if (header.length !== 4) throw new MobileError('TRUNCATED_FRAME', 'Incomplete frame header')
  const size = header.readUInt32BE(0)
  if (size === 0 || size > MAX_FRAME_BYTES) throw new MobileError('FRAME_TOO_LARGE', 'Invalid frame length')
  const body = Buffer.from(await reader.readExact(size))
  if (body.length !== size) throw new MobileError('TRUNCATED_FRAME', 'Incomplete frame body')
  const value = parseJson(body)
  if (value && typeof value === 'object' && 'type' in value && value.type === 'json-chunks') {
    if (!options.allowLarge) throw new MobileError('LARGE_REQUEST_NOT_ALLOWED', 'Large JSON requests are not accepted by the desktop')
    const chunk = value as Record<string, unknown>
    const length = chunk.length
    if (chunk.v !== 1 || typeof length !== 'number' || !Number.isSafeInteger(length) || length <= MAX_FRAME_BYTES || length > MAX_LOGICAL_JSON_BYTES) {
      throw new MobileError('INVALID_CHUNK_LENGTH', 'Invalid logical JSON byte length')
    }
    const raw = Buffer.allocUnsafe(length)
    for (let offset = 0; offset < length; offset += JSON_CHUNK_BYTES) {
      const count = Math.min(JSON_CHUNK_BYTES, length - offset)
      let part: Array<number> | Uint8Array
      try { part = await reader.readExact(count) }
      catch { throw new MobileError('TRUNCATED_FRAME', 'Incomplete logical JSON message') }
      if (part.length !== count) throw new MobileError('TRUNCATED_FRAME', 'Incomplete logical JSON message')
      raw.set(part, offset)
    }
    const complete = parseJson(raw)
    if (complete && typeof complete === 'object' && 'type' in complete && complete.type === 'json-chunks') throw new MobileError('INVALID_FRAME', 'Nested logical JSON envelopes are not allowed')
    return complete
  }
  return value
}

export function encodeFrame(value: unknown): Uint8Array {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new MobileError('INVALID_FRAME', 'Cannot encode an empty frame')
  const body = Buffer.from(serialized)
  if (body.length > MAX_FRAME_BYTES) throw new MobileError('FRAME_TOO_LARGE', 'Frame exceeds the negotiated limit')
  const frame = Buffer.allocUnsafe(body.length + 4)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

/** Serializes writes without allowing an unbounded producer queue. */
export class FrameWriter {
  private tail = Promise.resolve()
  private queued = 0
  private queuedBytes = 0
  private failed = false
  private failure?: unknown
  constructor(private readonly writer: ByteWriter, private readonly maxQueued = 64, private readonly maxQueuedBytes = MAX_LOGICAL_JSON_BYTES * 2) {}
  write(value: unknown): Promise<void> {
    if (this.failed) return Promise.reject(this.failure)
    if (this.queued >= this.maxQueued) return Promise.reject(new MobileError('BACKPRESSURE', 'Peer is not consuming data', true))
    const json = JSON.stringify(value)
    if (json === undefined) return Promise.reject(new MobileError('INVALID_FRAME', 'Cannot encode an empty frame'))
    const length = Buffer.byteLength(json)
    if (length > MAX_LOGICAL_JSON_BYTES) return Promise.reject(new MobileError('FRAME_TOO_LARGE', 'Logical JSON exceeds the negotiated limit'))
    if (this.queuedBytes + length > this.maxQueuedBytes) return Promise.reject(new MobileError('BACKPRESSURE', 'Peer is not consuming data', true))
    const body = Buffer.from(json)
    let parts: Uint8Array[]
    if (length <= MAX_FRAME_BYTES) {
      const header = Buffer.allocUnsafe(4)
      header.writeUInt32BE(length)
      // Preserve the small frame's single write for existing clients and callers.
      parts = [Buffer.concat([header, body])]
    } else {
      parts = [encodeFrame({ v: 1, type: 'json-chunks', length })]
      for (let offset = 0; offset < length; offset += JSON_CHUNK_BYTES) parts.push(body.subarray(offset, offset + JSON_CHUNK_BYTES))
    }
    this.queued++
    this.queuedBytes += length
    const work = this.tail.then(async () => {
      if (this.failed) throw this.failure
      try { for (const part of parts) await this.writer.writeAll(Array.from(part)) }
      catch (error) { this.failed = true; this.failure = error; throw error }
    })
    // No message may follow a partly-written header/body: the connection owner closes it.
    const release = () => { this.queued--; this.queuedBytes -= length }
    this.tail = work.then(release, release)
    return work
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MobileError('INVALID_ARGUMENT', 'Expected an object')
  return value as Record<string, unknown>
}

export function stringField(value: Record<string, unknown>, key: string, maximum = 256): string {
  const field = value[key]
  if (typeof field !== 'string' || field.length === 0 || field.length > maximum) throw new MobileError('INVALID_ARGUMENT', `Invalid ${key}`)
  return field
}

export function integerField(value: Record<string, unknown>, key: string, maximum: number): number {
  const field = value[key]
  if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < 0 || field > maximum) throw new MobileError('INVALID_ARGUMENT', `Invalid ${key}`)
  return field
}
