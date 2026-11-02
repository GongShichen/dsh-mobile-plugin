import type { HLPersonalInput } from './HLPersonalTypes.js'
import { hlExecutionTarget } from './HLExecutionTargetResolver.js'
import { HLPersonalError, hlCanonical } from './HLPersonalValidation.js'

/** UI-selected execution references are stronger than a model's inferred replacement. */
export class HLIntentRouter {
  bindTask(params: Record<string, unknown>, input: HLPersonalInput): Record<string, unknown> {
    const result = { ...params }
    if (input.executionTarget) {
      const auxiliaryAccountTask = params.target !== undefined && hlExecutionTarget(params.target).kind === 'internal' && ['email', 'calendar'].includes(String(params.resultKind))
      if (!auxiliaryAccountTask) {
        if (params.target !== undefined && hlCanonical(hlExecutionTarget(params.target)) !== hlCanonical(input.executionTarget)) throw new HLPersonalError('PERSONAL_TARGET_CONFLICT', '请按用户已选择的工作区或会话执行；如需切换，请先询问用户')
        result.target = input.executionTarget
      }
    }
    if (input.goalId) {
      if (params.goalId !== undefined && params.goalId !== input.goalId) throw new HLPersonalError('PERSONAL_GOAL_CONFLICT', '当前消息明确关联另一个目标，请先核对')
      result.goalId = input.goalId
    }
    return result
  }
}
