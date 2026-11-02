import type { HLJson, HLPersonalAction } from '../core/HLPersonalTypes.js'
export interface HLParsedOperation {
  input: Record<string, HLJson>; recipients: string[]; calendarIds: string[]; preview: string
}
export interface HLConnectorOperation {
  id: string; effect: 'read' | 'write'; description: string
  parse(input: unknown): HLParsedOperation
  execute(accountId: string, input: Record<string, HLJson>, actionId: string, signal: AbortSignal): Promise<HLJson>
  reconcile?(action: HLPersonalAction, signal: AbortSignal): Promise<{ state: 'confirmed'; result: HLJson } | { state: 'unknown' }>
}
