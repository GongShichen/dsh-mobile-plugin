import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { HLPersonalRecords } from '../core/HLPersonalTypes.js'
import type { HLPersonalPersistence } from '../ports/HLPersonalPersistence.js'

/** Separate plugin database; never opens DSH logs or the existing pairing database. */
export class HLPersonalSQLite implements HLPersonalPersistence {
  private readonly db: DatabaseSync
  private depth = 0
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (path !== ':memory:') chmodSync(path, 0o600)
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version)
    if (version > 1) { this.db.close(); throw new Error('Personal Agent storage requires a newer plugin') }
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
    this.db.exec(`BEGIN; CREATE TABLE IF NOT EXISTS hl_records(kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS hl_records_order ON hl_records(kind,updated_at DESC,id);
      CREATE TABLE IF NOT EXISTS hl_metadata(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
      INSERT OR IGNORE INTO hl_metadata VALUES('revision',1); PRAGMA user_version=1; COMMIT;`)
  }
  get revision(): number { return Number(this.db.prepare("SELECT value FROM hl_metadata WHERE key='revision'").get()?.value ?? 1) }
  get<K extends keyof HLPersonalRecords>(kind: K, id: string): HLPersonalRecords[K] | undefined {
    const row = this.db.prepare('SELECT value FROM hl_records WHERE kind=? AND id=?').get(kind, id)
    return row ? JSON.parse(String(row.value)) as HLPersonalRecords[K] : undefined
  }
  list<K extends keyof HLPersonalRecords>(kind: K, limit = 2000): HLPersonalRecords[K][] {
    return this.db.prepare('SELECT value FROM hl_records WHERE kind=? ORDER BY updated_at DESC,id LIMIT ?').all(kind, limit)
      .map(row => JSON.parse(String(row.value)) as HLPersonalRecords[K])
  }
  put<K extends keyof HLPersonalRecords>(kind: K, value: HLPersonalRecords[K]): void {
    if (this.depth === 0) throw new Error('Personal writes require a transaction')
    const time = 'updatedAt' in value ? value.updatedAt : 'createdAt' in value ? value.createdAt : Date.now()
    this.db.prepare('INSERT INTO hl_records(kind,id,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
      .run(kind, value.id, JSON.stringify(value), Number(time))
  }
  remove(kind: keyof HLPersonalRecords, id: string): void {
    if (this.depth === 0) throw new Error('Personal writes require a transaction')
    this.db.prepare('DELETE FROM hl_records WHERE kind=? AND id=?').run(kind, id)
  }
  transaction<T>(work: () => T): T {
    const outer = this.depth === 0
    const name = `hl_personal_${this.depth++}`
    this.db.exec(`SAVEPOINT ${name}`)
    try {
      const result = work()
      if (result instanceof Promise) throw new TypeError('Personal transactions must not await network operations')
      if (outer) this.db.exec("UPDATE hl_metadata SET value=value+1 WHERE key='revision'")
      this.db.exec(`RELEASE SAVEPOINT ${name}`)
      return result
    } catch (error) { this.db.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`); throw error }
    finally { this.depth-- }
  }
  close(): void { this.db.close() }
}
