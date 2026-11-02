import type { HLExecutionTarget, HLPersonalNotice, HLSessionBinding } from '../core/HLPersonalTypes.js'

export interface HLDSHSessionState {
  cursor: number; running: boolean; active: boolean
  queue: Array<{ id: string; rpcId?: string }>; pendingInput: string[]
}
export interface HLWorkspaceRow { workspaceId: string; title: string; path: string; sessionIds: string[] }
export interface HLSessionRow {
  sessionId: string; title: string; running: boolean; archived: boolean; cwd?: string; workspaceId?: string
  agentPreset?: string; formatStatus?: string
  personalRole?: 'assistant' | 'worker' | 'scheduler'
}
/** One adapter over the Host's public services, not a second agent runtime. */
export interface HLAgentExecutionPort {
  workspaces(signal: AbortSignal): Promise<HLWorkspaceRow[]>
  sessions(workspaceId: string | undefined, signal: AbortSignal): Promise<HLSessionRow[]>
  context(sessionId: string, signal: AbortSignal): Promise<unknown>
  ensureSession(request: { role: 'assistant' | 'worker' | 'scheduler'; requestedId: string; directory: string; target: HLExecutionTarget }, signal: AbortSignal): Promise<HLSessionBinding>
  state(sessionId: string, signal: AbortSignal): Promise<HLDSHSessionState>
  prompt(sessionId: string, requestId: string, text: string, signal: AbortSignal, receiptIds?: string[], clientTimeZone?: string): Promise<void>
  cancel(sessionId: string, requestId: string | undefined, ownsTurn: boolean): Promise<void>
  checkpoint(sessionId: string): Promise<void>
  verifyArtifacts(binding: HLSessionBinding, paths: string[], signal: AbortSignal): Promise<void>
  resources?(sources: Array<{ sessionId: string; requestId: string }>, signal: AbortSignal): Promise<Array<{ attachmentId: string; kind: string; name: string; bytes: number; path?: string }>>
  notice(sessionId: string, notice: HLPersonalNotice, signal: AbortSignal): Promise<void>
  dispose(): Promise<void>
}
