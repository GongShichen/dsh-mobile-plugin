import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'

/** Synchronous transactions must not contain awaited network work. */
export interface KeyValueStore {
  get<T>(key: string): T | undefined
  set<T>(key: string, value: T): void
  delete(key: string): void
  list<T>(prefix: string): Array<{ key: string; value: T }>
  transaction<T>(fn: () => T): T
}

/** Plugin-owned state; never opens or modifies a DSH session database. */
export class SqliteStore implements KeyValueStore {
  private readonly db: DatabaseSync
  private depth = 0

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (path !== ':memory:') chmodSync(path, 0o600)
    const version = this.db.prepare('PRAGMA user_version').get()?.user_version
    if (typeof version !== 'number' || version > 1) { this.db.close(); throw new Error('This mobile database needs a newer plugin version') }
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
    this.db.exec('CREATE TABLE IF NOT EXISTS mobile_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version=1;')
  }

  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM mobile_kv WHERE key = ?').get(key)
    if (!row) return undefined
    if (typeof row.value !== 'string') throw new Error('Invalid mobile storage row')
    return JSON.parse(row.value) as T
  }

  set<T>(key: string, value: T): void {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new TypeError('Cannot store undefined')
    this.db.prepare('INSERT INTO mobile_kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, serialized)
  }

  delete(key: string): void { this.db.prepare('DELETE FROM mobile_kv WHERE key=?').run(key) }

  list<T>(prefix: string): Array<{ key: string; value: T }> {
    return this.db.prepare('SELECT key,value FROM mobile_kv WHERE substr(key,1,?)=? ORDER BY key').all(prefix.length, prefix).map(row => {
      if (typeof row.key !== 'string' || typeof row.value !== 'string') throw new Error('Invalid mobile storage row')
      return { key: row.key, value: JSON.parse(row.value) as T }
    })
  }

  transaction<T>(fn: () => T): T {
    const savepoint = `mobile_${this.depth++}`
    this.db.exec(`SAVEPOINT ${savepoint}`)
    try {
      const result = fn()
      if (result instanceof Promise) throw new TypeError('SQLite transactions must be synchronous')
      this.db.exec(`RELEASE SAVEPOINT ${savepoint}`)
      return result
    } catch (error) {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`)
      throw error
    } finally { this.depth-- }
  }

  close(): void { this.db.close() }
}
