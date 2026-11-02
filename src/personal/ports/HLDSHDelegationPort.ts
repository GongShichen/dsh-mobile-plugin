import type { HLAgentExecutionPort } from './HLAgentExecutionPort.js'

/** Workspace delegation is a subset of the same Host adapter, with no owned-session policy override. */
export type HLDSHDelegationPort = Pick<HLAgentExecutionPort, 'workspaces' | 'sessions' | 'context' | 'ensureSession' | 'state' | 'prompt' | 'cancel' | 'checkpoint'>
