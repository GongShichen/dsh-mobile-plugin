import { HLBridgeError, record } from '../bridge/HLBridgeError.ts'

/** Listen before reading; queued invalidations always cause another complete authoritative read. */
export async function* permissionCatalogStream(events: AsyncIterable<unknown>, read: () => Promise<unknown>, signal: AbortSignal): AsyncIterable<unknown> {
  const iterator = events[Symbol.asyncIterator]()
  try {
    const ready = await iterator.next()
    if (ready.done || !record(ready.value) || ready.value.type !== 'ready') throw new HLBridgeError('mobile/missing-baseline', 'Permission catalog events are not ready')
    const baseline = await read(); signal.throwIfAborted()
    yield { type: 'baseline', value: baseline }
    while (!signal.aborted) {
      const frame = await iterator.next()
      if (frame.done) return
      if (record(frame.value) && frame.value.type === 'emit' && frame.value.event === 'permission-presets/catalog-changed') {
        const value = await read(); signal.throwIfAborted(); yield { type: 'baseline', value }
      }
    }
  } finally { await iterator.return?.() }
}
