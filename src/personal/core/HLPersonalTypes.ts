/** Personal Agent domain and wire-safe records. No Host, database, or provider imports. */
export type HLJson = null | boolean | number | string | HLJson[] | { [key: string]: HLJson }
export interface HLPersonalModelSelection { provider: string; model: string; reasoningEffort?: string }
export type HLExecutionTarget = { kind: 'internal' } | { kind: 'workspace-new'; workspaceId: string; agentPreset?: string; modelSelection?: HLPersonalModelSelection }
  | { kind: 'session-continue'; sessionId: string; workspaceId?: string }
export type HLTaskState = 'queued' | 'starting' | 'running' | 'waiting' | 'stopping' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export type HLGoalState = 'active' | 'paused' | 'blocked' | 'completed' | 'archived'
export interface HLPersonalMilestone { id: string; title: string; state: 'open' | 'completed' }
export type HLPriority = 'high' | 'normal' | 'low'
export type HLResultKind = 'text' | 'files' | 'email' | 'calendar' | 'session'
export interface HLPersonalProfile {
  id: string; name: string; enabled: boolean; paused: boolean; revision: number
  maxConcurrentTasks: number; taskTimeoutMs: number; mainSessionId?: string; mainSessionReady?: boolean
  createdAt: number; updatedAt: number
}
export interface HLPersonalSource {
  kind: 'owner' | 'assistant' | 'routine' | 'wakeup'; id: string; sessionId?: string; callId?: string
}
export interface HLPersonalGoal {
  id: string; title: string; objective: string; state: HLGoalState; priority: HLPriority
  revision: number; createdAt: number; updatedAt: number
  milestones?: HLPersonalMilestone[]
}
export interface HLSessionBinding {
  sessionId: string; workspaceId?: string; workspaceTitle?: string; cwd?: string
  ownership: 'internal' | 'created' | 'borrowed'; agentPreset?: string
}
export interface HLPersonalTask {
  id: string; title: string; instruction: string; goalId?: string; priority: HLPriority
  target: HLExecutionTarget; binding?: HLSessionBinding; state: HLTaskState; waitReason?: string
  source: HLPersonalSource; revision: number; intentVersion: number; attempt: number; activeRunId?: string
  resourceInputIds?: string[]
  accountIds?: string[]
  resultKind?: HLResultKind
  dependsOn?: string[]
  summary: string; result?: HLTaskResult; createdAt: number; updatedAt: number
  finishedAt?: number; errorCode?: string
}
export interface HLTaskResult {
  summary: string; verification: 'execution-only' | 'verified' | 'owner-confirmed'
  sessionId: string; throughSeq: number; artifacts: string[]; actionIds: string[]
  checks?: Array<{ verifierId: string; evidence: HLJson }>
}
export interface HLPersonalRun {
  id: string; taskId: string; sessionId?: string; requestedSessionId: string; requestId: string
  state: 'preparing' | 'submitted' | 'running' | 'waiting' | 'settled' | 'interrupted'
  baselineSeq: number; lastSeq: number; observedTurn?: number; ownTurn?: number; mixed: boolean; humanClaimed: boolean
  additionalRequestIds?: string[]; endSeq?: number; endReason?: string
  startedAt: number; activeAt?: number; deadlineAt?: number; assistantText: string
  creationAttempted?: boolean
  report?: { callId: string; outcome: 'ready' | 'waiting'; summary: string; artifacts: string[]; actionIds: string[]; accepted: boolean }
}
export interface HLPersonalMemory {
  id: string; kind: 'preference' | 'fact'; text: string; quote?: string; source: HLPersonalSource
  revision: number; createdAt: number; updatedAt: number; expiresAt?: number
}
export interface HLPersonalInput {
  id: string; requestId: string; sessionId: string; text: string; createdAt: number
  state: 'queued' | 'submitted' | 'failed'; taskId?: string; errorCode?: string
  executionTarget?: HLExecutionTarget; goalId?: string
  receiptIds?: string[]
  clientTimeZone?: string
  attempts?: number; retryAt?: number
}
export interface HLPersonalGrant {
  id: string; taskId: string; accountId: string; operations: string[]; recipients: string[]; calendarIds: string[]
  expiresAt: number; maxWrites: number; usedWrites: number; state: 'active' | 'revoked'; revision: number
  sourceDeviceId: string; createdAt: number
  scope?: 'task' | 'routine'; routineId?: string; parentGrantId?: string
}
export interface HLPersonalAction {
  id: string; taskId: string; operation: string; accountId: string; input: Record<string, HLJson>
  fingerprint: string; recipients: string[]; calendarIds: string[]; preview: string; grantId?: string
  state: 'prepared' | 'dispatching' | 'confirmed' | 'failed' | 'unknown' | 'cancelled'
  result?: HLJson; errorCode?: string; createdAt: number; updatedAt: number
}
export interface HLPersonalRoutine {
  id: string; title: string; instruction: string; target: HLExecutionTarget; goalId?: string
  timing: HLJson; scheduleId?: string; ingressSessionId?: string
  resultKind?: HLResultKind
  accountIds?: string[]
  state: 'creating' | 'active' | 'paused' | 'failed' | 'unknown'; revision: number; createdAt: number; updatedAt: number
  errorCode?: string
  scheduleAttempted?: boolean
}
export interface HLPersonalWakeup {
  id: string; taskId: string; at: number; reason: string; state: 'pending' | 'consumed' | 'cancelled'; createdAt: number
  sourceId?: string; sourceParams?: Record<string, HLJson>; cursor?: string; nextCheckAt?: number; matched?: boolean
}
export interface HLPersonalNotice {
  id: string; taskId: string; summary: string; state: 'queued' | 'delivered'
  attempts: number; retryAt: number; createdAt: number
}
export interface HLPersonalActivity { id: string; kind: string; summary: string; taskId?: string; createdAt: number }
export interface HLPersonalConnection {
  id: string; provider: 'google'; email: string; scopes: string[]
  state: 'connected' | 'reauth-required' | 'disconnected'; updatedAt: number
}
export interface HLPersonalServiceRequest {
  id: string; provider: 'google'; service: 'gmail' | 'calendar'; createdAt: number; taskId?: string
}
export interface HLCommandRecord { id: string; fingerprint: string; state: 'accepted' | 'committed' | 'unknown'; result?: HLJson }
export interface HLPersonalRecords {
  profile: HLPersonalProfile; goal: HLPersonalGoal; task: HLPersonalTask; run: HLPersonalRun
  memory: HLPersonalMemory; input: HLPersonalInput; grant: HLPersonalGrant; action: HLPersonalAction
  routine: HLPersonalRoutine; wakeup: HLPersonalWakeup; notice: HLPersonalNotice
  activity: HLPersonalActivity; connection: HLPersonalConnection; command: HLCommandRecord
  marker: { id: string; value: string }
}
export interface HLPersonalSnapshot {
  version: 1; revision: number; available: boolean; unavailableReason?: string; profile: HLPersonalProfile
  goals: HLPersonalGoal[]; tasks: HLPersonalTask[]; memories: HLPersonalMemory[]; grants: HLPersonalGrant[]
  actions: HLPersonalAction[]; routines: HLPersonalRoutine[]; activity: HLPersonalActivity[]
  connections: HLPersonalConnection[]; googleConfigured: boolean; serviceRequests?: HLPersonalServiceRequest[]
  counts: { goals: number; tasks: number; memories: number; attention: number }
  deliveryError?: { inputId: string; message: string }
}
export interface HLPersonalSessionEvent { type: string; seq: number; data: Record<string, unknown> }
export const HL_TASK_TERMINAL = new Set<HLTaskState>(['completed', 'failed', 'cancelled'])
export const HL_PERSONAL_MUTATIONS = new Set(['personal.configure', 'personal.open', 'personal.submitMessage',
  'personal.createGoal', 'personal.updateGoal', 'personal.createTask', 'personal.appendTask', 'personal.cancelTask',
  'personal.resumeTask', 'personal.confirmTask', 'personal.putMemory', 'personal.forgetMemory', 'personal.authorizeTask',
  'personal.revokeGrant', 'personal.createRoutine', 'personal.editRoutine', 'personal.reconcileRoutine', 'personal.wakeTask', 'personal.disconnectGoogle', 'personal.reconcileAction', 'personal.retryInput', 'personal.setTaskAccounts'])
