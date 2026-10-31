import { createHash } from 'node:crypto'
import type { HLKeyValueStore } from './HLSQLiteStore.js'
import { HLError } from '../transport/HLError.js'

interface HLOperation { hash: string; method: string; state: 'dispatching' | 'committed' | 'unknown'; result?: unknown; updatedAt: number }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')

export class HLOperationLedger {
  private readonly inFlight = new Map<string, Promise<unknown>>()
  constructor(private readonly store: HLKeyValueStore) {
    for (const { key, value } of store.list<HLOperation>('operations/')) if (value.state === 'dispatching') store.set(key, { ...value, state: 'unknown' })
  }

  execute(deviceId: string, operationId: string, method: string, params: Record<string, unknown>, run: () => Promise<unknown>): Promise<unknown> {
    const key = `operations/${encodeURIComponent(deviceId)}/${encodeURIComponent(operationId)}`
    const hash = digest({ method, params })
    const previous = this.store.get<HLOperation>(key)
    if (previous && previous.hash !== hash) return Promise.reject(new HLError('OPERATION_CONFLICT', 'An operation id was reused with different content'))
    if (previous?.state === 'committed') return Promise.resolve(previous.result)
    const inFlight = this.inFlight.get(key)
    if (inFlight) return inFlight
    const replaySafe = method === 'sessions.prompt'
    if (previous && !replaySafe) return Promise.reject(new HLError('OPERATION_OUTCOME_UNKNOWN', 'Refresh desktop state before explicitly retrying this operation'))
    if (replaySafe) {
      if (typeof params.requestId !== 'string' || typeof params.sessionId !== 'string') return Promise.reject(new HLError('INVALID_ARGUMENT', 'A prompt requires requestId and sessionId'))
      const promptKey = `prompt-identities/${encodeURIComponent(deviceId)}/${encodeURIComponent(params.sessionId)}/${encodeURIComponent(params.requestId)}`
      const { operationId: _operationId, ...content } = params
      const contentHash = digest(content)
      const existingHash = this.store.get<string>(promptKey)
      if (existingHash && existingHash !== contentHash) return Promise.reject(new HLError('OPERATION_CONFLICT', 'A request id was reused with different content'))
      this.store.set(promptKey, contentHash)
    }
    this.store.set<HLOperation>(key, { method, hash, state: 'dispatching', updatedAt: Date.now() })
    const work = Promise.resolve().then(run).then(result => {
      this.store.set<HLOperation>(key, { method, hash, state: 'committed', result: result ?? null, updatedAt: Date.now() })
      return result
    }, (error: unknown) => {
      this.store.set<HLOperation>(key, { method, hash, state: 'unknown', updatedAt: Date.now() })
      throw error
    }).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, work)
    return work
  }
}
