import type { HLPersonalPersistence } from '../ports/HLPersonalPersistence.js'
import type { HLJson, HLPersonalAction } from '../core/HLPersonalTypes.js'
import { HLAuthorizationService } from '../core/HLAuthorizationService.js'
import { HLPersonalError, hlCanonical, hlObject, hlText } from '../core/HLPersonalValidation.js'
import { HLConnectorRegistry } from './HLConnectorRegistry.js'
import { HLResourceCoordinator } from './HLResourceCoordinator.js'
import { hlCalendarDigest, hlCalendarWatchKey } from './google/HLCalendarChangeSource.js'

/** Every write is prepared durably, then committed by stable action id. */
export class HLActionBroker {
  private readonly resources = new HLResourceCoordinator()
  constructor(private readonly store: HLPersonalPersistence, readonly registry: HLConnectorRegistry,
    private readonly grants: HLAuthorizationService, private readonly id: () => string, private readonly now: () => number,
    private readonly changed: () => void) {}
  prepare(taskId: string, operationId: string, accountId: string, input: unknown): HLPersonalAction {
    const task = this.store.get('task', taskId)
    if (!task || ['completed', 'failed', 'cancelled'].includes(task.state)) throw new HLPersonalError('PERSONAL_TASK_INACTIVE', '事务不可执行')
    this.assertAccount(taskId, accountId)
    const operation = this.registry.get(operationId)
    if (operation.effect !== 'write') throw new HLPersonalError('PERSONAL_INPUT', '查询不需要准备写入操作')
    const connection = this.store.get('connection', accountId)
    if (!connection || connection.state !== 'connected') throw new HLPersonalError('PERSONAL_CONNECTION_REQUIRED', '请先在桌面连接 Google 账户')
    const parsed = operation.parse(input)
    const fingerprint = hlCanonical({ taskId, operationId, accountId, input: parsed.input })
    const previous = this.store.list('action').find(row => row.fingerprint === fingerprint)
    if (previous) return previous
    const time = this.now()
    const action: HLPersonalAction = { id: this.id(), taskId, operation: operationId, accountId, ...parsed,
      fingerprint, state: 'prepared', createdAt: time, updatedAt: time }
    this.store.put('action', action); return action
  }
  async query(taskId: string, operationId: string, accountId: string, input: unknown, signal: AbortSignal): Promise<HLJson> {
    this.assertTask(taskId)
    this.assertAccount(taskId, accountId)
    const operation = this.registry.get(operationId)
    if (operation.effect !== 'read') throw new HLPersonalError('PERSONAL_WRITE_REQUIRES_PREPARATION', '写入需要准备操作并取得任务授权')
    const parsed = operation.parse(input)
    const result = await operation.execute(accountId, parsed.input, '', signal)
    if (operationId === 'google.calendar.list') this.store.transaction(() => this.store.put('marker', {
      id: hlCalendarWatchKey(taskId, accountId, parsed.input), value: JSON.stringify({ input: parsed.input, digest: hlCalendarDigest(result) }),
    }))
    this.rememberReadResource(taskId, accountId, operationId, result)
    return result
  }
  async commit(taskId: string, actionId: string, signal: AbortSignal): Promise<HLPersonalAction> {
    const action = this.store.get('action', actionId)
    if (!action || action.taskId !== taskId) throw new HLPersonalError('PERSONAL_NOT_FOUND', '操作不属于当前事务')
    return this.resources.run(`${action.accountId}:${action.calendarIds.join(',') || 'mail'}`, async () => {
      this.assertTask(taskId); signal.throwIfAborted()
      this.assertAccount(taskId, action.accountId)
      const current = this.store.get('action', actionId)!
      if (current.state === 'confirmed') return current
      if (current.state !== 'prepared') throw new HLPersonalError('PERSONAL_ACTION_UNCERTAIN', '这项操作已提交或结果待核实，请先核对，不能重复发送')
      this.store.transaction(() => {
        const grant = this.grants.reserve(current)
        this.store.put('action', { ...current, grantId: grant.id, state: 'dispatching', updatedAt: this.now() })
      }); this.changed()
      try {
        // Re-check after the reservation and before the request leaves this process.
        this.assertTask(taskId); signal.throwIfAborted()
        const grantId = this.store.get('action', actionId)?.grantId
        const grant = grantId ? this.store.get('grant', grantId) : undefined
        if (!grant || grant.state !== 'active' || grant.expiresAt <= this.now()) throw new HLPersonalError('PERSONAL_GRANT_REVOKED', '授权已失效')
        const result = await this.registry.get(current.operation).execute(current.accountId, current.input, current.id, signal)
        const confirmed: HLPersonalAction = { ...this.store.get('action', actionId)!, state: 'confirmed', result, updatedAt: this.now() }
        this.store.transaction(() => this.store.put('action', confirmed)); this.changed(); return confirmed
      } catch (error) {
        const code = error instanceof HLPersonalError ? error.code : 'PERSONAL_PROVIDER_UNCERTAIN'
        // A send might already have succeeded. Never automatically submit it again.
        this.store.transaction(() => this.store.put('action', { ...this.store.get('action', actionId)!, state: 'unknown', errorCode: code, updatedAt: this.now() }))
        this.changed(); throw error
      }
    })
  }
  async reconcile(actionId: string, signal: AbortSignal): Promise<HLPersonalAction> {
    const action = this.store.get('action', actionId)
    if (!action) throw new HLPersonalError('PERSONAL_NOT_FOUND', '操作不存在')
    if (action.state !== 'unknown' && action.state !== 'dispatching') return action
    const operation = this.registry.get(action.operation)
    const result = await operation.reconcile?.(action, signal)
    const next: HLPersonalAction = result?.state === 'confirmed' ? { ...action, state: 'confirmed', result: result.result, updatedAt: this.now() }
      : { ...action, state: 'unknown', updatedAt: this.now() }
    this.store.transaction(() => this.store.put('action', next)); this.changed(); return next
  }
  private assertTask(taskId: string): void {
    const profile = this.store.list('profile', 1)[0]
    const task = this.store.get('task', taskId)
    if (!profile?.enabled || profile.paused || !task || ['cancelled', 'failed', 'completed', 'interrupted'].includes(task.state)) throw new HLPersonalError('PERSONAL_TASK_INACTIVE', '事务已暂停或结束')
    if (task.goalId && this.store.get('goal', task.goalId)?.state !== 'active') throw new HLPersonalError('PERSONAL_GOAL_PAUSED', '所属目标已暂停')
  }
  private assertAccount(taskId: string, accountId: string): void {
    if (!this.store.get('task', taskId)?.accountIds?.includes(accountId)) throw new HLPersonalError('PERSONAL_ACCOUNT_SCOPE', '此事务尚未获准使用该账户，请在事务详情选择账户范围')
  }
  private rememberReadResource(taskId: string, accountId: string, operation: string, result: HLJson): void {
    if (!operation.startsWith('google.gmail.') || !result || typeof result !== 'object' || Array.isArray(result) || typeof result.threadId !== 'string') return
    const messages = Array.isArray(result.messages) ? result.messages : []
    const last = messages.at(-1)
    const messageId = last && typeof last === 'object' && !Array.isArray(last) ? last.id : result.id
    this.store.transaction(() => this.store.put('marker', { id: `mail-resource:${taskId}:${accountId}:${result.threadId}`, value: typeof messageId === 'string' ? messageId : '' }))
  }
  async drain(): Promise<void> { await this.resources.drain() }
}
