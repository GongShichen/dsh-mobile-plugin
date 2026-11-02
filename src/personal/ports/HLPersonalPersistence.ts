import type { HLPersonalRecords } from '../core/HLPersonalTypes.js'

/** All transaction bodies are synchronous; network work starts only after commit. */
export interface HLPersonalPersistence {
  readonly revision: number
  get<K extends keyof HLPersonalRecords>(kind: K, id: string): HLPersonalRecords[K] | undefined
  list<K extends keyof HLPersonalRecords>(kind: K, limit?: number): HLPersonalRecords[K][]
  put<K extends keyof HLPersonalRecords>(kind: K, value: HLPersonalRecords[K]): void
  remove(kind: keyof HLPersonalRecords, id: string): void
  transaction<T>(work: () => T): T
}
