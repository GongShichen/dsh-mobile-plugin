import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { HLSecretStore } from '../storage/HLSecretStore.js'
import { HLPersonalFramework } from './core/HLPersonalFramework.js'
import { HLPersonalSQLite } from './storage/HLPersonalSQLite.js'
import { HLGoogleOAuth, type HLGoogleClientConfiguration } from './connectors/google/HLGoogleOAuth.js'
import { hlCalendarOperations } from './connectors/google/HLCalendarConnector.js'
import { hlGmailOperations } from './connectors/google/HLGmailConnector.js'
import { hlGmailReplySource } from './connectors/google/HLGmailReplySource.js'
import { hlCalendarChangeSource } from './connectors/google/HLCalendarChangeSource.js'
import { HLPersonalAPI } from './transport/HLPersonalAPI.js'
import type { HLPersonalDSHHost } from './dsh/HLDSHHost.js'
import { HLDSHExecutionAdapter } from './dsh/HLDSHExecutionAdapter.js'
import { hlInstallPersonalTools } from './dsh/HLDSHTools.js'
import { hlInstallPersonalPresets } from './dsh/HLDSHPresets.js'

/** Composition root. The framework cannot outlive its Host plugin or its database. */
export class HLPersonalRuntime {
  readonly store: HLPersonalSQLite
  readonly framework: HLPersonalFramework
  readonly api: HLPersonalAPI
  readonly google: HLGoogleOAuth
  private timer?: ReturnType<typeof setInterval>
  private tickWork?: Promise<void>
  private attaching?: Promise<void>
  private detach?: () => Promise<void>
  private stopping?: Promise<void>
  private closing = false
  private pushed = new Set<string>()
  constructor(readonly options: { directory: string; secrets: HLSecretStore; scopeEntry: string; google?: HLGoogleClientConfiguration;
    diagnostic?(event: string, detail: string): void; attention?(noticeId: string, sessionId: string, kind: 'completed' | 'failed' | 'approval'): void }) {
    this.store = new HLPersonalSQLite(join(options.directory, 'personal.sqlite'))
    this.framework = new HLPersonalFramework({ store: this.store, id: randomUUID, directory: id => join(options.directory, 'work', id), diagnostic: options.diagnostic })
    this.google = new HLGoogleOAuth({ configuration: options.google ?? {}, secrets: options.secrets, store: this.store, changed: () => this.framework.changed() })
    this.framework.attachGoogle(this.google)
    for (const operation of [...hlCalendarOperations(this.google), ...hlGmailOperations(this.google)]) this.framework.connectors.register(operation)
    this.framework.registerTriggerSource(hlGmailReplySource(this.store, this.framework.actions))
    this.framework.registerTriggerSource(hlCalendarChangeSource(this.store, this.framework.actions))
    this.api = new HLPersonalAPI(this.framework, this.google)
  }
  attach(host: HLPersonalDSHHost): Promise<void> {
    if (this.attaching) return this.attaching
    this.attaching = this.install(host)
    return this.attaching
  }
  private async install(host: HLPersonalDSHHost): Promise<void> {
    await this.google.initialize()
    if (this.closing) return
    const execution = new HLDSHExecutionAdapter(host, () => {
      const main = this.framework.profile().mainSessionId
      return main ? host.agents.get(main)?.model.current() : undefined
    })
    let tools: (() => void) | undefined
    let presets: (() => Promise<void>) | undefined
    try {
      tools = hlInstallPersonalTools(host, this.framework, execution)
      presets = await hlInstallPersonalPresets(host, this.options.scopeEntry)
      if (this.closing) { await presets(); tools(); await execution.dispose(); return }
      this.framework.attachExecution(execution, execution)
      this.detach = async () => { tools?.(); await presets?.() }
      this.timer = setInterval(() => {
        if (this.closing || this.tickWork) return
        this.tickWork = this.framework.tick().then(() => { if (!this.closing) this.notifyAttention() })
          .catch(() => this.options.diagnostic?.('personal.tick.failed', 'code=unavailable')).finally(() => { this.tickWork = undefined })
      }, 1000)
      this.timer.unref()
      this.options.diagnostic?.('personal.ready', 'version=1')
    } catch (error) {
      tools?.(); await presets?.(); await execution.dispose(); throw error
    }
  }
  private notifyAttention(): void {
    for (const notice of this.store.list('notice', 100)) {
      if (this.pushed.has(notice.id)) continue
      const marker = `push:${notice.id}`
      if (this.store.get('marker', marker)) { this.pushed.add(notice.id); continue }
      const task = this.store.get('task', notice.taskId)
      if (!task?.binding) continue
      this.options.attention?.(notice.id, task.binding.sessionId, task.state === 'completed' ? 'completed' : task.state === 'failed' ? 'failed' : 'approval')
      this.store.transaction(() => this.store.put('marker', { id: marker, value: 'queued' }))
      this.pushed.add(notice.id)
    }
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.closing = true; if (this.timer) clearInterval(this.timer)
    this.stopping = (async () => {
      await this.attaching?.catch(() => undefined)
      await this.framework.stop(); await this.tickWork; await this.google.dispose(); await this.detach?.(); this.store.close()
    })()
    return this.stopping
  }
}
