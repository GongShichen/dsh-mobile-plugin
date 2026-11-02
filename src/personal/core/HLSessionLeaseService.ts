import type { HLPersonalPersistence } from '../ports/HLPersonalPersistence.js'
import type { HLPersonalTask } from './HLPersonalTypes.js'

/** These leases serialize Personal work; they never lock out the human desktop owner. */
export class HLSessionLeaseService {
  constructor(private readonly store: HLPersonalPersistence) {}
  available(task: HLPersonalTask): boolean {
    const current = this.store.list('task').filter(row => row.id !== task.id && row.activeRunId
      && !['settled', 'interrupted'].includes(this.store.get('run', row.activeRunId)?.state ?? 'settled'))
    const sessionId = task.binding?.sessionId ?? (task.target.kind === 'session-continue' ? task.target.sessionId : undefined)
    if (sessionId && current.some(row => row.binding?.sessionId === sessionId || row.target.kind === 'session-continue' && row.target.sessionId === sessionId)) return false
    const workspaceId = task.binding?.workspaceId ?? (task.target.kind !== 'internal' ? task.target.workspaceId : undefined)
    return !workspaceId || !current.some(row => (row.binding?.workspaceId ?? (row.target.kind !== 'internal' ? row.target.workspaceId : undefined)) === workspaceId)
  }
}
