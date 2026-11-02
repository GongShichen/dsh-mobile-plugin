import type { HLJson, HLPersonalRun, HLPersonalTask } from '../core/HLPersonalTypes.js'

/** Trusted Host extensions can verify concrete outcomes without replacing the agent loop. */
export interface HLPersonalCompletionVerifier {
  id: string
  supports(task: Readonly<HLPersonalTask>): boolean
  verify(task: Readonly<HLPersonalTask>, run: Readonly<HLPersonalRun>, signal: AbortSignal): Promise<{ verified: boolean; evidence: HLJson }>
}
