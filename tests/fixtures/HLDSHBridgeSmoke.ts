/** Loaded by an isolated official DSH web profile; no provider calls or user credentials. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HLDSHBridge, type HLDSHHostServices } from '../../src/bridge/HLDSHBridge.ts'
import { HLAttachmentManager } from '../../src/attachments/HLAttachmentManager.ts'
import { paramsOf } from '../../src/bridge/HLBridgeError.ts'
import { installDeterministicProvider, type HLDeterministicHost } from './HLDeterministicProvider.ts'

export const name = 'mobile-bridge-smoke'
export const inject = ['connection', 'typertGateway', 'sessionController', 'workspaceController', 'workspaceFiles', 'fileUploads', 'llm', 'tools', 'approval']

export async function apply(host: HLDSHHostServices & HLDeterministicHost, config: { directory: string; resultPath: string; runtimeRoot: string }): Promise<void> {
  const bridge = new HLDSHBridge(host)
  const attachments = new HLAttachmentManager({ directory: join(config.directory, 'staging') }, bridge)
  const peer = bridge.createPeer('isolated-smoke-phone')
  const checks: string[] = []
  const frames: unknown[] = []
  const interactions: unknown[] = []
  try {
    await installDeterministicProvider(host, config.runtimeRoot)
    const workspacePath = join(config.directory, 'workspace')
    await mkdir(workspacePath, { recursive: true })
    await writeFile(join(workspacePath, 'hello.txt'), 'DSH Mobile real profile smoke\n')
    const created = paramsOf(await bridge.invoke(peer, 'workspaces.create', { path: workspacePath }))
    const workspace = paramsOf(created.workspace)
    checks.push('workspace.create')
    const session = paramsOf(await bridge.invoke(peer, 'sessions.create', { workspaceId: workspace.workspaceId }))
    assert.equal(typeof session.sessionId, 'string')
    const sessionId = session.sessionId as string
    checks.push('session.create')
    const list = paramsOf(await bridge.invoke(peer, 'sessions.list', {}))
    assert.ok(Array.isArray(list.items) && list.items.some(row => paramsOf(row).sessionId === sessionId))
    checks.push('session.list')
    const renamed = paramsOf(await bridge.invoke(peer, 'sessions.rename', { sessionId, title: 'Mobile smoke session' }))
    assert.equal(renamed.title, 'Mobile smoke session')
    checks.push('session.rename')
    const state = paramsOf(await bridge.invoke(peer, 'sessions.state', { sessionId }))
    assert.equal(state.running, false)
    checks.push('session.state')
    const files = paramsOf(await bridge.invoke(peer, 'files.list', { sessionId, path: '' }))
    assert.ok(Array.isArray(files.entries))
    checks.push('workspaceFiles.list')
    const file = paramsOf(await bridge.invoke(peer, 'files.read', { sessionId, path: 'hello.txt' }))
    assert.ok(JSON.stringify(file).includes('DSH Mobile real profile smoke'))
    checks.push('workspaceFiles.read')
    const download = await attachments.createDownload(peer, { sessionId, path: 'hello.txt' })
    const bytes = await attachments.readDownload(peer.deviceId, download.downloadId, 0)
    assert.equal(Buffer.from(bytes.bytes).toString(), 'DSH Mobile real profile smoke\n')
    checks.push('workspaceFiles.readBytes')
    const body = Buffer.from('mobile attachment')
    const upload = await attachments.begin(peer.deviceId, { sessionId, name: 'mobile.txt', size: body.length,
      sha256: createHash('sha256').update(body).digest('hex') })
    await attachments.writeChunk(peer.deviceId, upload.uploadId, 0, body)
    const receipt = await attachments.finalize(peer, upload.uploadId)
    assert.equal(typeof receipt.receiptId, 'string')
    checks.push('fileUploads.binaryReceipt')
    const controller = new AbortController()
    for await (const frame of bridge.subscribe(peer, 'session', { sessionId, activate: false }, controller.signal)) {
      assert.equal(paramsOf(frame).type, 'snapshot')
      break
    }
    checks.push('session.follow.snapshot')
    await bridge.invoke(peer, 'models.select', { sessionId, provider: 'mobile-fixture', model: 'mobile-fixture' })
    const turnLifetime = new AbortController()
    const turnSignal = AbortSignal.any([turnLifetime.signal, AbortSignal.timeout(12_000)])
    const turnStream = bridge.subscribe(peer, 'session', { sessionId, activate: false }, turnSignal)[Symbol.asyncIterator]()
    const opening = await turnStream.next()
    assert.equal(paramsOf(opening.value).type, 'snapshot')
    frames.push(opening.value)
    const interactionStream = bridge.subscribe(peer, 'interactions', {}, turnSignal)[Symbol.asyncIterator]()
    const ready = await interactionStream.next()
    const clientId = paramsOf(ready.value).clientId
    interactions.push(ready.value)
    const answer = (async () => {
      while (true) {
        const item = await interactionStream.next()
        if (item.done) throw new Error('Interaction stream ended before approval')
        interactions.push(item.value)
        const event = paramsOf(item.value)
        if (event.type !== 'waterfall' || event.event !== 'approval/request') continue
        await bridge.invoke(peer, 'interactions.reply', { clientId, eventId: event.eventId,
          outcome: { kind: 'result', value: 'allowed-once' } }, turnSignal)
        return
      }
    })()
    const observe = (async () => {
      while (true) {
        const item = await turnStream.next()
        if (item.done) throw new Error('Session stream ended before turn/end')
        frames.push(item.value)
        const frame = paramsOf(item.value)
        if (frame.type === 'event' && paramsOf(frame.event).type === 'turn/end') {
          const reason = paramsOf(paramsOf(paramsOf(frame.event).data).reason)
          assert.equal(reason.kind, 'completed', JSON.stringify(reason))
          return
        }
      }
    })()
    // Attach rejection observers immediately; a failed loop must not become an unhandled promise.
    void answer.catch(() => undefined); void observe.catch(() => undefined)
    try {
      const prompt = { sessionId, requestId: 'mobile-smoke-request-1', mode: 'queue', content: [{ type: 'text', text: 'Please verify the mobile round trip.' }] }
      assert.deepEqual(await bridge.invoke(peer, 'sessions.prompt', prompt), { accepted: true })
      assert.deepEqual(await bridge.invoke(peer, 'sessions.prompt', prompt), { accepted: true })
      await Promise.all([answer, observe])
      const serialized = JSON.stringify(frames)
      assert.ok(serialized.includes('Mobile round trip verified.'))
      assert.ok(serialized.includes('approval/asked') && serialized.includes('approval/decided'))
      assert.ok(serialized.includes('tool/call') && serialized.includes('tool/result'))
      assert.ok(serialized.includes('reasoning-delta') && serialized.includes('text-delta'))
      const userEvents = frames.filter(frame => {
        if (paramsOf(frame).type !== 'event') return false
        const event = paramsOf(paramsOf(frame).event)
        return event.type === 'user/message' && paramsOf(paramsOf(event.data).source).rpcId === prompt.requestId
      })
      assert.equal(userEvents.length, 1, 'same requestId must not duplicate the user message')
      checks.push('session.prompt.idempotent', 'agentLoop.reasoningAndText', 'tool.approvalAndResult', 'session.follow.realTurn')
    } finally {
      turnLifetime.abort()
      await Promise.allSettled([answer, observe, turnStream.return?.(), interactionStream.return?.()])
    }
    const lastAssistant = frames.filter(frame => paramsOf(frame).type === 'event').map(frame => paramsOf(paramsOf(frame).event)).filter(event => event.type === 'assistant/message').at(-1)
    const messageId = paramsOf(paramsOf(lastAssistant?.data).message).id
    assert.equal(typeof messageId, 'string')
    const feedbackLifetime = new AbortController()
    const feedbackStream = bridge.subscribe(peer, 'feedback', { sessionId }, feedbackLifetime.signal)[Symbol.asyncIterator]()
    assert.deepEqual((await feedbackStream.next()).value, { type: 'baseline', value: { items: [] } })
    const feedback = paramsOf(await bridge.invoke(peer, 'feedback.put' , { sessionId, messageId, rating: 'positive', ifVersion: null }))
    assert.equal(feedback.rating, 'positive')
    assert.equal(paramsOf(paramsOf((await feedbackStream.next()).value).value).items instanceof Array, true)
    const listedFeedback = paramsOf(await bridge.invoke(peer, 'feedback.list', { sessionId }))
    assert.equal((listedFeedback.items as unknown[]).length, 1)
    await assert.rejects(bridge.invoke(peer, 'feedback.put', { sessionId, messageId, rating: 'negative', ifVersion: null }), { code: 'feedback/version-conflict' })
    await bridge.invoke(peer, 'feedback.delete', { sessionId, messageId, ifVersion: feedback.version })
    assert.deepEqual(await bridge.invoke(peer, 'feedback.list', { sessionId }), { items: [] })
    feedbackLifetime.abort(); await feedbackStream.return?.()
    checks.push('messageFeedback.listPutDeleteAndConflict')
    // turn/end is committed before the loop releases its running-work lease.
    for await (const state of bridge.subscribe(peer, 'sessionState', { sessionId }, AbortSignal.timeout(5000))) {
      if (paramsOf(state).running === false) break
    }
    await bridge.invoke(peer, 'sessions.archive', { sessionId })
    await bridge.invoke(peer, 'sessions.unarchive', { sessionId })
    checks.push('workspace.archiveAndUnarchive')
    await writeFile(config.resultPath, JSON.stringify({ ok: true, checks, sessionId, frames, interactions }, null, 2))
  } catch (error) {
    await writeFile(config.resultPath, JSON.stringify({ ok: false, checks, frames, interactions, error: String(error), stack: error instanceof Error ? error.stack : undefined }, null, 2))
  } finally {
    await attachments.dispose()
    await bridge.dispose()
  }
}
