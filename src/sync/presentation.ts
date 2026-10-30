import { deriveTurnTokenUsage } from './upstream-turn-usage.js'
import { record } from '../bridge/errors.js'

type Event = { type: string; seq: number; time: number; data: Record<string, any>; surfaceOp?: string }
function eventOf(value: unknown): Event | undefined {
  return record(value) && typeof value.type === 'string' && Number.isSafeInteger(value.seq) && typeof value.time === 'number' && record(value.data) ? value as Event : undefined
}
function textOf(event: Event): string {
  const content = event.data.message?.content
  return Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text ?? '').join('') : ''
}

/** Per-peer temporary projection of official events; it never writes a second session log. */
export class PresentationTracker {
  private readonly events = new Map<number, Event>()
  ingest(records: unknown): void {
    if (!Array.isArray(records)) return
    for (const row of records) if (record(row)) this.append(row.event)
  }
  append(value: unknown): void {
    const event = eventOf(value)
    if (event) this.events.set(event.seq, event)
    // Bounded by the adapter. Forgotten old rows can be reloaded through official history paging.
    if (this.events.size > 20_000) {
      const keys = [...this.events.keys()].sort((a, b) => a - b)
      for (const key of keys.slice(0, this.events.size - 20_000)) this.events.delete(key)
    }
  }
  baseline(frame: Record<string, unknown>): void {
    const records = Array.isArray(frame.records) ? frame.records : []
    const sequences = records.flatMap(row => record(row) ? [eventOf(row.event)?.seq].filter((v): v is number => v !== undefined) : [])
    const first = Math.min(...sequences)
    for (const key of this.events.keys()) if (key >= first || (typeof frame.cursor === 'number' && key > frame.cursor)) this.events.delete(key)
    this.ingest(records)
  }
  snapshot(): { turns: unknown[] } {
    const ordered = [...this.events.values()].sort((a, b) => a.seq - b.seq)
    const groups = new Map<number, Event[]>()
    let active: number | undefined
    for (const event of ordered) {
      if (event.type === 'turn/start') active = event.data.turn
      const turn = typeof event.data.turn === 'number' ? event.data.turn : active
      if (turn !== undefined) { const group = groups.get(turn) ?? []; group.push(event); groups.set(turn, group) }
      if (event.type === 'turn/end') active = undefined
    }
    const turns = [...groups].flatMap(([turn, events]) => {
      const start = events.find(event => event.type === 'turn/start')
      const end = events.find(event => event.type === 'turn/end')
      if (!end) return []
      const bounded = events.filter(event => event.seq <= end.seq)
      const assistants = bounded.filter(event => event.type === 'assistant/message')
      const closing = assistants.findLast(event => textOf(event).trim() !== '')
      const latestTranscript = bounded.filter(event => event.type === 'assistant/message' || event.type === 'tool/call'
        || (event.type === 'tool/result' && event.surfaceOp === 'append') || event.type === 'llm/retry'
        || (event.type === 'turn/end' && event.data.reason?.kind === 'error')).at(-1)
      const complete = start !== undefined && bounded.every((event, index) => index === 0 || event.seq === bounded[index - 1]!.seq + 1)
      const usage = complete ? deriveTurnTokenUsage(bounded) : undefined
      const reason = typeof end.data.reason?.kind === 'string' ? end.data.reason.kind : 'completed'
      return [{ turn, endSeq: end.seq, time: closing?.time ?? end.time, firstAssistantSeq: assistants[0]?.seq,
        status: reason === 'error' ? 'failed' : ['aborted', 'interrupted'].includes(reason) ? 'stopped' : 'completed',
        ...(start ? { durationMs: Math.max(0, end.time - start.time) } : {}),
        ...(closing ? { closingSeq: closing.seq, text: textOf(closing),
          ...(closing.data.interrupted !== true && typeof closing.data.message?.id === 'string' ? { messageId: closing.data.message.id } : {}) } : {}),
        branchAvailable: closing !== undefined && latestTranscript?.seq === closing.seq,
        ...(usage ? { tokenUsage: usage } : {}),
      }]
    })
    return { turns }
  }
}
