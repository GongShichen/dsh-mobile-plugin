import type { HLJson } from '../core/HLPersonalTypes.js'
export interface HLSchedulePort {
  readonly timingKinds?: readonly string[]
  create(request: { title: string; prompt: string; timing: HLJson; sessionId: string }, signal: AbortSignal): Promise<string>
  /** Older Host APIs pause by removing a timer; the stored rule can explicitly re-arm it. */
  edit(id: string, active: boolean, signal: AbortSignal): Promise<void | 'removed'>
  history(id: string, signal: AbortSignal): Promise<Array<{ scheduledAt: string; targetSessionId: string; messageId: string }>>
  find?(sessionId: string, signal: AbortSignal): Promise<Array<{ id: string; active: boolean }>>
}
