import type { HLPersonalPersistence } from '../ports/HLPersonalPersistence.js'
import type { HLPersonalAction, HLPersonalGrant } from './HLPersonalTypes.js'
import { HLPersonalError, hlInteger, hlRevision, hlText } from './HLPersonalValidation.js'

export function hlEmail(value: string): string {
  const email = value.trim().toLowerCase()
  if (!/^[^\s<>@,;:"()\\\r\n]+@[^\s<>@,;:"()\\\r\n]+\.[^\s<>@,;:"()\\\r\n]+$/.test(email) || email.length > 254) throw new HLPersonalError('PERSONAL_RECIPIENT', '请使用明确的完整邮箱地址')
  return email
}
/** Grants are minted only by an authenticated owner command, never by model arguments. */
export class HLAuthorizationService {
  constructor(private readonly store: HLPersonalPersistence, private readonly id: () => string, private readonly now: () => number) {}
  authorize(params: Record<string, unknown>, sourceDeviceId: string): HLPersonalGrant {
    const taskId = hlText(params.taskId, '事务 ID', 128)
    const task = this.store.get('task', taskId)
    if (!task || ['completed', 'cancelled', 'failed'].includes(task.state)) throw new HLPersonalError('PERSONAL_TASK_INACTIVE', '事务已结束或不存在')
    const actionIds = Array.isArray(params.actionIds) ? params.actionIds.map(id => hlText(id, '操作 ID', 128)) : []
    const actions = actionIds.map(id => this.store.get('action', id))
    if (!actions.length || actions.some(row => !row || row.taskId !== taskId || row.state !== 'prepared')) throw new HLPersonalError('PERSONAL_GRANT_ACTIONS', '请刷新待授权操作后重试')
    const selected = actions as HLPersonalAction[]
    const accountId = selected[0]!.accountId
    if (selected.some(row => row.accountId !== accountId)) throw new HLPersonalError('PERSONAL_GRANT_ACCOUNT', '不同账户需要分别授权')
    const routineScope = params.scope === 'routine'
    if (params.scope !== undefined && params.scope !== 'task' && params.scope !== 'routine') throw new HLPersonalError('PERSONAL_INPUT', '授权范围无效')
    if (routineScope && (task.source.kind !== 'routine' || !this.store.get('routine', task.source.id))) throw new HLPersonalError('PERSONAL_GRANT_ROUTINE', '只有已保存规则产生的事务可以授权周期范围')
    const duration = routineScope ? 30 * 86400_000 : 24 * 60 * 60_000
    const expiresAt = params.expiresAt === undefined ? this.now() + duration : hlInteger(params.expiresAt, '有效期', this.now() + 1000, this.now() + duration)
    const grant: HLPersonalGrant = { id: this.id(), taskId, accountId,
      operations: [...new Set(selected.map(row => row.operation))], recipients: [...new Set(selected.flatMap(row => row.recipients))],
      calendarIds: [...new Set(selected.flatMap(row => row.calendarIds))], expiresAt,
      maxWrites: params.maxWrites === undefined ? 10 : hlInteger(params.maxWrites, '操作次数', selected.length, 10),
      usedWrites: 0, state: 'active', revision: 1, sourceDeviceId, createdAt: this.now(), scope: routineScope ? 'routine' : 'task',
      ...(routineScope ? { routineId: task.source.id } : {}) }
    this.store.put('grant', grant); return grant
  }
  reserve(action: HLPersonalAction): HLPersonalGrant {
    const fits = (row: HLPersonalGrant) => row.accountId === action.accountId
      && row.state === 'active' && row.expiresAt > this.now() && row.usedWrites < row.maxWrites
      && row.operations.includes(action.operation) && action.recipients.every(item => row.recipients.includes(item))
      && action.calendarIds.every(item => row.calendarIds.includes(item))
    let grant = this.store.list('grant').find(row => row.scope !== 'routine' && row.taskId === action.taskId && fits(row)
      && (!row.parentGrantId || this.store.get('grant', row.parentGrantId)?.state === 'active'))
    if (!grant) {
      const task = this.store.get('task', action.taskId)
      const root = task?.source.kind === 'routine' ? this.store.list('grant').find(row => row.scope === 'routine' && row.routineId === task.source.id
        && row.accountId === action.accountId && row.state === 'active' && row.expiresAt > this.now()
        && row.operations.includes(action.operation) && action.recipients.every(item => row.recipients.includes(item)) && action.calendarIds.every(item => row.calendarIds.includes(item))) : undefined
      if (root && !this.store.list('grant').some(row => row.parentGrantId === root.id && row.taskId === action.taskId)) {
        grant = { ...root, id: this.id(), scope: 'task', taskId: action.taskId, parentGrantId: root.id, usedWrites: 0,
          expiresAt: Math.min(root.expiresAt, this.now() + 86400_000), revision: 1, createdAt: this.now() }
        this.store.put('grant', grant)
      }
    }
    if (!grant) throw new HLPersonalError('PERSONAL_AUTHORIZATION_REQUIRED', '需要批准这项事务的操作范围')
    const next = { ...grant, usedWrites: grant.usedWrites + 1, revision: grant.revision + 1 }
    this.store.put('grant', next); return next
  }
  revoke(params: Record<string, unknown>): void {
    const grant = this.store.get('grant', hlText(params.grantId, '授权 ID', 128))
    if (!grant) throw new HLPersonalError('PERSONAL_NOT_FOUND', '授权不存在')
    hlRevision(params.revision, grant.revision)
    this.store.put('grant', { ...grant, state: 'revoked', revision: grant.revision + 1 })
    for (const child of this.store.list('grant').filter(row => row.parentGrantId === grant.id && row.state === 'active')) this.store.put('grant', { ...child, state: 'revoked', revision: child.revision + 1 })
  }
}
