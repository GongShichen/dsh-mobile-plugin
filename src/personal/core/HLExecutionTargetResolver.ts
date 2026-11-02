import type { HLAgentExecutionPort } from '../ports/HLAgentExecutionPort.js'
import type { HLExecutionTarget } from './HLPersonalTypes.js'
import { HLPersonalError, hlObject, hlText } from './HLPersonalValidation.js'

export function hlExecutionTarget(value: unknown): HLExecutionTarget {
  if (value === undefined) return { kind: 'internal' }
  const row = hlObject(value)
  if (row.kind === 'internal') return { kind: 'internal' }
  if (row.kind === 'workspace-new') {
    const selection = row.modelSelection === undefined ? undefined : hlObject(row.modelSelection)
    return { kind: row.kind, workspaceId: hlText(row.workspaceId, '工作区 ID', 128),
      ...(row.agentPreset === undefined ? {} : { agentPreset: hlText(row.agentPreset, '预设', 128) }),
      ...(selection ? { modelSelection: { provider: hlText(selection.provider, '模型供应商', 128), model: hlText(selection.model, '模型', 300),
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: hlText(selection.reasoningEffort, '思考强度', 128) }) } } : {}) }
  }
  if (row.kind === 'session-continue') return { kind: row.kind, sessionId: hlText(row.sessionId, '会话 ID', 128),
    ...(row.workspaceId === undefined ? {} : { workspaceId: hlText(row.workspaceId, '工作区 ID', 128) }) }
  throw new HLPersonalError('PERSONAL_INPUT', '执行位置无效')
}
/** Resolution reads public catalogues. It never creates a session while a picker is open. */
export class HLExecutionTargetResolver {
  constructor(private readonly execution: HLAgentExecutionPort) {}
  async validate(target: HLExecutionTarget, signal: AbortSignal): Promise<void> {
    if (target.kind === 'internal') return
    const workspaces = await this.execution.workspaces(signal)
    if (target.workspaceId && !workspaces.some(row => row.workspaceId === target.workspaceId)) throw new HLPersonalError('PERSONAL_WORKSPACE_MISSING', '工作区已不可用，请重新选择')
    if (target.kind === 'workspace-new') return
    const sessions = await this.execution.sessions(target.workspaceId, signal)
    const session = sessions.find(row => row.sessionId === target.sessionId)
    if (!session) throw new HLPersonalError('PERSONAL_SESSION_MISSING', '会话不存在或不属于所选工作区')
    if (session.personalRole) throw new HLPersonalError('PERSONAL_MANAGED_SESSION', '此会话由私人助理管理，请继续对应事务或打开主对话交办')
    if (session.archived) throw new HLPersonalError('PERSONAL_SESSION_ARCHIVED', '会话已归档，请先在普通会话中恢复或选择新建')
    if (session.formatStatus === 'migration-required') throw new HLPersonalError('PERSONAL_SESSION_MIGRATION', '请先在桌面打开该会话完成版本迁移')
  }
}
