import { randomUUID } from 'node:crypto'
import { Endpoint, EndpointTicket, type BiStream, type Connection, type PathSnapshot } from '@number0/iroh'
import type { MobilePeer } from '../bridge/types.js'
import { PairingManager, type PairedDevice } from '../pairing/pairing.js'
import { OperationLedger } from '../storage/operations.js'
import { loadIdentity, type SecretStore } from '../storage/secrets.js'
import type { KeyValueStore } from '../storage/store.js'
import { MobileError, publicError } from './errors.js'
import { FrameWriter, integerField, object, readFrame, stringField } from './framing.js'

export const MOBILE_ALPN = 'dsh-mobile/1'
const ALPN_BYTES = Array.from(Buffer.from(MOBILE_ALPN))
const MUTATIONS = new Set(['sessions.create', 'sessions.rename', 'sessions.fork', 'sessions.prompt', 'sessions.cancel', 'sessions.updateQueue', 'sessions.archive', 'sessions.unarchive', 'sessions.pin', 'sessions.unpin', 'workspaces.create', 'workspaces.rename', 'models.select', 'jobs.kill', 'interactions.reply', 'questions.answer', 'feedback.put', 'feedback.delete'])

export interface BridgePort {
  createPeer(deviceId: string): MobilePeer
  disposePeer(peer: MobilePeer): Promise<void>
  invoke(peer: MobilePeer, method: string, params: unknown, signal?: AbortSignal): Promise<unknown>
  subscribe(peer: MobilePeer, topic: string, request: unknown, signal: AbortSignal): AsyncIterable<unknown>
}
export interface AttachmentPort {
  authorizeDevice?(deviceId: string): Promise<void>
  begin(deviceId: string, request: unknown): Promise<unknown>
  status(deviceId: string, uploadId: string): Promise<unknown>
  writeChunk(deviceId: string, uploadId: string, offset: number, bytes: Uint8Array): Promise<unknown>
  finalize(peer: MobilePeer, uploadId: string, signal?: AbortSignal): Promise<unknown>
  cancel(deviceId: string, uploadId: string): Promise<unknown>
  revokeDevice(deviceId: string): Promise<void>
  createDownload(peer: MobilePeer, params: unknown, signal?: AbortSignal): Promise<unknown>
  readDownload(deviceId: string, downloadId: string, offset: number): Promise<{ bytes: Uint8Array; length: number; sha256: string }>
}
export interface NotificationPort {
  handle(deviceId: string, method: string, params: unknown): Promise<unknown>
  revokeDevice(deviceId: string): Promise<void>
}
export interface RuntimeOptions {
  store: KeyValueStore
  secretStore: SecretStore
  bridge: BridgePort
  attachments: AttachmentPort
  notifications?: NotificationPort
  hostName: string
  dshVersion: string
  adapterVersion?: string
  invitationTtlMs?: number
  maxConnections?: number
  maxSubscriptions?: number
  /** Local-only binding is for encrypted integration tests, not a production fallback. */
  endpointFactory?: (secret: Uint8Array) => Promise<Endpoint>
  onStateChange?: () => void
  onError?: (code: string) => void
  onDiagnostic?: (event: string, detail: string) => void
}

interface ConnectedDevice {
  id: string
  deviceId: string
  connection: Connection
  lifetime: AbortController
  connectedAt: number
  path: 'direct' | 'relay' | 'connecting'
  peer?: MobilePeer
  events?: FrameWriter
  eventsReady?: Promise<void>
  rpcSeen: boolean
  subscriptions: Map<string, AbortController>
  tasks: Set<Promise<void>>
  background: Set<Promise<void>>
  closeTask?: Promise<void>
}

/** Owns authenticated mobile connections, not the underlying DSH Agent lifecycle. */
export class MobileRuntime {
  private endpoint?: Endpoint
  private starting?: Promise<void>
  private accepting?: Promise<void>
  private stopping = false
  private readonly connected = new Map<string, ConnectedDevice>()
  private readonly pairing: PairingManager
  private readonly operations: OperationLedger
  private readonly instanceId = randomUUID()
  private pendingHandshakes = 0

  constructor(private readonly options: RuntimeOptions) {
    this.pairing = new PairingManager(options.store, Date.now, options.invitationTtlMs)
    this.operations = new OperationLedger(options.store)
  }

  start(): Promise<void> {
    if (this.endpoint) return Promise.resolve()
    if (this.starting) return this.starting
    this.stopping = false
    this.starting = (async () => {
      const secret = await loadIdentity(this.options.secretStore)
      let endpoint: Endpoint
      try {
        endpoint = await (this.options.endpointFactory?.(secret) ?? Endpoint.bind({ secretKey: Array.from(secret), alpns: [ALPN_BYTES] }))
      } finally { secret.fill(0) }
      if (this.stopping) { await endpoint.close(); return }
      this.endpoint = endpoint
      this.accepting = this.acceptLoop(endpoint)
      this.changed()
    })().finally(() => { this.starting = undefined })
    return this.starting
  }

  async stop(): Promise<void> {
    this.stopping = true
    // A Keychain read/native bind cannot be abandoned: otherwise an endpoint could
    // finish binding after plugin teardown and retain an unowned listener.
    await this.starting?.catch(() => {})
    const endpoint = this.endpoint
    this.endpoint = undefined
    const states = [...this.connected.values()]
    await Promise.all(states.map(state => this.closeState(state, 'Plugin stopped')))
    await endpoint?.close()
    await this.accepting
    await Promise.allSettled(states.flatMap(state => [...state.tasks, ...state.background]))
    this.changed()
  }

  status() {
    const invitation = this.pairing.current()
    return {
      running: this.endpoint !== undefined,
      hostName: this.options.hostName,
      endpointId: this.endpoint?.id().toString() ?? '',
      hostInstanceId: this.instanceId,
      invitation: invitation ? { uri: invitation.url, expiresAt: invitation.invitation.expiresAt } : undefined,
      devices: this.pairing.devices().map(device => ({ ...device, deviceId: device.id })),
      pending: this.pairing.pending(),
      connections: [...this.connected.values()].filter(state => state.peer).map(state => ({ deviceId: state.deviceId, path: state.path, connectedAt: state.connectedAt, rttMs: state.connection.rtt() })),
    }
  }

  createInvitation() {
    if (!this.endpoint) throw new MobileError('NOT_RUNNING', 'Mobile access is not running')
    const invitation = this.pairing.create(this.endpoint.id().toString(), EndpointTicket.fromAddr(this.endpoint.addr()).toString(), this.options.hostName)
    this.diagnostic("pairing.invitation.created", `ttlSeconds=${Math.round((invitation.invitation.expiresAt - Date.now()) / 1000)}`)
    this.changed()
    return { uri: invitation.url, expiresAt: invitation.invitation.expiresAt }
  }
  listPending() { return this.pairing.pending() }
  listDevices() { return this.pairing.devices() }
  /** Public invalidation only: clients fetch public options through their authorized RPC. */
  async broadcastPushConfigurationChanged(): Promise<void> {
    await Promise.all([...this.connected.values()].filter(state => state.peer && state.events && !state.lifetime.signal.aborted).map(async state => {
      try { await state.events!.write({ v: 1, type: 'notice', name: 'push-configuration-changed' }) }
      catch { await this.closeState(state, 'Event stream unavailable') }
    }))
  }
  approve(requestId: string): PairedDevice { const device = this.pairing.approve(requestId); this.diagnostic("pairing.approved", `platform=${device.platform}`); this.changed(); return device }
  reject(requestId: string): void { this.pairing.reject(requestId); this.changed() }

  async revoke(deviceId: string): Promise<void> {
    this.pairing.revoke(deviceId)
    const states = [...this.connected.values()].filter(state => state.deviceId === deviceId)
    await Promise.all(states.map(state => this.closeState(state, 'Device revoked')))
    await Promise.allSettled(states.flatMap(state => [...state.tasks, ...state.background]))
    await this.options.attachments.revokeDevice(deviceId)
    await this.options.notifications?.revokeDevice(deviceId)
    this.changed()
  }

  private changed(): void { this.options.onStateChange?.() }
  private diagnostic(event: string, detail = ""): void { try { this.options.onDiagnostic?.(event, detail) } catch { /* Diagnostics must not fail a connection. */ } }
  private report(error: unknown): void { this.options.onError?.(publicError(error).code) }

  private async acceptLoop(endpoint: Endpoint): Promise<void> {
    while (!this.stopping) {
      try {
        const incoming = await endpoint.acceptNext()
        if (!incoming) break
        if (this.connected.size + this.pendingHandshakes >= (this.options.maxConnections ?? 32)) { await incoming.refuse(); continue }
        this.pendingHandshakes++
        void incoming.accept().then(accepting => accepting.connect()).then(async connection => {
          this.pendingHandshakes--
          if (this.stopping) { connection.close(0n, Array.from(Buffer.from('Stopping'))); return }
          await this.serve(connection)
        }, error => { this.pendingHandshakes--; this.report(error) }).catch(error => this.report(error))
      } catch (error) { if (!this.stopping) this.report(error); break }
    }
  }

  private async serve(connection: Connection): Promise<void> {
    const state: ConnectedDevice = { id: randomUUID(), deviceId: connection.remoteId().toString(), connection, lifetime: new AbortController(), connectedAt: Date.now(), path: 'connecting', rpcSeen: false, subscriptions: new Map(), tasks: new Set(), background: new Set() }
    this.connected.set(state.id, state)
    this.diagnostic("connection.accepted", `connection=${state.id.slice(0, 8)}`)
    connection.setMaxConcurrentBiStreams(8n)
    connection.setMaxConcurrentUniStreams(0n)
    connection.setReceiveWindow(4n * 1024n * 1024n)
    const updatePaths = (paths: PathSnapshot[]) => {
      const selected = paths.find(path => path.isSelected)
      const nextPath = selected?.isIp ? 'direct' : selected?.isRelay ? 'relay' : 'connecting'
      if (nextPath !== state.path) this.diagnostic('connection.path', `connection=${state.id.slice(0, 8)} path=${nextPath}`)
      state.path = nextPath
      this.changed()
    }
    updatePaths(connection.paths())
    // Polling avoids native callback-runtime differences across iroh releases.
    const pathsTimer = setInterval(() => updatePaths(connection.paths()), 5000)
    pathsTimer.unref()
    const authenticationTimer = setTimeout(() => { if (!state.peer) void this.closeState(state, 'Pairing timeout') }, this.options.invitationTtlMs ?? 300_000)
    authenticationTimer.unref()
    void connection.closed().then(() => this.closeState(state, 'Disconnected')).catch(error => this.report(error))
    try {
      while (!state.lifetime.signal.aborted) {
        const stream = await connection.acceptBi()
        if (state.tasks.size >= 8) { await stream.recv.stop(1n); await stream.send.reset(1n); continue }
        const task = this.serveStream(state, stream).catch(error => {
          if (!state.lifetime.signal.aborted) this.report(error)
          void stream.recv.stop(1n).catch(() => {})
          void stream.send.reset(1n).catch(() => {})
        }).finally(() => state.tasks.delete(task))
        state.tasks.add(task)
      }
    } catch (error) { if (!state.lifetime.signal.aborted) this.report(error) }
    finally { clearInterval(pathsTimer); clearTimeout(authenticationTimer); await this.closeState(state, 'Disconnected') }
  }

  private async closeState(state: ConnectedDevice, reason: string): Promise<void> {
    if (state.closeTask) return state.closeTask
    this.diagnostic("connection.closed", `connection=${state.id.slice(0, 8)} reason=${reason}`)
    state.lifetime.abort()
    state.connection.close(0n, Array.from(Buffer.from(reason)))
    for (const controller of state.subscriptions.values()) controller.abort()
    state.subscriptions.clear()
    this.connected.delete(state.id)
    state.closeTask = (async () => {
      if (state.peer) await this.options.bridge.disposePeer(state.peer)
      state.peer = undefined
      this.changed()
    })()
    return state.closeTask
  }

  private async authorize(state: ConnectedDevice): Promise<MobilePeer> {
    if (state.lifetime.signal.aborted || !this.pairing.device(state.deviceId)) throw new MobileError('UNAUTHORIZED', 'This device is not authorized')
    if (!state.peer) {
      state.peer = this.options.bridge.createPeer(state.deviceId)
      this.pairing.touch(state.deviceId)
      state.eventsReady = (async () => {
        await this.options.attachments.authorizeDevice?.(state.deviceId)
        if (!this.pairing.device(state.deviceId)) throw new MobileError('UNAUTHORIZED', 'This device was revoked')
        state.lifetime.signal.throwIfAborted()
        const stream = await state.connection.openBi()
        const writer = new FrameWriter(stream.send)
        await writer.write({ v: 1, type: 'stream', kind: 'events' })
        state.events = writer
      })()
      this.changed()
    }
    await state.eventsReady
    state.lifetime.signal.throwIfAborted()
    return state.peer
  }

  private async serveStream(state: ConnectedDevice, stream: BiStream): Promise<void> {
    const timer = setTimeout(() => { void stream.recv.stop(1n).catch(() => {}) }, 15_000)
    timer.unref()
    let header: Record<string, unknown>
    try { header = object(await readFrame(stream.recv)) }
    finally { clearTimeout(timer) }
    if (header.v !== 1 || header.type !== 'stream') throw new MobileError('PROTOCOL_MISMATCH', 'Unsupported stream protocol')
    const kind = stringField(header, 'kind')
    if (kind !== 'rpc' && !state.rpcSeen) throw new MobileError('RPC_REQUIRED', 'The first stream must be the control stream')
    const writer = new FrameWriter(stream.send)
    if (kind === 'rpc') {
      if (state.rpcSeen) throw new MobileError('DUPLICATE_RPC_STREAM', 'Only one RPC stream is allowed')
      state.rpcSeen = true
      try {
        while (!state.lifetime.signal.aborted) {
          const raw = object(await readFrame(stream.recv))
          const id = stringField(raw, 'id', 128)
          try {
            if (raw.v !== 1) throw new MobileError('PROTOCOL_MISMATCH', 'Unsupported protocol version')
            const result = await this.dispatch(state, stringField(raw, 'method', 128), object(raw.params ?? {}))
            await writer.write({ v: 1, id, result: result ?? null })
          } catch (error) { this.diagnostic("rpc.failed", `code=${publicError(error).code}`); await writer.write({ v: 1, id, error: publicError(error) }) }
        }
      } finally { await this.closeState(state, 'Control stream closed') }
      return
    }
    await this.authorize(state)
    try {
      if (kind === 'upload') {
        const uploadId = stringField(header, 'uploadId')
        const offset = integerField(header, 'offset', Number.MAX_SAFE_INTEGER)
        const length = integerField(header, 'length', 65_536)
        const bytes = Uint8Array.from(await stream.recv.readExact(length))
        if (bytes.length !== length) throw new MobileError('TRUNCATED_UPLOAD', 'Incomplete upload chunk')
        const result = await this.options.attachments.writeChunk(state.deviceId, uploadId, offset, bytes)
        state.lifetime.signal.throwIfAborted()
        await writer.write({ result })
      } else if (kind === 'download') {
        const result = await this.options.attachments.readDownload(state.deviceId, stringField(header, 'downloadId'), integerField(header, 'offset', Number.MAX_SAFE_INTEGER))
        state.lifetime.signal.throwIfAborted()
        await writer.write({ length: result.length, sha256: result.sha256 })
        for (let offset = 0; offset < result.bytes.length; offset += 65_536) {
          state.lifetime.signal.throwIfAborted()
          await stream.send.writeAll(Array.from(result.bytes.subarray(offset, offset + 65_536)))
        }
      } else throw new MobileError('INVALID_STREAM', 'Unsupported stream kind')
    } catch (error) { await writer.write({ error: publicError(error) }) }
    finally { await stream.send.finish(); await stream.recv.stop(0n) }
  }

  private async dispatch(state: ConnectedDevice, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method !== "pairing.status") this.diagnostic("rpc.received", `connection=${state.id.slice(0, 8)} method=${/^[a-zA-Z]+\.[a-zA-Z]+$/.test(method) || method === "hello" || method === "subscribe" || method === "unsubscribe" ? method : "unsupported"}`)
    if (method === 'hello') {
      const authorized = this.pairing.device(state.deviceId) !== undefined
      if (authorized) await this.authorize(state)
      return { protocolVersion: 1, authorized, hostId: this.endpoint?.id().toString(), hostInstanceId: this.instanceId, hostName: this.options.hostName, dshVersion: this.options.dshVersion, adapterVersion: this.options.adapterVersion ?? '0.1.0', capabilities: authorized ? ['sessions', 'workspaces', 'models', 'files', 'attachments', 'interactions', 'jobs', 'push', 'feedback'] : [] }
    }
    if (method === 'pairing.request') {
      const platform = stringField(params, 'platform')
      if (platform !== 'android' && platform !== 'ios') throw new MobileError('INVALID_ARGUMENT', 'Unsupported mobile platform')
      const result = this.pairing.request(state.deviceId, { pairingId: stringField(params, 'pairingId'), secret: stringField(params, 'secret'), name: stringField(params, 'name', 100), platform })
      this.diagnostic("pairing.request.received", `platform=${platform}`)
      this.changed()
      return result
    }
    if (method === 'pairing.status') {
      const status = this.pairing.status(state.deviceId, stringField(params, 'requestId'))
      if (status === 'approved') await this.authorize(state)
      return { status, ...(status === 'approved' ? { hostId: this.endpoint?.id().toString(), hostName: this.options.hostName } : {}) }
    }
    const peer = await this.authorize(state)
    const signal = state.lifetime.signal
    if (method === 'subscribe') {
      if (state.subscriptions.size >= (this.options.maxSubscriptions ?? 32)) throw new MobileError('SUBSCRIPTION_LIMIT', 'Too many active subscriptions')
      const topic = stringField(params, 'topic')
      const subscriptionId = randomUUID()
      const generation = randomUUID()
      const controller = new AbortController()
      state.subscriptions.set(subscriptionId, controller)
      const lifetime = AbortSignal.any([signal, controller.signal])
      const work = (async () => {
        try {
          for await (const event of this.options.bridge.subscribe(peer, topic, object(params.request ?? {}), lifetime)) {
            lifetime.throwIfAborted()
            await state.events!.write({ v: 1, type: 'event', subscriptionId, generation, event })
          }
          if (!lifetime.aborted) await state.events!.write({ v: 1, type: 'event', subscriptionId, generation, event: { type: 'end' } })
        } catch (error) {
          if (!lifetime.aborted) {
            this.diagnostic("subscription.failed", `topic=${topic} code=${publicError(error).code}`)
            try { await state.events!.write({ v: 1, type: 'event', subscriptionId, generation, event: { type: 'error', error: publicError(error) } }) }
            catch { await this.closeState(state, 'Event stream unavailable') }
          }
        } finally { controller.abort(); state.subscriptions.delete(subscriptionId) }
      })().finally(() => state.background.delete(work))
      state.background.add(work)
      return { subscriptionId, generation }
    }
    if (method === 'unsubscribe') { const id = stringField(params, 'subscriptionId'); state.subscriptions.get(id)?.abort(); state.subscriptions.delete(id); return { accepted: true } }
    if (method.startsWith('push.')) {
      if (!this.options.notifications) throw new MobileError('PUSH_UNAVAILABLE', 'Notifications are unavailable')
      return this.options.notifications.handle(state.deviceId, method, params)
    }
    if (method === 'attachments.begin') return this.options.attachments.begin(state.deviceId, params)
    if (method === 'attachments.status') return this.options.attachments.status(state.deviceId, stringField(params, 'uploadId'))
    if (method === 'attachments.finalize') return this.options.attachments.finalize(peer, stringField(params, 'uploadId'), signal)
    if (method === 'attachments.cancel') return this.options.attachments.cancel(state.deviceId, stringField(params, 'uploadId'))
    if (method === 'files.download') return this.options.attachments.createDownload(peer, params, signal)
    const invoke = () => { signal.throwIfAborted(); return this.options.bridge.invoke(peer, method, params, signal) }
    if (MUTATIONS.has(method)) return this.operations.execute(state.deviceId, stringField(params, 'operationId', 128), method, params, invoke)
    return invoke()
  }
}
