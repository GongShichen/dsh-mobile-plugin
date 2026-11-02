import type { HLJson } from '../core/HLPersonalTypes.js'

/** Registration does not start monitoring. Only a task-bound subscription can poll this source. */
export interface HLPersonalTriggerSource {
  id: string
  description: string
  parse(taskId: string, value: unknown): Record<string, HLJson>
  poll(taskId: string, params: Record<string, HLJson>, cursor: string | undefined, signal: AbortSignal): Promise<{
    cursor?: string; events: Array<{ id: string; summary: string }>
  }>
}
