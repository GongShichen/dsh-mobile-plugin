import test from 'node:test'
import assert from 'node:assert/strict'
import { FrameWriter, encodeFrame, readFrame, MAX_FRAME_BYTES, MAX_LOGICAL_JSON_BYTES, JSON_CHUNK_BYTES } from '../src/transport/framing.js'

function reader(bytes: Uint8Array) {
  let position = 0
  return { async readExact(length: number) { const data = bytes.slice(position, position + length); position += length; return data } }
}

test('large Unicode snapshots use bounded raw chunks and cannot interleave the next logical message', async () => {
  const writes: Uint8Array[] = []
  const writer = new FrameWriter({ async writeAll(bytes) { writes.push(Uint8Array.from(bytes)); await Promise.resolve() } })
  const snapshot = { v: 1, type: 'event', subscriptionId: 's', generation: 'g', event: { type: 'snapshot', text: '中文🐋\n'.repeat(180_000) } }
  const next = { v: 1, type: 'notice', name: 'push-configuration-changed' }
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) > MAX_FRAME_BYTES)
  await Promise.all([writer.write(snapshot), writer.write(next)])
  assert.ok(writes.slice(1, -1).every(part => part.length <= JSON_CHUNK_BYTES))
  const stream = reader(Buffer.concat(writes))
  assert.deepEqual(await readFrame(stream, { allowLarge: true }), snapshot)
  assert.deepEqual(await readFrame(stream, { allowLarge: true }), next)
  await assert.rejects(readFrame(reader(writes[0])), { code: 'LARGE_REQUEST_NOT_ALLOWED' })
})

test('large-message lengths are validated before allocation and partial bodies cannot become messages', async () => {
  for (const length of [MAX_LOGICAL_JSON_BYTES + 1, MAX_FRAME_BYTES, -1, 1.5, '2000000']) {
    await assert.rejects(readFrame(reader(encodeFrame({ v: 1, type: 'json-chunks', length })), { allowLarge: true }), { code: 'INVALID_CHUNK_LENGTH' })
  }
  const header = encodeFrame({ v: 1, type: 'json-chunks', length: MAX_FRAME_BYTES + 1 })
  await assert.rejects(readFrame(reader(Buffer.concat([header, Buffer.alloc(100)])), { allowLarge: true }), { code: 'TRUNCATED_FRAME' })
  await assert.rejects(readFrame(reader(Buffer.concat([header, Buffer.alloc(MAX_FRAME_BYTES + 1, 255)])), { allowLarge: true }), { code: 'INVALID_FRAME' })
  const writer = new FrameWriter({ async writeAll() { throw Error('should not write') } })
  await assert.rejects(writer.write('x'.repeat(MAX_LOGICAL_JSON_BYTES)), { code: 'FRAME_TOO_LARGE' })
})

test('a broken large-message write poisons the stream and prevents subsequent messages from entering its body', async () => {
  let writes = 0
  const writer = new FrameWriter({ async writeAll() { if (++writes === 2) throw Error('connection closed') } })
  const large = writer.write({ text: '🐋'.repeat(300_000) })
  const next = writer.write({ message: 'must not follow a partial payload' })
  await assert.rejects(large, /connection closed/)
  await assert.rejects(next, /connection closed/)
  assert.equal(writes, 2)
})

test('the full 16 MiB logical boundary fits the writer queue including its separate header', async () => {
  let header: Uint8Array | undefined
  let rawBytes = 0
  const writer = new FrameWriter({ async writeAll(bytes) { if (!header) header = Uint8Array.from(bytes); else rawBytes += bytes.length } })
  await writer.write('x'.repeat(MAX_LOGICAL_JSON_BYTES - 2))
  assert.equal(rawBytes, MAX_LOGICAL_JSON_BYTES)
  assert.ok(header)
  const size = Buffer.from(header).readUInt32BE(0)
  assert.deepEqual(JSON.parse(Buffer.from(header).subarray(4, 4 + size).toString()), { v: 1, type: 'json-chunks', length: MAX_LOGICAL_JSON_BYTES })
})
