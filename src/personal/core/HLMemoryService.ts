import type { HLPersonalPersistence } from '../ports/HLPersonalPersistence.js'
import type { HLPersonalMemory, HLPersonalSource } from './HLPersonalTypes.js'
import { HLPersonalError, hlRevision, hlTerms, hlText } from './HLPersonalValidation.js'

/** Explicit user statements only. External documents never become personal memory automatically. */
export class HLMemoryService {
  constructor(private readonly store: HLPersonalPersistence, private readonly id: () => string, private readonly now: () => number) {}
  search(query: string, limit = 12): HLPersonalMemory[] {
    const terms = hlTerms(query)
    return this.store.list('memory').filter(row => row.expiresAt === undefined || row.expiresAt > this.now())
      .map(row => ({ row, score: [...terms].reduce((score, term) => score + (row.text.toLocaleLowerCase().includes(term) ? 1 : 0), 0) }))
      .filter(item => !query || item.score > 0).sort((a, b) => b.score - a.score || b.row.updatedAt - a.row.updatedAt).slice(0, limit).map(item => item.row)
  }
  put(params: Record<string, unknown>, source: HLPersonalSource): HLPersonalMemory {
    const text = hlText(params.text, '记忆内容', 2000)
    if (/-----BEGIN|\bBearer\s+\S+|\bsk-[a-zA-Z0-9_-]{12,}|(?:password|private_key|refresh_token)\s*[:=]/i.test(text)) throw new HLPersonalError('PERSONAL_MEMORY_SECRET', '请在账户连接中保存凭据，不将密钥写入记忆')
    const kind = params.kind ?? 'fact'
    if (kind !== 'fact' && kind !== 'preference') throw new HLPersonalError('PERSONAL_INPUT', '记忆类型无效')
    const previous = typeof params.memoryId === 'string' ? this.store.get('memory', params.memoryId) : undefined
    if (params.memoryId !== undefined && !previous) throw new HLPersonalError('PERSONAL_NOT_FOUND', '记忆不存在')
    if (previous) hlRevision(params.revision, previous.revision)
    let quote: string | undefined
    if (source.kind === 'assistant') {
      quote = hlText(params.quote, '原话', 2000)
      const input = this.store.list('input', 20).find(row => row.sessionId === source.sessionId && row.text.includes(quote!))
      if (!input) throw new HLPersonalError('PERSONAL_MEMORY_SOURCE', '自动记忆必须能定位到用户明确表达的原话')
      source = { ...source, id: input.id }
      const forgotten = this.store.get('marker', `forgotten-input:${input.id}`)
      if (forgotten) throw new HLPersonalError('PERSONAL_MEMORY_FORGOTTEN', '这条信息已被用户遗忘')
    }
    if (!previous) {
      const same = this.store.list('memory').find(row => row.text === text && row.kind === kind)
      if (same) return same
      if (this.store.list('memory').length >= 2000) throw new HLPersonalError('PERSONAL_LIMIT', '记忆数量已达上限，请先整理')
    }
    const expiresAt = params.expiresAt
    if (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || Number(expiresAt) <= this.now())) throw new HLPersonalError('PERSONAL_INPUT', '记忆有效期必须在未来')
    const row: HLPersonalMemory = { id: previous?.id ?? this.id(), kind, text, source, ...(quote ? { quote } : {}),
      revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? this.now(), updatedAt: this.now(),
      ...(expiresAt === undefined ? {} : { expiresAt: Number(expiresAt) }) }
    this.store.put('memory', row); return row
  }
  forget(params: Record<string, unknown>): void {
    const row = this.store.get('memory', hlText(params.memoryId, '记忆 ID', 128))
    if (!row) throw new HLPersonalError('PERSONAL_NOT_FOUND', '记忆不存在')
    hlRevision(params.revision, row.revision)
    if (row.quote) this.store.put('marker', { id: `forgotten-input:${row.source.id}`, value: 'forgotten' })
    this.store.remove('memory', row.id)
  }
}
