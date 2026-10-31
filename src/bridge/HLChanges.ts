import { HLBridgeError, textField } from './HLBridgeError.ts'
import type { HLParams } from './HLBridgeTypes.ts'

/** Only announced Session coordinates may address the official read-only Web routes. */
export async function readChanges(method: string, params: HLParams, fetch: (request: Request) => Promise<Response>, signal: AbortSignal): Promise<unknown> {
  const diff = method === 'changes.diff'
  const fields = diff ? ['sessionId', 'seq', 'index'] : ['sessionId', 'seq']
  if (Object.keys(params).some(key => !fields.includes(key))) throw new HLBridgeError('mobile/invalid-params', 'Only change coordinates are accepted')
  const sessionId = textField(params.sessionId, 'sessionId')
  const query = new URLSearchParams({ sessionId })
  for (const key of fields.slice(1)) {
    const value = params[key]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new HLBridgeError('mobile/invalid-params', `Invalid ${key}`)
    query.set(key, String(value))
  }
  const response = await fetch(new Request(`http://dsh.internal/api/${method}?${query}`, { signal }))
  signal.throwIfAborted()
  // A missing route or expired Host snapshot is never an empty change set.
  if (response.status === 404) return { status: 'unavailable' }
  if (!response.ok) throw new HLBridgeError('mobile/changes-unavailable', '桌面暂时无法读取文件改动，请重试')
  const value: unknown = await response.json()
  signal.throwIfAborted()
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HLBridgeError('mobile/invalid-changes', 'Invalid desktop change response')
  const data = value as Record<string, unknown>
  if (diff) return { status: 'available', diff: data }
  // Match the public Web DTO; working directories and private Git tree ids stay on the Host.
  const { turn, files, total, added, deleted } = data
  return { status: 'available', summary: { turn, files, total, added, deleted } }
}
