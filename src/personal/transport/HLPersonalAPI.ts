import { HLError } from '../../transport/HLError.js'
import { HLPersonalError, hlObject } from '../core/HLPersonalValidation.js'
import type { HLPersonalFramework, HLPersonalActor } from '../core/HLPersonalFramework.js'
import type { HLGoogleOAuth } from '../connectors/google/HLGoogleOAuth.js'

export const HL_PERSONAL_WEB_METHODS = ['snapshot', 'configure', 'open', 'submitMessage', 'listTasks', 'getTask', 'listGoals', 'createGoal', 'updateGoal',
  'createTask', 'appendTask', 'cancelTask', 'resumeTask', 'confirmTask', 'listMemories', 'putMemory', 'forgetMemory', 'authorizeTask', 'revokeGrant',
  'createRoutine', 'editRoutine', 'reconcileRoutine', 'wakeTask', 'listWorkspaces', 'listSessions', 'sessionContext', 'beginGoogleAuth', 'importGoogleClient', 'clearGoogleClient', 'disconnectGoogle', 'reconcileAction', 'retryInput', 'setTaskAccounts'] as const

/** Transport identity is supplied by the authenticated boundary, never by JSON parameters. */
export class HLPersonalAPI {
  constructor(readonly framework: HLPersonalFramework, private readonly google: HLGoogleOAuth) {}
  async invoke(method: string, params: unknown, actor: HLPersonalActor, signal: AbortSignal): Promise<unknown> {
    try {
      if (!HL_PERSONAL_WEB_METHODS.some(name => `personal.${name}` === method)) throw new HLPersonalError('PERSONAL_METHOD_NOT_FOUND', '未知私人助理操作')
      if (['personal.beginGoogleAuth', 'personal.importGoogleClient', 'personal.clearGoogleClient'].includes(method)) {
        if (!actor.desktop) throw new HLPersonalError('PERSONAL_DESKTOP_REQUIRED', '请在电脑的私人助理面板配置并登录 Google')
        if (method === 'personal.importGoogleClient') return this.google.importClient(hlObject(params).clientJson)
        if (method === 'personal.clearGoogleClient') return this.google.clearClient()
        return this.google.begin()
      }
      return await this.framework.invoke(method, hlObject(params), actor, signal)
    } catch (error) {
      if (error instanceof HLPersonalError) throw new HLError(error.code, error.message)
      throw error
    }
  }
  follow(signal: AbortSignal): AsyncIterable<unknown> { return this.framework.follow(signal) }
}
