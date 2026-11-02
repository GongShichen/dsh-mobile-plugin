import type { HLConnectorOperation } from '../ports/HLConnectorPort.js'
import { HLPersonalError } from '../core/HLPersonalValidation.js'

/** An explicit registry. Unknown operation ids can never become arbitrary remote calls. */
export class HLConnectorRegistry {
  private readonly entries = new Map<string, HLConnectorOperation>()
  register(operation: HLConnectorOperation): () => void {
    if (this.entries.has(operation.id)) throw new Error(`Duplicate Personal capability: ${operation.id}`)
    this.entries.set(operation.id, operation)
    return () => { if (this.entries.get(operation.id) === operation) this.entries.delete(operation.id) }
  }
  get(id: string): HLConnectorOperation {
    const entry = this.entries.get(id)
    if (!entry) throw new HLPersonalError('PERSONAL_CAPABILITY_UNAVAILABLE', '当前未连接这项能力')
    return entry
  }
  catalog(): Array<{ id: string; effect: string; description: string }> {
    return [...this.entries.values()].map(({ id, effect, description }) => ({ id, effect, description }))
  }
}
