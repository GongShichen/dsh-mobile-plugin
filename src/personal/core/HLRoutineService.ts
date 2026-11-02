import type { HLAgentExecutionPort } from '../ports/HLAgentExecutionPort.js'
import type { HLPersonalPersistence } from '../ports/HLPersonalPersistence.js'
import type { HLSchedulePort } from '../ports/HLSchedulePort.js'
import type { HLJson, HLPersonalRoutine } from './HLPersonalTypes.js'
import { HLPersonalError, hlObject, hlRevision, hlText } from './HLPersonalValidation.js'
import { hlExecutionTarget } from './HLExecutionTargetResolver.js'
import type { HLTaskCoordinator } from './HLTaskCoordinator.js'

/** A schedule receipt identifies work; model-supplied ids and timestamps grant no authority. */
export class HLRoutineService {
  private readonly pending = new Map<string, Promise<void>>()
  constructor(private readonly store: HLPersonalPersistence, private readonly execution: HLAgentExecutionPort,
    private readonly schedule: HLSchedulePort, private readonly tasks: HLTaskCoordinator,
    private readonly directory: (id: string) => string, private readonly id: () => string,
    private readonly now: () => number, private readonly changed: () => void) {
    this.store.transaction(() => {
      for (const row of this.store.list('routine').filter(row => row.state === 'creating' && row.scheduleAttempted)) {
        this.store.put('routine', { ...row, state: 'unknown', errorCode: 'PERSONAL_SCHEDULE_INTERRUPTED', revision: row.revision + 1, updatedAt: this.now() })
      }
    })
  }
  create(params: Record<string, unknown>): HLPersonalRoutine {
    const timing = hlObject(params.timing)
    if (!['after', 'at', 'every', 'daily', 'weekly', 'cron', 'rrule'].includes(String(timing.kind))) throw new HLPersonalError('PERSONAL_INPUT', '定时规则无效')
    if (this.schedule.timingKinds && !this.schedule.timingKinds.includes(String(timing.kind))) throw new HLPersonalError('PERSONAL_TIMING_UNSUPPORTED', '当前适配器不支持这种时间规则，请使用支持的每日、每周或 cron 规则')
    const goalId = typeof params.goalId === 'string' && params.goalId ? params.goalId : undefined
    if (goalId && this.store.get('goal', goalId)?.state !== 'active') throw new HLPersonalError('PERSONAL_GOAL_INACTIVE', '目标不存在或已暂停')
    const time = this.now()
    const accountIds = params.accountIds === undefined ? [] : Array.isArray(params.accountIds) && params.accountIds.length <= 20 ? params.accountIds.map(value => hlText(value, '账户 ID', 128))
      : (() => { throw new HLPersonalError('PERSONAL_INPUT', '账户范围无效') })()
    if (accountIds.some(id => this.store.get('connection', id)?.state !== 'connected')) throw new HLPersonalError('PERSONAL_CONNECTION_REQUIRED', '所选账户未连接')
    const routine: HLPersonalRoutine = { id: this.id(), title: hlText(params.title, '规则名称', 120), instruction: hlText(params.instruction, '规则内容', 8000),
      target: hlExecutionTarget(params.target), ...(goalId ? { goalId } : {}), timing: timing as HLJson,
      accountIds, ingressSessionId: this.id(), state: 'creating', revision: 1, createdAt: time, updatedAt: time }
    if (params.resultKind !== undefined) {
      if (!['text', 'files', 'email', 'calendar', 'session'].includes(String(params.resultKind))) throw new HLPersonalError('PERSONAL_INPUT', '结果要求无效')
      routine.resultKind = params.resultKind as NonNullable<HLPersonalRoutine['resultKind']>
    }
    this.store.put('routine', routine); return routine
  }
  edit(params: Record<string, unknown>, signal: AbortSignal): HLPersonalRoutine {
    const row = this.store.get('routine', hlText(params.routineId, '规则 ID', 128))
    if (!row) throw new HLPersonalError('PERSONAL_NOT_FOUND', '规则不存在')
    if (this.pending.has(row.id)) throw new HLPersonalError('PERSONAL_RULE_BUSY', '规则正在与桌面同步，请稍后再试')
    if (row.state === 'unknown') throw new HLPersonalError('PERSONAL_RULE_UNKNOWN', '规则的上次操作结果待核实，请在 DSH 自动化任务中核对')
    hlRevision(params.revision, row.revision)
    if (typeof params.active !== 'boolean') throw new HLPersonalError('PERSONAL_INPUT', '请选择启用或暂停')
    const next: HLPersonalRoutine = { ...row, state: params.active ? row.scheduleId ? 'active' : 'creating' : 'paused', revision: row.revision + 1, updatedAt: this.now() }
    this.store.put('routine', next)
    if (row.scheduleId) queueMicrotask(() => this.track(row.id, this.schedule.edit(row.scheduleId!, params.active as boolean, signal).then(result => {
      if (result !== 'removed') return
      const current = this.store.get('routine', row.id)
      if (current) { this.store.transaction(() => this.store.put('routine', { ...current, scheduleId: undefined, scheduleAttempted: false, revision: current.revision + 1, updatedAt: this.now() })); this.changed() }
    }).catch(() => {
      const current = this.store.get('routine', row.id)
      if (current) { this.store.transaction(() => this.store.put('routine', { ...current, state: 'unknown', revision: current.revision + 1, updatedAt: this.now() })); this.changed() }
    })))
    return next
  }
  async pump(signal: AbortSignal): Promise<void> {
    for (const row of this.store.list('routine')) {
      if (this.pending.has(row.id)) continue
      if (row.state === 'creating') this.track(row.id, this.install(row, signal))
      else if (row.state === 'active' && row.scheduleId && (!row.goalId || this.store.get('goal', row.goalId)?.state === 'active')) this.track(row.id, this.claim(row, signal))
    }
  }
  timingKinds(): readonly string[] { return this.schedule.timingKinds ?? ['after', 'at', 'every', 'daily', 'weekly', 'cron', 'rrule'] }
  async reconcile(params: Record<string, unknown>, signal: AbortSignal): Promise<HLPersonalRoutine> {
    const row = this.store.get('routine', hlText(params.routineId, '规则 ID', 128))
    if (!row) throw new HLPersonalError('PERSONAL_NOT_FOUND', '规则不存在')
    hlRevision(params.revision, row.revision)
    if (row.state !== 'unknown' || this.pending.has(row.id)) throw new HLPersonalError('PERSONAL_RULE_BUSY', '当前规则不需要核对')
    if (!this.schedule.find || !row.ingressSessionId) throw new HLPersonalError('PERSONAL_SCHEDULE_UNAVAILABLE', '请在 DSH 自动化任务中核对该规则')
    const matches = await this.schedule.find(row.ingressSessionId, signal)
    if (matches.length > 1) throw new HLPersonalError('PERSONAL_SCHEDULE_AMBIGUOUS', '该规则存在多个定时记录，请在桌面保留一份后再核对')
    const current = this.store.get('routine', row.id)!
    hlRevision(row.revision, current.revision)
    const next: HLPersonalRoutine = { ...current, scheduleId: matches[0]?.id, scheduleAttempted: matches.length > 0,
      state: matches[0]?.active ? 'active' : 'paused', errorCode: undefined, revision: current.revision + 1, updatedAt: this.now() }
    this.store.transaction(() => this.store.put('routine', next)); this.changed(); return next
  }
  private async install(row: HLPersonalRoutine, signal: AbortSignal): Promise<void> {
    try {
      const binding = await this.execution.ensureSession({ role: 'scheduler', requestedId: row.ingressSessionId!, directory: this.directory(row.id), target: { kind: 'internal' } }, signal)
      this.store.transaction(() => this.store.put('routine', { ...row, ingressSessionId: binding.sessionId, revision: row.revision + 1, updatedAt: this.now() })); this.changed()
      this.store.transaction(() => this.store.put('routine', { ...this.store.get('routine', row.id)!, scheduleAttempted: true }))
      const scheduleId = await this.schedule.create({ title: row.title, timing: row.timing, sessionId: binding.sessionId,
        prompt: 'This is a Harness Link schedule delivery. Call hl_personal_claim_scheduled once. Do not create work from this message or request unrelated capabilities.' }, signal)
      const current = this.store.get('routine', row.id)!
      this.store.transaction(() => this.store.put('routine', { ...current, scheduleId, state: current.state === 'paused' ? 'paused' : 'active', revision: current.revision + 1, updatedAt: this.now() })); this.changed()
      if (current.state === 'paused') {
        const result = await this.schedule.edit(scheduleId, false, signal)
        if (result === 'removed') this.store.transaction(() => this.store.put('routine', { ...this.store.get('routine', row.id)!, scheduleId: undefined }))
      }
    } catch (error) {
      const current = this.store.get('routine', row.id)
      if (current) { this.store.transaction(() => this.store.put('routine', { ...current, state: 'unknown', errorCode: error instanceof HLPersonalError ? error.code : 'PERSONAL_SCHEDULE_UNAVAILABLE', revision: current.revision + 1, updatedAt: this.now() })); this.changed() }
    }
  }
  async claim(row: HLPersonalRoutine, signal: AbortSignal): Promise<void> {
    if (!row.scheduleId || row.state !== 'active') return
    // Collapse missed runs to the latest receipt, as the Host's scheduler does.
    const receipts = await this.schedule.history(row.scheduleId, signal)
    const receipt = receipts[0]
    if (!receipt || receipt.targetSessionId !== row.ingressSessionId) return
    const key = `routine-delivery:${row.id}:${receipt.scheduledAt}`
    if (this.store.get('marker', key)) return
    const previousWork = this.store.list('task').some(task => task.source.kind === 'routine' && task.source.id === row.id && !['completed', 'failed', 'cancelled'].includes(task.state))
    if (previousWork) return
    this.store.transaction(() => {
      if (this.store.get('marker', key) || this.store.get('routine', row.id)?.state !== 'active') return
      const task = this.tasks.create({ title: row.title, instruction: row.instruction, goalId: row.goalId, target: row.target, resultKind: row.resultKind, accountIds: row.accountIds ?? [] }, { kind: 'routine', id: row.id })
      this.store.put('marker', { id: key, value: task.id })
    }); this.changed()
  }
  private track(id: string, work: Promise<void>): void {
    this.pending.set(id, work); void work.catch(() => undefined).finally(() => { if (this.pending.get(id) === work) this.pending.delete(id) })
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.pending.values()]) }
}
