import type { HLPersonalPersistence } from '../ports/HLPersonalPersistence.js'
import type { HLAgentExecutionPort } from '../ports/HLAgentExecutionPort.js'

/** Accepted transport, durable inbox delivery, and user-read acknowledgements are distinct. */
export class HLNoticeOutbox {
  private pumping = false
  constructor(private readonly store: HLPersonalPersistence, private readonly execution: HLAgentExecutionPort,
    private readonly now: () => number, private readonly changed: () => void) {}
  async pump(signal: AbortSignal): Promise<void> {
    if (this.pumping) return
    const profile = this.store.list('profile', 1)[0]
    if (!profile?.enabled || profile.paused || !profile.mainSessionId || !profile.mainSessionReady) return
    this.pumping = true
    try {
      for (const row of this.store.list('notice').filter(row => row.state === 'queued' && row.retryAt <= this.now()).slice(-5).reverse()) {
        signal.throwIfAborted()
        try {
          await this.execution.notice(profile.mainSessionId, row, signal)
          this.store.transaction(() => this.store.put('notice', { ...row, state: 'delivered', attempts: row.attempts + 1 })); this.changed()
        } catch {
          this.store.transaction(() => this.store.put('notice', { ...row, attempts: row.attempts + 1, retryAt: this.now() + Math.min(30_000, 1000 * 2 ** Math.min(row.attempts, 5)) }))
        }
      }
    } finally { this.pumping = false }
  }
}
