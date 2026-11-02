import type { HLPersonalPersistence } from '../ports/HLPersonalPersistence.js'
import type { HLPersonalWakeup } from './HLPersonalTypes.js'
import { HLPersonalError, hlInteger, hlText } from './HLPersonalValidation.js'
import type { HLPersonalTriggerSource } from '../ports/HLPersonalTriggerSource.js'

/** Durable one-shot continuation; recurring calendar semantics belong to DSH Schedule. */
export class HLWakeupService {
  private readonly sources = new Map<string, HLPersonalTriggerSource>()
  private polling = false
  constructor(private readonly store: HLPersonalPersistence, private readonly id: () => string, private readonly now: () => number) {}
  create(taskId: string, params: Record<string, unknown>): HLPersonalWakeup {
    const task = this.store.get('task', taskId)
    if (!task || ['completed', 'cancelled', 'failed'].includes(task.state)) throw new HLPersonalError('PERSONAL_TASK_INACTIVE', '事务已结束')
    const sourceId = params.sourceId === undefined ? undefined : hlText(params.sourceId, '事件来源', 128)
    const source = sourceId ? this.sources.get(sourceId) : undefined
    if (sourceId && !source) throw new HLPersonalError('PERSONAL_SOURCE_UNAVAILABLE', '这项跟进来源尚未连接')
    const sourceParams = source?.parse(taskId, params.params)
    const wake: HLPersonalWakeup = { id: this.id(), taskId, at: hlInteger(params.at, source ? '等待截止时间' : '继续时间', this.now() + 1000, this.now() + 30 * 86400_000),
      reason: hlText(params.reason, '跟进原因', 240), state: 'pending', createdAt: this.now(),
      ...(sourceId ? { sourceId, sourceParams, nextCheckAt: this.now() } : {}) }
    this.store.put('wakeup', wake); return wake
  }
  consume(): void {
    for (const wake of this.store.list('wakeup').filter(row => row.state === 'pending' && (row.matched || row.at <= this.now()))) {
      const task = this.store.get('task', wake.taskId)
      if (!task || ['completed', 'cancelled', 'failed'].includes(task.state)) { this.store.put('wakeup', { ...wake, state: 'cancelled' }); continue }
      if (task.goalId && this.store.get('goal', task.goalId)?.state !== 'active') continue
      if (!['waiting', 'interrupted'].includes(task.state)) continue
      if (wake.sourceId && !wake.matched) {
        this.store.put('wakeup', { ...wake, state: 'cancelled' })
        this.store.put('task', { ...task, waitReason: 'event-expired', summary: '等待外部变化的期限已到，请决定后续处理', revision: task.revision + 1, updatedAt: this.now() })
        this.store.put('notice', { id: this.id(), taskId: task.id, summary: `${task.title}：等待外部变化的期限已到。`, state: 'queued', attempts: 0, retryAt: this.now(), createdAt: this.now() })
        continue
      }
      this.store.put('wakeup', { ...wake, state: 'consumed' })
      this.store.put('task', { ...task, state: 'queued', waitReason: undefined, summary: `继续跟进：${wake.reason}`, revision: task.revision + 1, updatedAt: this.now() })
    }
  }
  hasDue(): boolean { return this.store.list('wakeup').some(row => row.state === 'pending' && (row.matched || row.at <= this.now())) }
  catalog(): Array<{ id: string; description: string }> { return [...this.sources.values()].map(({ id, description }) => ({ id, description })) }
  register(source: HLPersonalTriggerSource): () => void {
    if (this.sources.has(source.id)) throw new Error('Duplicate Personal trigger source')
    this.sources.set(source.id, source)
    return () => { if (this.sources.get(source.id) === source) this.sources.delete(source.id) }
  }
  async poll(signal: AbortSignal, changed: () => void): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      for (const row of this.store.list('wakeup').filter(row => row.state === 'pending' && row.sourceId && !row.matched && row.at > this.now() && (row.nextCheckAt ?? 0) <= this.now()).slice(0, 5)) {
        const task = this.store.get('task', row.taskId)
        if (!task || ['completed', 'cancelled', 'failed'].includes(task.state)) continue
        if (task.goalId && this.store.get('goal', task.goalId)?.state !== 'active') continue
        const source = this.sources.get(row.sourceId!)
        if (!source) continue
        try {
          const result = await source.poll(row.taskId, row.sourceParams ?? {}, row.cursor, signal)
          if (signal.aborted) return
          this.store.transaction(() => {
            const current = this.store.get('wakeup', row.id)
            if (current?.state !== 'pending') return
            this.store.put('wakeup', { ...current, ...(result.cursor ? { cursor: result.cursor } : {}), matched: result.events.length > 0, nextCheckAt: this.now() + 300_000 })
          }); changed()
        } catch {
          if (signal.aborted) return
          this.store.transaction(() => this.store.put('wakeup', { ...row, nextCheckAt: this.now() + 300_000 }))
        }
      }
    } finally { this.polling = false }
  }
}
