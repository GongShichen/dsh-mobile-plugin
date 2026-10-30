export class MobileError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) { super(message); this.name = 'MobileError' }
}

export function publicError(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof MobileError) return { code: error.code, message: error.message, retryable: error.retryable }
  // Preserve domain errors without reflecting arbitrary exception text or secrets.
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return { code: error.code, message: 'The desktop could not complete this operation.', retryable: false }
  }
  return { code: 'INTERNAL_ERROR', message: 'The desktop could not complete this operation.', retryable: false }
}
