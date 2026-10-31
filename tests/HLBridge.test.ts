import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HLDSHBridge } from '../src/bridge/HLDSHBridge.ts'
import type { HLDSHHostServices, HLGatewayRequest, HLPeerScope } from '../src/bridge/HLBridgeTypes.ts'

function fixture() {
  const calls: HLGatewayRequest<HLPeerScope>[] = []
  let streamFactory = async function*(_request: HLGatewayRequest<HLPeerScope>): AsyncGenerator<unknown> { yield { type: 'baseline', value: { items: [] } } }
  const eventFrames: unknown[] = [{ type: 'ready', clientId: 'client-1' }]
  const fetched: Request[] = []
  const envelopes: unknown[] = []
  let eventClosed = false
  let invokeResult = (_request: HLGatewayRequest<HLPeerScope>): unknown => ({ items: [] })
  const host: HLDSHHostServices = {
    connection: {
      createPeer() { const controller = new AbortController(); return { signal: controller.signal, async dispose() { controller.abort() } } },
      createSharedFetchHandler() { return { async fetch(request) {
        fetched.push(request)
        const body = await request.json() as { rpcId: string }
        envelopes.push(body)
        return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true } })
      } } },
    },
    typertGateway: {
      async invoke(request) { calls.push(request); return invokeResult(request) },
      async stream(request) { calls.push(request); return streamFactory(request) },
      wireStream: { async open() { return { async *[Symbol.asyncIterator]() { try { yield* eventFrames } finally { eventClosed = true } } } } },
    },
  }
  const bridge = new HLDSHBridge(host)
  const peer = bridge.createPeer('phone')
  return { bridge, peer, calls, eventFrames, fetched, envelopes, eventClosed: () => eventClosed,
    setInvoke: (next: typeof invokeResult) => { invokeResult = next },
    setStream: (next: typeof streamFactory) => { streamFactory = next } }
}

test('mobile methods preserve exact Gateway arguments and never allow namespace passthrough', async () => {
  const f = fixture()
  await f.bridge.invoke(f.peer, 'sessions.prompt', { operationId: 'op', sessionId: 's', requestId: 'r', mode: 'queue', content: [{ type: 'text', text: 'hi' }] })
  assert.equal(f.calls[0]?.namespace, 'session')
  assert.deepEqual(f.calls[0]?.args, { request: { sessionId: 's', requestId: 'r', mode: 'queue', content: [{ type: 'text', text: 'hi' }] } })
  await f.bridge.invoke(f.peer, 'sessions.list', {})
  assert.deepEqual(f.calls[1]?.args, { _request: {} })
  await f.bridge.invoke(f.peer, 'files.read', { sessionId: 's', path: 'hello.txt' })
  assert.deepEqual(f.calls[2]?.args, { workspaceFileScopeId: 's', path: 'hello.txt', range: {} })
  await assert.rejects(f.bridge.invoke(f.peer, 'credentials.set', { ns: 'secrets' }), { code: 'mobile/method-not-found' })
  await assert.rejects(f.bridge.invoke(f.peer, 'sessions.constructor', {}), { code: 'mobile/method-not-found' })
  await f.bridge.disposePeer(f.peer)
  await assert.rejects(f.bridge.invoke(f.peer, 'sessions.list', {}), { code: 'mobile/peer-closed' })
})

test('follow uses opening snapshot semantics and disposes its upstream on return', async () => {
  const f = fixture()
  let released = false
  f.setStream(async function*() { try { yield { type: 'snapshot', cursor: 42 }; yield { type: 'event' } } finally { released = true } })
  const stream = f.bridge.subscribe(f.peer, 'session', { sessionId: 's' }, new AbortController().signal)
  for await (const frame of stream) { assert.deepEqual(frame, { type: 'snapshot', cursor: 42, presentation: { turns: [] } }); break }
  assert.equal(released, true)
  assert.deepEqual(f.calls[0]?.args, { request: { activate: true, assistantStream: true, address: { kind: 'session', sessionId: 's' } } })
  assert.equal(f.calls[0]?.signal?.aborted, true)
  const invalid = f.bridge.subscribe(f.peer, 'session', { sessionId: 's', afterSeq: 42 }, new AbortController().signal)
  await assert.rejects(async () => { for await (const _ of invalid) {} }, { code: 'mobile/invalid-params' })
})

test('session list baseline opens after event readiness and preserves queued list changes', async () => {
  const f = fixture()
  f.eventFrames.push({ type: 'emit', event: 'api-session/added', args: [{ sessionId: 'new' }] }, { type: 'emit', event: 'settings/document-updated', args: [] })
  const frames: unknown[] = []
  for await (const event of f.bridge.subscribe(f.peer, 'sessions', {}, new AbortController().signal)) frames.push(event)
  assert.deepEqual(frames, [{ type: 'baseline', value: { items: [] } }, { type: 'emit', event: 'api-session/added', args: [{ sessionId: 'new' }] }])
  assert.equal(f.eventClosed(), true)
})

test('interaction reply uses the exact Connection envelope and keeps its peer', async () => {
  const f = fixture()
  const result = await f.bridge.invoke(f.peer, 'interactions.reply', { operationId: 'op', clientId: 'c', eventId: 'e', outcome: { kind: 'result', value: 'rejected' } })
  assert.deepEqual(result, { accepted: true })
  assert.equal(f.fetched[0]?.url, 'http://dsh.internal/api/$events/result')
  assert.equal(f.fetched[0]?.method, 'POST')
  const envelope = f.envelopes[0] as Record<string, unknown>
  assert.equal(envelope.type, 'client-request')
  assert.equal(envelope.method, '$events/result')
  assert.deepEqual(envelope.payload, { args: { clientId: 'c', eventId: 'e', outcome: { kind: 'result', value: 'rejected' } } })
})

test('workspace list closes its first-baseline subscription', async () => {
  const f = fixture()
  let released = false
  f.setStream(async function*() { try { yield { type: 'baseline', value: { items: [{ workspaceId: 'w' }] } } } finally { released = true } })
  assert.deepEqual(await f.bridge.invoke(f.peer, 'workspaces.list', {}), { items: [{ workspaceId: 'w' }] })
  assert.equal(released, true)
})

test('feedback snapshots follow queued updates, enforce compare-and-set and close their scope', async () => {
  const f = fixture()
  let revision = 0
  f.setInvoke(request => {
    if (request.method === 'list') return { ok: true, value: { items: [{ messageId: 'm', version: `v${++revision}`, rating: 'positive' }] } }
    return { ok: false, error: { code: 'version-conflict', current: null } }
  })
  f.setStream(async function*() {
    yield { type: 'snapshot' }
    yield { type: 'event', event: { type: 'feedback/message-put', data: { sessionId: 's' } } }
  })
  const frames = []
  for await (const frame of f.bridge.subscribe(f.peer, 'feedback', { sessionId: 's' }, new AbortController().signal)) frames.push(frame)
  assert.deepEqual(frames, [1, 2].map(revision => ({ type: 'baseline', value: { items: [{ messageId: 'm', version: `v${revision}`, rating: 'positive' }] } })))
  assert.deepEqual(f.calls[0]?.args, { request: { address: { kind: 'session', sessionId: 's' }, activate: false } })
  assert.equal(f.calls[1]?.namespace, 'messageFeedback')
  assert.equal(f.calls[0]?.signal?.aborted, true)
  await assert.rejects(f.bridge.invoke(f.peer, 'feedback.put', { sessionId: 's', messageId: 'm', rating: 'positive', ifVersion: null }), { code: 'feedback/version-conflict' })
  assert.deepEqual(f.calls.at(-1)?.args, { request: { sessionId: 's', messageId: 'm', rating: 'positive', ifVersion: null } })
  await assert.rejects(f.bridge.invoke(f.peer, 'feedback.constructor', {}), { code: 'mobile/method-not-found' })
})
