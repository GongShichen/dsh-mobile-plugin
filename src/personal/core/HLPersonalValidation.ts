/** Safe domain errors are translated to the existing wire error at the API adapter. */
export class HLPersonalError extends Error {
  constructor(readonly code: string, message: string, readonly details?: { sessionId?: string; workspaceId?: string; cwd?: string }) { super(message); this.name = 'HLPersonalError' }
}
export function hlObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HLPersonalError('PERSONAL_INPUT', '请求格式无效')
  return value as Record<string, unknown>
}
export function hlText(value: unknown, field: string, limit = 4000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) throw new HLPersonalError('PERSONAL_INPUT', `${field}不能为空，且不能超过 ${limit} 个字符`)
  return value.trim()
}
export function hlRevision(value: unknown, actual: number): void {
  if (!Number.isSafeInteger(value) || value !== actual) throw new HLPersonalError('PERSONAL_CONFLICT', '内容已在另一端更新，请刷新后重试')
}
export function hlInteger(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new HLPersonalError('PERSONAL_INPUT', `${field}必须在 ${min} 到 ${max} 之间`)
  return value as number
}
export function hlCanonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(hlCanonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => JSON.stringify(key) + ':' + hlCanonical(item)).join(',') + '}'
  return JSON.stringify(value) ?? 'null'
}
/** Latin tokens and Chinese bigrams provide local recall without an embedding dependency. */
export function hlTerms(text: string): Set<string> {
  const lower = text.normalize('NFKC').toLocaleLowerCase()
  const terms = new Set(lower.match(/[\p{L}\p{N}_-]+/gu) ?? [])
  for (const run of lower.match(/[\p{Script=Han}]+/gu) ?? []) {
    for (let i = 0; i < run.length - 1; i++) terms.add(run.slice(i, i + 2))
    if (run.length === 1) terms.add(run)
  }
  return terms
}
export function hlPriority(value: unknown): 'high' | 'normal' | 'low' {
  if (value === undefined) return 'normal'
  if (value !== 'high' && value !== 'normal' && value !== 'low') throw new HLPersonalError('PERSONAL_INPUT', '优先级无效')
  return value
}
