import type { HLPersonalPersistence } from '../ports/HLPersonalPersistence.js'
import type { HLAgentExecutionPort } from '../ports/HLAgentExecutionPort.js'
import type { HLPersonalRun, HLPersonalTask, HLTaskResult } from './HLPersonalTypes.js'
import { HLPersonalError } from './HLPersonalValidation.js'
import type { HLPersonalCompletionVerifier } from '../ports/HLPersonalCompletionVerifier.js'

/** Execution settlement and achievement are separate facts, especially in borrowed sessions. */
export class HLCompletionVerifier {
  private readonly extensions = new Map<string, HLPersonalCompletionVerifier>()
  constructor(private readonly store: HLPersonalPersistence, private readonly execution: HLAgentExecutionPort) {}
  register(extension: HLPersonalCompletionVerifier): () => void {
    if (this.extensions.has(extension.id)) throw new Error('Duplicate Personal completion verifier')
    this.extensions.set(extension.id, extension)
    return () => { if (this.extensions.get(extension.id) === extension) this.extensions.delete(extension.id) }
  }
  async verify(task: HLPersonalTask, run: HLPersonalRun, signal: AbortSignal): Promise<HLTaskResult> {
    if (!task.binding) throw new HLPersonalError('PERSONAL_RESULT_UNAVAILABLE', '缺少执行会话')
    await this.execution.checkpoint(task.binding.sessionId)
    const state = await this.execution.state(task.binding.sessionId, signal)
    if (state.running || state.pendingInput.length || state.queue.length) throw new HLPersonalError('PERSONAL_SESSION_ACTIVE', '原会话仍有执行或待处理输入')
    const report = run.report?.accepted ? run.report : undefined
    if (this.store.list('wakeup').some(row => row.taskId === task.id && row.state === 'pending')) throw new HLPersonalError('PERSONAL_WAITING_EXTERNAL', '任务已安排后续跟进，当前等待条件满足')
    if (task.target.kind === 'internal' && (!report || report.outcome !== 'ready')) throw new HLPersonalError('PERSONAL_RESULT_REVIEW', '执行已结束，等待补充结果或继续')
    const artifacts = report?.artifacts ?? []
    const actionIds = report?.actionIds ?? []
    const taskActions = this.store.list('action').filter(row => row.taskId === task.id)
    if (taskActions.some(row => !['confirmed', 'cancelled'].includes(row.state))) throw new HLPersonalError('PERSONAL_RESULT_UNCERTAIN', '事务仍有未授权或结果未知的外部操作，不能标记完成')
    if (task.resultKind === 'email' && !taskActions.some(row => row.state === 'confirmed' && row.operation === 'google.gmail.send')) throw new HLPersonalError('PERSONAL_RESULT_UNCERTAIN', '尚未取得真实邮件发送回执，不能声明已发送')
    if (task.resultKind === 'calendar' && !taskActions.some(row => row.state === 'confirmed' && ['google.calendar.create', 'google.calendar.update'].includes(row.operation))) throw new HLPersonalError('PERSONAL_RESULT_UNCERTAIN', '尚未取得真实日程写入回执')
    if (task.resultKind === 'files' && artifacts.length === 0) throw new HLPersonalError('PERSONAL_ARTIFACT_MISSING', '缺少可核验的成果文件')
    for (const actionId of actionIds) {
      const action = this.store.get('action', actionId)
      if (!action || action.taskId !== task.id || action.state !== 'confirmed') throw new HLPersonalError('PERSONAL_RESULT_UNCERTAIN', '部分外部操作尚未核实')
    }
    await this.execution.verifyArtifacts(task.binding, artifacts, signal)
    const checks: Array<{ verifierId: string; evidence: import('./HLPersonalTypes.js').HLJson }> = []
    for (const extension of this.extensions.values()) if (extension.supports(task)) {
      const result = await extension.verify(task, run, signal)
      if (!result.verified) throw new HLPersonalError('PERSONAL_RESULT_REVIEW', '成果未通过已注册核验，请核对后继续')
      checks.push({ verifierId: extension.id, evidence: result.evidence })
    }
    return { summary: (report?.summary || run.assistantText || '会话执行已结束，请核对成果。').slice(0, 2000),
      verification: !run.mixed && (task.target.kind === 'internal' || checks.length > 0) ? 'verified' : 'execution-only',
      sessionId: task.binding.sessionId, throughSeq: run.lastSeq, artifacts, actionIds, ...(checks.length ? { checks } : {}) }
  }
}
