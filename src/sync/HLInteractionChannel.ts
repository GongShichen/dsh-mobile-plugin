import { HLBridgeError, record, textField } from '../bridge/HLBridgeError.ts'

type HLReply = { clientId: string; eventId: string; outcome: Record<string, unknown> }
type HLFrame = Record<string, unknown>

/** Each owner Peer opens one Gateway event generation, shared by list and interaction subscriptions. */
export class HLInteractionChannel {
  private readonly controller = new AbortController()
  private readonly signal: AbortSignal
  private readonly listeners = new Map<HLInteractionQueue, boolean>()
  private readonly pending = new Map<string, HLFrame>()
  private ready: HLFrame | undefined
  private work: Promise<void> | undefined
  private ended = false

  constructor(
    private readonly open: (signal: AbortSignal) => Promise<AsyncIterable<unknown>>,
    private readonly post: (result: HLReply, signal: AbortSignal) => Promise<void>,
    parent: AbortSignal,
  ) { this.signal = AbortSignal.any([parent, this.controller.signal]) }

  async *subscribe(interactions: boolean, signal: AbortSignal): AsyncIterable<unknown> {
    const queue = new HLInteractionQueue()
    const end = () => queue.end()
    signal.throwIfAborted()
    if (this.ended) throw new HLBridgeError('mobile/interactions-ended', '交互连接已结束，请重新连接')
    this.listeners.set(queue, interactions)
    if (this.ready) queue.push(this.ready)
    if (interactions) for (const frame of this.pending.values()) queue.push(frame)
    signal.addEventListener('abort', end, { once: true })
    this.work ??= this.pump()
    try { yield* queue.iterate() }
    finally { signal.removeEventListener('abort', end); this.listeners.delete(queue); queue.end() }
  }

  private broadcast(frame: HLFrame): void {
    for (const [queue, interactions] of this.listeners) {
      if (frame.type === 'ready' || (interactions ? frame.type !== 'emit' : frame.type === 'emit')) queue.push(frame)
    }
  }

  private async pump(): Promise<void> {
    let failure: unknown
    try {
      for await (const raw of await this.open(this.signal)) {
        this.signal.throwIfAborted()
        if (!record(raw)) throw new HLBridgeError('mobile/interactions-invalid', '桌面交互状态无效')
        if (raw.type === 'ready') {
          textField(raw.clientId, 'clientId')
          this.ready = raw
          this.broadcast(raw)
        } else if (raw.type === 'waterfall') {
          if (!this.ready) throw new HLBridgeError('mobile/interactions-invalid', '交互状态缺少连接身份')
          const id = textField(raw.eventId, 'eventId')
          if (raw.event !== 'approval/request' && raw.event !== 'user-questions/request') {
            // A phone must not hold a waterfall that it cannot render or answer.
            await this.post({ clientId: this.ready.clientId as string, eventId: id, outcome: { kind: 'next' } }, this.signal)
            continue
          }
          this.pending.set(id, raw)
          this.broadcast(raw)
        } else if (raw.type === 'cancel') {
          if (typeof raw.eventId === 'string') this.pending.delete(raw.eventId)
          this.broadcast(raw)
        } else if (raw.type === 'emit') this.broadcast(raw)
      }
    } catch (error) { if (!this.signal.aborted) failure = error }
    finally {
      this.ended = true
      this.pending.clear()
      for (const queue of this.listeners.keys()) queue.end(failure)
    }
  }

  request(clientId: unknown, eventId: unknown): HLFrame | undefined {
    if (clientId !== this.ready?.clientId || typeof eventId !== 'string' || this.ended) return undefined
    return this.pending.get(eventId)
  }

  async reply(result: HLFrame, signal: AbortSignal): Promise<{ accepted: boolean }> {
    const clientId = textField(result.clientId, 'clientId')
    const eventId = textField(result.eventId, 'eventId')
    const frame = this.request(clientId, eventId)
    if (!frame) return { accepted: false }
    const outcome = result.outcome
    if (!record(outcome) || !['result', 'next', 'rejected'].includes(String(outcome.kind))) {
      throw new HLBridgeError('mobile/invalid-answer', '无效的交互回复')
    }
    if (outcome.kind === 'result') {
      if (frame.event === 'approval/request') {
        if (outcome.value !== 'allowed-once' && outcome.value !== 'rejected') {
          throw new HLBridgeError('mobile/invalid-answer', '此确认仅支持允许这一次或拒绝')
        }
      } else validateQuestionAnswer(record(frame.request) ? frame.request.questions : undefined, outcome.value)
    }
    await this.post({ clientId, eventId, outcome }, signal)
    this.pending.delete(eventId)
    // Gateway removes the answering delivery before broadcasting cancellation to the other Clients.
    // Echo settlement to our own multiplexed subscriber as well (including older mobile clients).
    this.broadcast({ type: 'cancel', eventId })
    return { accepted: true }
  }

  async close(): Promise<void> {
    this.controller.abort()
    for (const queue of this.listeners.keys()) queue.end()
    await this.work
  }
}

/** Match the official complete-batch schema; fixed approval actions cannot carry arbitrary free text. */
export function validateQuestionAnswer(raw: unknown, value: unknown): void {
  const invalid = () => { throw new HLBridgeError('mobile/invalid-answer', '请按原问题提交完整、有效的回答') }
  if (!Array.isArray(raw) || !record(value) || !Array.isArray(value.answers) || value.answers.length !== raw.length) return invalid()
  const answered = new Set<string>()
  for (const answer of value.answers) {
    if (!record(answer) || typeof answer.id !== 'string' || answered.has(answer.id)) return invalid()
    answered.add(answer.id)
    const question = raw.find(q => record(q) && q.id === answer.id)
    if (!record(question) || !Array.isArray(answer.selected) || !answer.selected.every(s => typeof s === 'string')) return invalid()
    const selected = answer.selected as string[]
    const labels = (Array.isArray(question.options) ? question.options : []).filter(record).map(o => o.label)
    if (new Set(selected).size !== selected.length || selected.some(s => !labels.includes(s))) return invalid()
    if (question.multiSelect !== true && selected.length > 1) return invalid()
    if (answer.custom !== undefined && typeof answer.custom !== 'string') return invalid()
    if (record(question.intent) && question.intent.kind === 'approval'
      && (selected.length !== 1 || answer.custom !== undefined)) return invalid()
  }
}

/** Bounded transient fan-out, released with the subscription; nothing is written to disk. */
class HLInteractionQueue {
  private readonly items: Array<{ value: unknown; bytes: number }> = []
  private bytes = 0
  private done = false
  private error: unknown
  private wake: (() => void) | undefined
  push(value: unknown): void {
    if (this.done) return
    const bytes = Buffer.byteLength(JSON.stringify(value))
    if (this.items.length >= 256 || this.bytes + bytes > 32 * 1024 * 1024) {
      this.end(new HLBridgeError('mobile/interactions-overflow', '交互队列已满，请重新连接'))
      return
    }
    this.items.push({ value, bytes }); this.bytes += bytes
    this.wake?.(); this.wake = undefined
  }
  end(error?: unknown): void { this.done = true; this.error ??= error; this.wake?.(); this.wake = undefined }
  async *iterate(): AsyncIterable<unknown> {
    while (true) {
      const item = this.items.shift()
      if (item) { this.bytes -= item.bytes; yield item.value; continue }
      if (this.done) { if (this.error) throw this.error; return }
      await new Promise<void>(resolve => { this.wake = resolve })
    }
  }
}
