import assert from 'node:assert/strict'
import { test } from 'node:test'
import { permissionCatalog, permissionSelection } from '../src/bridge/HLPermissions.ts'
import { HLDSHBridge } from '../src/bridge/HLDSHBridge.ts'
import type { HLDSHHostServices, HLGatewayRequest, HLPeerScope } from '../src/bridge/HLBridgeTypes.ts'
import { permissionCatalogStream } from '../src/sync/HLPermissionCatalogStream.ts'

const catalog = { options: ['read-only', 'workspace-write', 'danger-full-access', 'auto', 'team-rules'].map(value => ({ value, name: value })), defaultOptions: [{ value: 'read-only', name: 'Read Only' }], defaultPreset: 'read-only' }

test('catalog transfers labels and selectable values, never host policy rules', () => {
  assert.deepEqual(permissionCatalog({ ...catalog, approval: 'private', options: [{ value: 'team-rules', name: '团队规则', description: 'Host-owned policy', rules: { private: true } }] }),
    { ...catalog, options: [{ value: 'team-rules', name: '团队规则', description: 'Host-owned policy' }] })
  assert.throws(() => permissionCatalog({ options: [] }), { code: 'permissions/invalid-catalog' })
})

test('permission selection is bounded by the live catalog and dangerous presets require explicit acknowledgment', () => {
  assert.deepEqual(permissionSelection({ sessionId: 's', preset: 'workspace-write' }, catalog), { sessionId: 's', preset: 'workspace-write', line: '/permission workspace-write' })
  for (const preset of ['danger-full-access', 'auto']) {
    assert.throws(() => permissionSelection({ sessionId: 's', preset }, catalog), { code: 'permissions/confirmation-required' })
    assert.equal(permissionSelection({ sessionId: 's', preset, acknowledged: true }, catalog).line, `/permission ${preset}`)
  }
  assert.throws(() => permissionSelection({ sessionId: 's', preset: 'workspace-write', line: '/other' }, catalog), { code: 'mobile/invalid-params' })
  assert.throws(() => permissionSelection({ sessionId: 's', preset: 'withdrawn' }, catalog), { code: 'permissions/unavailable' })
  const invalid = 'team\n/other'
  assert.throws(() => permissionSelection({ sessionId: 's', preset: invalid }, { ...catalog, options: [{ value: invalid, name: invalid }] }), { code: 'permissions/unavailable' })
})

test('bridge invokes only the official current-session command with its wire agentId and checks settlement', async () => {
  const calls: HLGatewayRequest<HLPeerScope>[] = []
  let success = true
  const host: HLDSHHostServices = {
    connection: {
      createPeer() { const controller = new AbortController(); return { signal: controller.signal, async dispose() { controller.abort() } } },
      createSharedFetchHandler() { return { async fetch() { throw new Error('No generic Fetch command is used') } } },
    },
    typertGateway: {
      async invoke(request) { calls.push(request); return request.namespace === 'permissionPresets' ? catalog : { commandId: 'c', result: { kind: success ? 'success' : 'error', text: success ? 'preset read-only' : 'preset withdrew' } } },
      async stream() { throw new Error('Unused') }, wireStream: { async open() { throw new Error('Unused') } },
    },
  }
  const bridge = new HLDSHBridge(host), peer = bridge.createPeer('phone')
  assert.deepEqual(await bridge.invoke(peer, 'permissions.select', { operationId: 'op', sessionId: 'original-session', preset: 'workspace-write' }), { accepted: true })
  assert.equal(calls[0]?.namespace, 'permissionPresets'); assert.equal(calls[0]?.method, 'catalog')
  assert.deepEqual(calls[1]?.args, { agentId: 'original-session', line: '/permission workspace-write', submittedAttachments: [] })
  assert.equal(calls[1]?.namespace, 'commands'); assert.equal(calls[1]?.method, 'execute'); assert.equal(calls[1]?.peer, peer.scope)
  success = false
  await assert.rejects(bridge.invoke(peer, 'permissions.select', { sessionId: 's', preset: 'read-only' }), { code: 'permissions/rejected' })
  await assert.rejects(bridge.invoke(peer, 'commands.execute', { agentId: 's', line: '/other' }), { code: 'mobile/method-not-found' })
  await bridge.disposePeer(peer)
  await assert.rejects(bridge.invoke(peer, 'permissions.catalog', {}), { code: 'mobile/peer-closed' })
})

test('permission catalog subscribes before its baseline and re-reads queued invalidations', async () => {
  let listening = false, released = false, reads = 0
  const events = { async *[Symbol.asyncIterator]() { try {
    listening = true; yield { type: 'ready' }; yield { type: 'emit', event: 'unrelated' }; yield { type: 'emit', event: 'permission-presets/catalog-changed' }
  } finally { released = true } } }
  const frames: unknown[] = []
  for await (const frame of permissionCatalogStream(events, async () => { assert.equal(listening, true); return { revision: ++reads } }, new AbortController().signal)) frames.push(frame)
  assert.deepEqual(frames, [{ type: 'baseline', value: { revision: 1 } }, { type: 'baseline', value: { revision: 2 } }])
  assert.equal(released, true)
})

test('catalog cancellation discards an in-flight read and releases its upstream', async () => {
  const controller = new AbortController(); let released = false
  const events = { async *[Symbol.asyncIterator]() { try { yield { type: 'ready' } } finally { released = true } } }
  const stream = permissionCatalogStream(events, async () => { controller.abort(); return catalog }, controller.signal)
  await assert.rejects(async () => { for await (const _ of stream) assert.fail('Cancelled baseline must not be published') }, { name: 'AbortError' })
  assert.equal(released, true)
})
