/** Serializes calls to one account/resource without keeping a database transaction open. */
export class HLResourceCoordinator {
  private readonly pending = new Map<string, Promise<unknown>>()
  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(key)
    const result = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(work)
    this.pending.set(key, result)
    try { return await result } finally { if (this.pending.get(key) === result) this.pending.delete(key) }
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.pending.values()]) }
}
