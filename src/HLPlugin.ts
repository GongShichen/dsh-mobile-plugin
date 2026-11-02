import Schema from '@deepseek-ai/schemastery'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HLDSHBridge, type HLDSHHostServices, type HLPeerScope } from './bridge/HLDSHBridge.ts'
import { HLAttachmentManager } from './attachments/HLAttachmentManager.ts'
import { HLRuntime, type HLRuntimeOptions } from './transport/HLTransport.ts'
import { HLSQLiteStore, HLMacKeychainSecretStore, type HLSecretStore } from './storage/HLStorage.ts'
import { createNotificationService, type HLNotificationImport } from './notifications/HLNotifications.ts'
import { HLPersonalRuntime } from './personal/HLPersonalRuntime.ts'
import { HL_PERSONAL_WEB_METHODS } from './personal/transport/HLPersonalAPI.ts'
import type { HLPersonalDSHHost } from './personal/dsh/HLDSHHost.ts'
import { HLError } from './transport/HLError.ts'

export const name = 'dsh-mobile-access'
export const inject = ['connection', 'typertGateway']
export const SUPPORTED_DSH_VERSION = '0.2.2-alpha.2'

export interface HLConfig {
  hostName: string
  dataDirectory: string
  maxFileBytes: number
  maxDeviceBytes: number
  uploadTtlMs: number
  invitationTtlMs: number
  maxConnections: number
  maxSubscriptions: number
}

export const HLConfig: Schema<HLConfig> = Schema.object({
  hostName: Schema.string().default(hostname()),
  dataDirectory: Schema.string().default(''),
  maxFileBytes: Schema.number().min(1).default(32 * 1024 * 1024),
  maxDeviceBytes: Schema.number().min(1).default(128 * 1024 * 1024),
  uploadTtlMs: Schema.number().min(1000).default(60 * 60 * 1000),
  invitationTtlMs: Schema.number().min(1000).max(5 * 60 * 1000).default(5 * 60 * 1000),
  maxConnections: Schema.number().min(1).max(64).default(8),
  maxSubscriptions: Schema.number().min(1).max(128).default(32),
})

interface HLRPCResult { ok: boolean; value?: unknown; error?: { code: string; message: string; details: object } }
type HLOwnerRPC = (endpoint: string, payload: unknown, signal: AbortSignal, peer: HLPeerScope) => Promise<HLRPCResult>
export interface HLHostContext extends HLDSHHostServices {
  root: { baseUrl?: string }
  connection: HLDSHHostServices['connection'] & {
    browserPeer: HLPeerScope
    admit(request: { headers: Headers }): { peer: HLPeerScope } | { rejection: number }
    fetch: { register(route: { path: string; methods: readonly ['POST']; requestBody: 'buffered'; fetch(request: Request): Promise<Response> }): () => Promise<void> }
  }
  effect(effect: () => (() => void | Promise<void>)): unknown
  on(name: 'session/event', handler: (session: { id: string }, event: { type: string; seq: number; data: Record<string, unknown> }) => void, options: { global: true }): unknown
  logger: { warn(...args: unknown[]): void; info?(...args: unknown[]): void }
  inject?(services: string[], callback: (host: HLPersonalDSHHost) => void | Promise<void>): unknown
}

type HLRuntimeSurface = Pick<HLRuntime, 'status' | 'start' | 'stop' | 'createInvitation' | 'approve' | 'reject' | 'revoke' | 'listDevices' | 'broadcastPushConfigurationChanged'>
/** Constructor seams allow lifecycle verification without native networking or real credentials. */
export interface HLPluginDependencies {
  createStore?: (path: string) => HLSQLiteStore
  createSecretStore?: (profileKey: string) => HLSecretStore
  createRuntime?: (options: HLRuntimeOptions) => HLRuntimeSurface
  createPersonalRuntime?: (options: ConstructorParameters<typeof HLPersonalRuntime>[0]) => HLPersonalRuntime
}

/** Install the mobile endpoint in an existing Web/Desktop profile; no additional server. */
export async function apply(ctx: HLHostContext, config: HLConfig): Promise<void> {
  await applyWithDependencies(ctx, config)
}

export async function applyWithDependencies(ctx: HLHostContext, config: HLConfig, dependencies: HLPluginDependencies = {}): Promise<void> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('Harness Link supports macOS Apple Silicon hosts')
  }
  const baseUrl = ctx.root.baseUrl
  if (!config.dataDirectory && (!baseUrl || !baseUrl.startsWith('file:'))) {
    throw new Error('Set dataDirectory when the profile has no filesystem base URL')
  }
  const directory = config.dataDirectory || join(fileURLToPath(baseUrl!), 'mobile-access')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const profileKey = createHash('sha256').update(directory).digest('hex').slice(0, 24)
  const store = dependencies.createStore?.(join(directory, 'mobile.sqlite')) ?? new HLSQLiteStore(join(directory, 'mobile.sqlite'))
  const disposers: Array<() => void | Promise<void>> = [() => store.close()]
  const activeManagement = new Set<Promise<Response>>()
  const stopScheduling: Array<() => void> = []
  let closing = false
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    if (disposal) return disposal
    closing = true
    disposal = (async () => {
      for (const stop of stopScheduling) stop()
      // Registered routes are marked closed immediately. Any existing credential import
      // must finish before notification state and its SQLite connection are released.
      await Promise.allSettled([...activeManagement])
      const errors: unknown[] = []
      for (const release of disposers.reverse()) {
        try { await release() } catch (error) { errors.push(error) }
      }
      if (errors.length) throw new AggregateError(errors, 'Mobile plugin cleanup failed')
    })()
    return disposal
  }
  ctx.effect(() => dispose)
  try {
  const secrets = dependencies.createSecretStore?.(profileKey) ?? new HLMacKeychainSecretStore('io.github.gongshichen.dsh-mobile', profileKey)
  let personal: HLPersonalRuntime | undefined
  if (ctx.inject) {
    try {
      const personalOptions: ConstructorParameters<typeof HLPersonalRuntime>[0] = { directory: join(directory, 'personal'), secrets,
        scopeEntry: new URL('./HLPersonalScope.js', import.meta.url).href,
        diagnostic: (event, detail) => ctx.logger.info?.(`[personal] ${event} ${detail}`),
        attention: (noticeId, sessionId, kind) => { if (!closing) notifications.enqueue({ eventId: `personal:${noticeId}`, sessionId, kind }) } }
      personal = dependencies.createPersonalRuntime?.(personalOptions) ?? new HLPersonalRuntime(personalOptions)
      disposers.push(() => personal!.stop())
    } catch { ctx.logger.warn('Personal Agent storage is unavailable; mobile access remains active') }
  }
  const bridge = new HLDSHBridge(ctx, personal?.api)
  disposers.push(() => bridge.dispose())
  const attachments = new HLAttachmentManager({ directory: join(directory, 'attachments'), maxFileBytes: config.maxFileBytes,
    maxDeviceBytes: config.maxDeviceBytes, ttlMs: config.uploadTtlMs }, bridge)
  disposers.push(() => attachments.dispose())
  let runtime: HLRuntimeSurface
  const notifications = createNotificationService({ storage: store, secrets, hostId: () => runtime?.status().endpointId ?? '' })
  disposers.push(() => notifications.dispose())
  const runtimeOptions: HLRuntimeOptions = { store, secretStore: secrets, bridge, attachments, notifications,
    hostName: config.hostName, dshVersion: SUPPORTED_DSH_VERSION, invitationTtlMs: config.invitationTtlMs,
    maxConnections: config.maxConnections, maxSubscriptions: config.maxSubscriptions,
    extraCapabilities: personal ? ['personal-agent-v1'] : [],
    onDeviceRevoked: deviceId => personal?.framework.revokeDevice(deviceId),
    onError: code => ctx.logger.warn('Mobile connection:', code),
    onDiagnostic: (event, detail) => ctx.logger.info?.(`[mobile] ${event} ${detail}`),
  }
  runtime = dependencies.createRuntime?.(runtimeOptions) ?? new HLRuntime(runtimeOptions)
  disposers.push(() => runtime.stop())
  if (personal) disposers.push(() => personal!.stop())
  if (personal && ctx.inject) {
    const feature = personal
    ctx.inject(['agents', 'sessions', 'sessionQuery', 'agentPresets', 'tools', 'systemPrompt'], host => {
      // Preset diagnostics may await the Loader: do not make this injected fiber await itself.
      void feature.attach(host).catch(() => ctx.logger.warn('Personal Agent Host adapter is unavailable; mobile access remains active'))
    })
  }
  const pendingNotifications = new Map<string, ReturnType<typeof setTimeout>>()
  const cleanup = setInterval(() => { void attachments.expire().catch(() => ctx.logger.warn('Mobile attachment cleanup failed')) }, 60_000)
  cleanup.unref()
  stopScheduling.push(() => {
    clearInterval(cleanup)
    for (const timer of pendingNotifications.values()) clearTimeout(timer)
    pendingNotifications.clear()
  })

  // Management is only available to the authenticated desktop browser peer.
  // Mobile peers use the narrower P2P method list and cannot import secrets.
  const management: HLOwnerRPC = async (endpoint, payload, _signal, peer) => {
    if (closing) return failure('mobile/stopping', 'Mobile access is stopping')
    if (peer !== ctx.connection.browserPeer) return failure('mobile/desktop-required', 'Configure mobile access from the desktop')
    try {
      const params = object(payload)
      let value: unknown
      switch (endpoint.slice('mobileAccess/'.length)) {
        case 'status': value = { ...runtime.status(), notifications: notifications.status() }; break
        case 'startPairing': value = runtime.createInvitation(); break
        case 'confirmDevice': {
          const id = requiredString(params.requestId)
          if (params.approved !== true && params.approved !== false) throw new Error('Choose approve or reject')
          value = params.approved ? runtime.approve(id) : runtime.reject(id)
          break
        }
        case 'revokeDevice': await runtime.revoke(requiredString(params.deviceId)); value = { revoked: true }; break
        case 'importNotifications': value = await notifications.importConfiguration(notificationImport(params)); await runtime.broadcastPushConfigurationChanged(); break
        case 'testNotification': {
          const deviceId = requiredString(params.deviceId)
          if (!runtime.listDevices().some(device => device.id === deviceId)) throw new Error('Unknown paired device')
          value = notifications.testNotification(deviceId); break
        }
        default: return failure('mobile/not-found', 'Unknown mobile management action')
      }
      return { ok: true, value: value ?? null }
    } catch (error) {
      // Configuration objects contain private keys. Return only vetted validation text.
      const message = !endpoint.endsWith('/importNotifications') && error instanceof Error && !/PRIVATE KEY|private_key|BEGIN|token|credential|oauth/i.test(error.message)
        ? error.message.slice(0, 240) : 'Could not complete mobile configuration; verify the selected files and account permissions'
      return failure('mobile/configuration', message)
    }
  }
  // Gateway owns the single shared /api RPC interceptor. Exact feature routes
  // coexist with it and retain the official browser authentication boundary.
  for (const method of ['status', 'startPairing', 'confirmDevice', 'revokeDevice', 'importNotifications', 'testNotification']) {
    const endpoint = `mobileAccess/${method}`
    const handle = async (request: Request): Promise<Response> => {
      if (closing) return new Response(null, { status: 503 })
      const admission = ctx.connection.admit(request)
      if ('rejection' in admission) return new Response(null, { status: admission.rejection })
      let input: Record<string, unknown>
      try {
        input = object(await request.json())
        if (input.type !== 'client-request' || typeof input.rpcId !== 'string' || input.method !== endpoint) throw new Error('Invalid RPC envelope')
      } catch { return Response.json({ error: 'Invalid RPC envelope' }, { status: 400 }) }
      const result = await management(endpoint, input.payload, request.signal, admission.peer)
      return Response.json({ type: 'server-response', rpcId: input.rpcId, result })
    }
    const remove = ctx.connection.fetch.register({ path: `/api/${endpoint}`, methods: ['POST'], requestBody: 'buffered', fetch: request => {
      const work = handle(request).finally(() => activeManagement.delete(work))
      activeManagement.add(work)
      return work
    } })
    disposers.push(remove)
  }

  if (personal) for (const method of HL_PERSONAL_WEB_METHODS) {
    const endpoint = `personalAccess/${method}`
    const feature = personal
    const handle = async (request: Request): Promise<Response> => {
      if (closing) return new Response(null, { status: 503 })
      const admission = ctx.connection.admit(request)
      if ('rejection' in admission) return new Response(null, { status: admission.rejection })
      if (admission.peer !== ctx.connection.browserPeer) return new Response(null, { status: 403 })
      let input: Record<string, unknown>
      try {
        input = object(await request.json())
        if (input.type !== 'client-request' || input.method !== endpoint || typeof input.rpcId !== 'string') throw new Error('Invalid envelope')
      } catch { return Response.json({ error: 'Invalid RPC envelope' }, { status: 400 }) }
      let result: HLRPCResult
      try {
        const value = await feature.api.invoke(`personal.${method}`, input.payload ?? {}, { deviceId: 'desktop-owner', desktop: true }, request.signal)
        result = { ok: true, value }
      } catch (error) { result = failure(error instanceof HLError ? error.code : 'PERSONAL_UNAVAILABLE', error instanceof HLError ? error.message : '私人助理操作未完成，请刷新后重试') }
      return Response.json({ type: 'server-response', rpcId: input.rpcId, result })
    }
    const remove = ctx.connection.fetch.register({ path: `/api/${endpoint}`, methods: ['POST'], requestBody: 'buffered', fetch: request => {
      const work = handle(request).finally(() => activeManagement.delete(work)); activeManagement.add(work); return work
    } })
    disposers.push(remove)
  }

  ctx.on('session/event', (session, event) => {
    if (closing) return
    if (personal) {
      try { personal.framework.observe(session.id, event) } catch { ctx.logger.warn('Personal Agent event projection failed') }
      const role = personal.framework.role(session.id)
      if (role === 'assistant') {
        const question = event.type === 'tool/call' && event.data.name === 'ask_user_question'
        if (event.type === 'approval/asked' || question) {
          notifications.enqueue({ eventId: `personal:main:${session.id}:${event.seq}`, sessionId: session.id, kind: 'approval' })
        }
      }
      if (role || personal.framework.delegatedSession(session.id)) return
    }
    const prefix = `${runtime.status().endpointId}:${session.id}`
    if (event.type === 'approval/asked' && typeof event.data.id === 'string') {
      const eventId = `${prefix}:approval:${event.data.id}`
      if (pendingNotifications.has(eventId)) return
      const timer = setTimeout(() => {
        pendingNotifications.delete(eventId)
        if (closing) return
        notifications.enqueue({ eventId, sessionId: session.id, kind: 'approval' })
      }, 1000)
      timer.unref(); pendingNotifications.set(eventId, timer)
    } else if (event.type === 'approval/decided' && typeof event.data.id === 'string') {
      const eventId = `${prefix}:approval:${event.data.id}`
      const timer = pendingNotifications.get(eventId)
      if (timer) clearTimeout(timer)
      pendingNotifications.delete(eventId)
      notifications.cancelEvent(eventId)
    } else if (event.type === 'turn/end') {
      const reason = event.data.reason && typeof event.data.reason === 'object' ? object(event.data.reason) : {}
      if (reason.kind === 'completed' || reason.kind === 'error' || reason.kind === 'blocked') {
        notifications.enqueue({ eventId: `${prefix}:turn:${event.seq}`, sessionId: session.id,
          kind: reason.kind === 'completed' ? 'completed' : 'failed' })
      }
    } else if (event.type === 'job/settled' && typeof event.data.jobId === 'string') {
      if (event.data.status === 'completed' || event.data.status === 'failed') {
        notifications.enqueue({ eventId: `${prefix}:job:${event.data.jobId}:${event.data.status}`, sessionId: session.id,
          kind: event.data.status === 'completed' ? 'completed' : 'failed' })
      }
    }
  }, { global: true })
  await runtime.start()
  } catch (error) {
    try { await dispose() } catch { ctx.logger.warn('Mobile startup cleanup failed') }
    throw error
  }
}

function failure(code: string, message: string): HLRPCResult { return { ok: false, error: { code, message, details: {} } } }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object')
  return value as Record<string, unknown>
}
function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024) throw new Error('Missing or invalid configuration field')
  return value
}
function notificationImport(params: Record<string, unknown>): HLNotificationImport {
  if (params.provider === 'apns') {
    if (params.environment !== 'sandbox' && params.environment !== 'production') throw new Error('Select the APNs environment')
    if (typeof params.p8 !== 'string' || params.p8.length > 16384) throw new Error('Select an APNs key file')
    return { provider: 'apns', p8: params.p8, keyId: requiredString(params.keyId), teamId: requiredString(params.teamId),
      bundleId: requiredString(params.bundleId), environment: params.environment }
  }
  if (params.provider === 'fcm') {
    if (typeof params.googleServicesJson !== 'string' || typeof params.serviceAccountJson !== 'string' ||
      params.googleServicesJson.length > 262144 || params.serviceAccountJson.length > 65536) throw new Error('Select both Firebase configuration files')
    return { provider: 'fcm', googleServicesJson: params.googleServicesJson, serviceAccountJson: params.serviceAccountJson,
      ...(typeof params.applicationId === 'string' ? { applicationId: params.applicationId } : {}) }
  }
  throw new Error('Unsupported notification provider')
}

/** Cordis configuration discovery hook. */
export { HLConfig as Config }
