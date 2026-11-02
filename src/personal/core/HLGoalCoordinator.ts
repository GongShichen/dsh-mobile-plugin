import type { HLPersonalPersistence } from '../ports/HLPersonalPersistence.js'
import type { HLGoalState, HLPersonalGoal, HLPersonalMilestone } from './HLPersonalTypes.js'
import { HLPersonalError, hlObject, hlPriority, hlRevision, hlText } from './HLPersonalValidation.js'

/** Goals are independent records; there is no profile-wide current goal. */
export class HLGoalCoordinator {
  constructor(private readonly store: HLPersonalPersistence, private readonly id: () => string, private readonly now: () => number) {}
  create(params: Record<string, unknown>): HLPersonalGoal {
    if (this.store.list('goal').length >= 2000) throw new HLPersonalError('PERSONAL_LIMIT', '请先归档或整理已有目标')
    const time = this.now()
    const goal: HLPersonalGoal = { id: this.id(), title: hlText(params.title, '目标名称', 120), objective: hlText(params.objective, '目标内容', 8000),
      state: 'active', priority: hlPriority(params.priority), revision: 1, createdAt: time, updatedAt: time }
    if (params.milestones !== undefined) goal.milestones = this.milestones(params.milestones)
    this.store.put('goal', goal); return goal
  }
  update(params: Record<string, unknown>): HLPersonalGoal {
    const goal = this.store.get('goal', hlText(params.goalId, '目标 ID', 128))
    if (!goal) throw new HLPersonalError('PERSONAL_NOT_FOUND', '目标不存在')
    hlRevision(params.revision, goal.revision)
    const state = params.state ?? goal.state
    if (!['active', 'paused', 'blocked', 'completed', 'archived'].includes(String(state))) throw new HLPersonalError('PERSONAL_INPUT', '目标状态无效')
    const next = { ...goal, state: state as HLGoalState, title: params.title === undefined ? goal.title : hlText(params.title, '目标名称', 120),
      objective: params.objective === undefined ? goal.objective : hlText(params.objective, '目标内容', 8000),
      priority: params.priority === undefined ? goal.priority : hlPriority(params.priority), revision: goal.revision + 1, updatedAt: this.now() }
    if (params.milestones !== undefined) next.milestones = this.milestones(params.milestones, goal.milestones)
    if (next.state === 'completed' && this.store.list('task').some(task => task.goalId === goal.id && !['completed', 'cancelled'].includes(task.state))) {
      throw new HLPersonalError('PERSONAL_GOAL_HAS_WORK', '目标还有未完成的事务，请先核对处理')
    }
    this.store.put('goal', next); return next
  }
  private milestones(value: unknown, previous: HLPersonalMilestone[] = []): HLPersonalMilestone[] {
    if (!Array.isArray(value) || value.length > 20) throw new HLPersonalError('PERSONAL_INPUT', '一个目标最多设置 20 项阶段目标')
    const rows = value.map(item => {
      const row = typeof item === 'string' ? { title: item } : hlObject(item)
      const id = row.id === undefined ? this.id() : hlText(row.id, '阶段 ID', 128)
      if (row.id !== undefined && !previous.some(value => value.id === id)) throw new HLPersonalError('PERSONAL_INPUT', '阶段目标已改变，请刷新')
      if (row.state !== undefined && !['open', 'completed'].includes(String(row.state))) throw new HLPersonalError('PERSONAL_INPUT', '阶段状态无效')
      return { id, title: hlText(row.title, '阶段名称', 120), state: row.state === 'completed' ? 'completed' as const : 'open' as const }
    })
    if (new Set(rows.map(row => row.id)).size !== rows.length) throw new HLPersonalError('PERSONAL_INPUT', '阶段 ID 不能重复')
    return rows
  }
}
