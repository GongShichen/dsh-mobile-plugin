import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { randomUUID, generateKeyPairSync } from 'node:crypto'
import { applyWithDependencies, type HLConfig, type HLHostContext } from '../src/HLPlugin.ts'
import { HLSQLiteStore } from '../src/storage/HLStorage.ts'
import type { HLRuntimeOptions } from '../src/transport/HLRuntime.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'session/event'(session: { id: string }, event: { type: string; seq: number; data: Record<string, unknown> }): void
  }
}

const defaults = (directory: string): HLConfig => ({ hostName: 'Lifecycle Mac', dataDirectory: directory, maxFileBytes: 1024 * 1024, maxDeviceBytes: 2 * 1024 * 1024, uploadTtlMs: 60_000, invitationTtlMs: 300_000, maxConnections: 4, maxSubscriptions: 8 })
type HLRoute = Parameters<HLHostContext['connection']['fetch']['register']>[0]

function harness(root: Context) {
  const routes = new Map<string, HLRoute>()
  const browserPeer = { signal: new AbortController().signal, async dispose() {} }
  const mobilePeer = { signal: new AbortController().signal, async dispose() {} }
  function context(scope: Context): HLHostContext {
    return {
      root,
      connection: {
        browserPeer,
        admit(request) { return request.headers.get('x-peer') === 'mobile' ? { peer: mobilePeer } : request.headers.get('x-peer') === 'browser' ? { peer: browserPeer } : { rejection: 401 } },
        fetch: { register(route) { assert.equal(routes.has(route.path), false); routes.set(route.path, route); return async () => { routes.delete(route.path) } } },
        createPeer() { return { signal: new AbortController().signal, async dispose() {} } },
        createSharedFetchHandler() { return { async fetch() { return new Response(null, { status: 404 }) } } },
      },
      typertGateway: { async invoke() { return {} }, async stream() { return { async *[Symbol.asyncIterator]() {} } }, wireStream: { async open() { return { async *[Symbol.asyncIterator]() {} } } } },
      effect: effect => scope.effect(effect),
      on: (name, handler, options) => scope.on(name, handler, options),
      logger: { warn() {} },
    }
  }
  async function request(method: string, peer = 'browser', payload: unknown = {}) {
    const route = routes.get(`/api/mobileAccess/${method}`)
    assert.ok(route)
    return route.fetch(new Request(`http://127.0.0.1/api/mobileAccess/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-peer': peer }, body: JSON.stringify({ type: 'client-request', rpcId: 'request-1', method: `mobileAccess/${method}`, payload }) }))
  }
  return { routes, context, request }
}

function fakeRuntime(options: HLRuntimeOptions, calls: string[], failStart = false) {
  return {
    async start() { calls.push('start'); if (failStart) throw new Error('injected startup failure') },
    async stop() { calls.push('stop') },
    status() { return { running: true, hostName: options.hostName, endpointId: 'test-host', hostInstanceId: randomUUID(), invitation: undefined, devices: [], pending: [], connections: [] } },
    createInvitation() { return { uri: 'dsh-mobile://pair?data=test', expiresAt: Date.now() + 300_000 } },
    async broadcastPushConfigurationChanged() { calls.push('push-config-changed') },
    approve() { throw new Error('No pending device') }, reject() {}, async revoke() {}, listDevices() { return [] },
  }
}

test('Cordis mounting exposes authenticated exact routes and unload removes them and closes storage once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-lifecycle-'))
  const root = new Context()
  const environment = harness(root)
  const calls: string[] = []
  let closeCount = 0
  class HLTrackedStore extends HLSQLiteStore { override close() { closeCount++; super.close() } }
  try {
    const fiber = root.plugin(async ctx => {
      await applyWithDependencies(environment.context(ctx), defaults(directory), {
        createStore: path => new HLTrackedStore(path),
        createSecretStore: () => ({ async get() { return undefined }, async set() {}, async delete() {} }),
        createRuntime: options => fakeRuntime(options, calls),
      })
    })
    await fiber
    assert.equal(environment.routes.size, 6)
    assert.deepEqual(calls, ['start'])
    assert.equal((await environment.request('status', 'anonymous')).status, 401)
    const denied = await (await environment.request('startPairing', 'mobile')).json() as { result: { ok: boolean; error: { code: string } } }
    assert.equal(denied.result.ok, false)
    assert.equal(denied.result.error.code, 'mobile/desktop-required')
    const accepted = await (await environment.request('status')).json() as { type: string; rpcId: string; result: { ok: boolean; value: { hostName: string } } }
    assert.equal(accepted.type, 'server-response')
    assert.equal(accepted.rpcId, 'request-1')
    assert.equal(accepted.result.value.hostName, 'Lifecycle Mac')
    // Unknown/historical event details must never throw into the Agent event bus.
    root.emit('session/event', { id: 's' }, { type: 'turn/end', seq: 1, data: {} })
    root.emit('session/event', { id: 's' }, { type: 'approval/asked', seq: 2, data: { id: 'pending' } })
    await fiber.dispose()
    assert.equal(environment.routes.size, 0)
    assert.equal(closeCount, 1)
    assert.deepEqual(calls, ['start', 'stop'])
    await fiber.dispose()
    assert.equal(closeCount, 1)
  } finally { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test('startup failure eagerly releases routes and state even before the owning Cordis fiber unloads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-startup-failure-'))
  const root = new Context()
  const environment = harness(root)
  const calls: string[] = []
  let closeCount = 0
  class HLTrackedStore extends HLSQLiteStore { override close() { closeCount++; super.close() } }
  try {
    let failure: unknown
    const fiber = root.plugin(async ctx => {
      try {
        await applyWithDependencies(environment.context(ctx), defaults(directory), {
          createStore: path => new HLTrackedStore(path),
          createSecretStore: () => ({ async get() { return undefined }, async set() {}, async delete() {} }),
          createRuntime: options => fakeRuntime(options, calls, true),
        })
      } catch (error) { failure = error }
    })
    await fiber
    assert.match(String(failure), /injected startup failure/)
    assert.equal(environment.routes.size, 0)
    assert.equal(closeCount, 1)
    assert.deepEqual(calls, ['start', 'stop'])
    await fiber.dispose()
    assert.equal(closeCount, 1)
  } finally { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test('unload waits for an admitted credential import before closing SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-import-dispose-'))
  const root = new Context()
  const environment = harness(root)
  const calls: string[] = []
  let closeCount = 0
  let release!: () => void
  let began!: () => void
  const entered = new Promise<void>(resolve => { began = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  class HLTrackedStore extends HLSQLiteStore { override close() { closeCount++; super.close() } }
  try {
    const fiber = root.plugin(async ctx => {
      await applyWithDependencies(environment.context(ctx), defaults(directory), {
        createStore: path => new HLTrackedStore(path),
        createSecretStore: () => ({ async get() { return undefined }, async set() { began(); await gate }, async delete() {} }),
        createRuntime: options => fakeRuntime(options, calls),
      })
    })
    await fiber
    const p8 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const imported = environment.request('importNotifications', 'browser', { provider: 'apns', p8, keyId: 'ABCDEFGHIJ', teamId: '0123456789', bundleId: 'com.example.mobile', environment: 'sandbox' })
    await entered
    const unloading = fiber.dispose()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(closeCount, 0)
    release()
    assert.equal((await (await imported).json() as { result: { ok: boolean } }).result.ok, true)
    await unloading
    assert.equal(closeCount, 1)
    assert.equal(environment.routes.size, 0)
  } finally { release?.(); await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
})
