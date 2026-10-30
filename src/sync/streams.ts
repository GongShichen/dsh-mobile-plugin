import { BridgeError, record } from '../bridge/errors.ts'

/** Consume a snapshot stream once, releasing its upstream subscription on every exit. */
export async function firstFrame(stream: AsyncIterable<unknown>): Promise<unknown> {
  for await (const value of stream) return value
  throw new BridgeError('mobile/missing-baseline', 'DSH stream ended before its baseline')
}

/** Open the event subscription before reading the list, so list/read races remain observable. */
export async function* sessionListStream(
  events: AsyncIterable<unknown>,
  readList: () => Promise<unknown>,
  signal: AbortSignal,
): AsyncIterable<unknown> {
  const iterator = events[Symbol.asyncIterator]()
  try {
    const ready = await iterator.next()
    if (ready.done || !record(ready.value) || ready.value.type !== 'ready') {
      throw new BridgeError('mobile/missing-baseline', 'DSH events did not become ready')
    }
    // DSH attaches the listeners before ready; its queue buffers events during this read.
    const value = await readList()
    signal.throwIfAborted()
    yield { type: 'baseline', value }
    while (!signal.aborted) {
      const item = await iterator.next()
      if (item.done) return
      if (record(item.value) && item.value.type === 'emit'
        && typeof item.value.event === 'string' && item.value.event.startsWith('api-session/')) {
        yield item.value
      }
    }
  } finally {
    await iterator.return?.()
  }
}
