import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readChanges } from '../src/bridge/HLChanges.ts'
import { HLDSHBridge } from '../src/bridge/HLDSHBridge.ts'
import type { HLDSHHostServices } from '../src/bridge/HLBridgeTypes.ts'

test('change reads use encoded Session coordinates, strip private metadata and preserve file indices', async () => {
  const requests: Request[] = []
  const files = [{ path: 'a.ts', display: 'a.ts', added: 2, deleted: 1 }]
  const fetch = async (request: Request) => {
    requests.push(request)
    return Response.json({ turn: 3, files, total: 2, added: 2, deleted: 1, cwd: '/private/work', snapshot: { before: 'private', after: 'private' } })
  }
  const signal = new AbortController().signal
  assert.deepEqual(await readChanges('changes.summary', { sessionId: 's&seq=99', seq: 4 }, fetch, signal),
    { status: 'available', summary: { turn: 3, files, total: 2, added: 2, deleted: 1 } })
  const url = new URL(requests[0]!.url)
  assert.equal(url.pathname, '/api/changes.summary'); assert.equal(url.searchParams.get('sessionId'), 's&seq=99')
  assert.equal(url.searchParams.get('seq'), '4'); assert.equal(requests[0]!.method, 'GET')
  const diff = { kind: 'text', path: 'a.ts', display: 'a.ts', before: true, after: true, coarse: false, hunks: [] }
  assert.deepEqual(await readChanges('changes.diff', { sessionId: 's', seq: 4, index: 7 }, async request => {
    assert.equal(new URL(request.url).searchParams.get('index'), '7'); return Response.json(diff)
  }, signal), { status: 'available', diff })
})

test('missing snapshots differ from empty summaries and transient errors remain retryable by the UI', async () => {
  const signal = new AbortController().signal
  const params = { sessionId: 's', seq: 1 }
  assert.deepEqual(await readChanges('changes.summary', params, async () => new Response(null, { status: 404 }), signal), { status: 'unavailable' })
  assert.deepEqual(await readChanges('changes.summary', params, async () => Response.json({ turn: 1, files: [], total: 0, added: 0, deleted: 0 }), signal),
    { status: 'available', summary: { turn: 1, files: [], total: 0, added: 0, deleted: 0 } })
  await assert.rejects(readChanges('changes.summary', params, async () => new Response(null, { status: 500 }), signal), { code: 'mobile/changes-unavailable' })
})

test('change reads reject paths and invalid coordinates and respect disconnect cancellation', async () => {
  let fetched = false
  const fetch = async () => { fetched = true; return Response.json({}) }
  const controller = new AbortController()
  for (const params of [{ sessionId: 's', seq: -1 }, { sessionId: 's', seq: 1.5 }, { sessionId: 's', seq: Number.MAX_SAFE_INTEGER + 1 },
    { sessionId: 's', seq: 1, path: '/etc/passwd' }, { sessionId: 's', seq: 1, index: 0 }]) {
    await assert.rejects(readChanges('changes.summary', params, fetch, controller.signal), { code: 'mobile/invalid-params' })
  }
  assert.equal(fetched, false)
  await assert.rejects(readChanges('changes.diff', { sessionId: 's', seq: 1, index: -1 }, fetch, controller.signal), { code: 'mobile/invalid-params' })
  await assert.rejects(readChanges('changes.summary', { sessionId: 's', seq: 1 }, async () => {
    controller.abort(); return Response.json({})
  }, controller.signal), { name: 'AbortError' })
})

test('the mobile bridge uses the authenticated owner Fetch seam and revocation aborts change reads', async () => {
  let request: Request | undefined
  let samePeer = false
  const host: HLDSHHostServices = {
    connection: {
      createPeer() { const lifetime = new AbortController(); return { signal: lifetime.signal, async dispose() { lifetime.abort() } } },
      createSharedFetchHandler(channel) { assert.equal(channel, '/api'); return { async fetch(value, scope) {
        request = value; samePeer = scope === peer.scope; return Response.json({ turn: 1, files: [], total: 0, added: 0, deleted: 0 })
      } } },
    },
    typertGateway: { async invoke() { throw new Error('Changes must not invoke an arbitrary Gateway method') }, async stream() { throw new Error('Unused') }, wireStream: { async open() { throw new Error('Unused') } } },
  }
  const bridge = new HLDSHBridge(host), peer = bridge.createPeer('authorized-phone')
  await bridge.invoke(peer, 'changes.summary', { sessionId: 's', seq: 1 })
  assert.equal(samePeer, true); assert.equal(request?.signal.aborted, false)
  await bridge.disposePeer(peer)
  assert.equal(request?.signal.aborted, true)
  await assert.rejects(bridge.invoke(peer, 'changes.diff', { sessionId: 's', seq: 1, index: 0 }), { code: 'mobile/peer-closed' })
  await bridge.dispose()
})
