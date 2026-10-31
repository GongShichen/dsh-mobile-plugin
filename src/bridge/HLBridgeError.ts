/** Stable failures raised before a request enters DSH. DSH Remote errors retain their codes. */
export class HLBridgeError extends Error {
  readonly retryable: boolean
  constructor(readonly code: string, message: string, retryable = false) {
    super(message)
    this.name = 'HLBridgeError'
    this.retryable = retryable
  }
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function paramsOf(value: unknown): Record<string, unknown> {
  if (!record(value)) throw new HLBridgeError('mobile/invalid-params', 'Expected an object')
  return value
}

export function textField(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new HLBridgeError('mobile/invalid-params', `${name} must be a nonempty string`)
  }
  return value
}
