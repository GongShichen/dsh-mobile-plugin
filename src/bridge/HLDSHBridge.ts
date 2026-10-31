import { randomUUID } from 'node:crypto'
import { HLBridgeError, paramsOf, record, textField } from './HLBridgeError.ts'
import type { HLDSHHostServices, HLPeer, HLParams, HLPeerScope, HLSharedFetch } from './HLBridgeTypes.ts'
import { HLPresentationTracker } from '../sync/HLPresentationTracker.js'
import { firstFrame, sessionListStream } from '../sync/HLStreams.ts'
import { HLInteractionChannel, validateQuestionAnswer } from '../sync/HLInteractionChannel.ts'
import { readChanges } from './HLChanges.ts'

export type { HLDSHHostServices, HLPeer, HLPeerScope, HLParams } from './HLBridgeTypes.ts'
export { HLBridgeError } from './HLBridgeError.ts'

const SESSION_METHODS = new Set(['list', 'search', 'create', 'rename', 'fork', 'prompt', 'cancel', 'updateQueue', 'events', 'state', 'projections'])
const ARCHIVE_METHODS: Readonly<Record<string, string>> = {
  archive: 'archiveSession', unarchive: 'unarchiveSession', pin: 'pinSession', unpin: 'unpinSession',
}
const emptyUplink = { async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {} }

/** Fixed mobile vocabulary over the pinned Gateway; caller authorization belongs to transport. */
export class HLDSHBridge<S extends HLPeerScope = HLPeerScope> {
  private readonly peers = new Set<HLPeer<S>>()
  private readonly interactionChannels = new Map<HLPeer<S>, HLInteractionChannel>()
  private readonly presentations = new Map<HLPeer<S>, Map<string, HLPresentationTracker>>()
  private presentation(peer: HLPeer<S>, sessionId: string): HLPresentationTracker {
    let sessions = this.presentations.get(peer)
    if (!sessions) { sessions = new Map(); this.presentations.set(peer, sessions) }
    let tracker = sessions.get(sessionId)
    if (!tracker) { if (sessions.size >= 8) sessions.delete(sessions.keys().next().value!); tracker = new HLPresentationTracker(); sessions.set(sessionId, tracker) }
    return tracker
  }
  private readonly sharedFetch: HLSharedFetch<S>

  constructor(private readonly host: HLDSHHostServices<S>) {
    this.sharedFetch = host.connection.createSharedFetchHandler('/api')
  }

  createPeer(deviceId: string): HLPeer<S> {
    textField(deviceId, 'deviceId')
    const peer = Object.freeze({ deviceId, scope: this.host.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' }) })
    this.peers.add(peer)
    return peer
  }

  async disposePeer(peer: HLPeer<S>): Promise<void> {
    this.peers.delete(peer)
    this.presentations.delete(peer)
    await this.interactionChannels.get(peer)?.close()
    this.interactionChannels.delete(peer)
    await peer.scope.dispose()
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.peers].map(peer => this.disposePeer(peer)))
  }

  private signal(peer: HLPeer<S>, signal?: AbortSignal): AbortSignal {
    if (!this.peers.has(peer)) throw new HLBridgeError('mobile/peer-closed', 'Device connection is closed')
    peer.scope.signal.throwIfAborted()
    return signal === undefined ? peer.scope.signal : AbortSignal.any([peer.scope.signal, signal])
  }

  private call(peer: HLPeer<S>, namespace: string, method: string, args: HLParams, signal?: AbortSignal): Promise<unknown> {
    return this.host.typertGateway.invoke({ namespace, method, args, peer: peer.scope, signal: this.signal(peer, signal) })
  }

  private stream(peer: HLPeer<S>, namespace: string, method: string, args: HLParams, signal: AbortSignal): Promise<AsyncIterable<unknown>> {
    return this.host.typertGateway.stream({ namespace, method, args, peer: peer.scope, signal: this.signal(peer, signal) })
  }

  /** Preserve named Gateway arguments while removing only adapter operation metadata. */
  async invoke(peer: HLPeer<S>, method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    this.signal(peer, signal).throwIfAborted()
    const { operationId: _operationId, ...request } = paramsOf(params)
    const [domain, action, extra] = method.split('.')
    if (extra !== undefined) throw new HLBridgeError('mobile/method-not-found', 'Unknown mobile method')
    if (method === 'changes.summary' || method === 'changes.diff') {
      return readChanges(method, request, request => this.fetch(peer, request), this.signal(peer, signal))
    }
    if (domain === 'sessions' && action !== undefined) {
      if (SESSION_METHODS.has(action)) {
        if (action === 'prompt') textField(request.requestId, 'requestId')
        // `_request` is the actual named parameter of session/list in the pinned build.
        const value = await this.call(peer, 'session', action, { [action === 'list' ? '_request' : 'request']: request }, signal)
        const historyId = typeof request.sessionId === 'string' ? request.sessionId : record(request.address) && typeof request.address.sessionId === 'string' ? request.address.sessionId : undefined
        if (action === 'events' && historyId !== undefined && record(value)) {
          const tracker = this.presentation(peer, historyId); tracker.ingest(value.records)
          return { ...value, presentation: tracker.snapshot() }
        }
        return value
      }
      const workspaceMethod = Object.hasOwn(ARCHIVE_METHODS, action) ? ARCHIVE_METHODS[action] : undefined
      if (workspaceMethod !== undefined) return this.call(peer, 'workspace', workspaceMethod, { request }, signal)
    }
    if (domain === 'feedback' && action !== undefined && ['list', 'put', 'delete'].includes(action)) {
      const result = await this.call(peer, 'messageFeedback', action, { request }, signal)
      if (!record(result) || result.ok !== true) {
        const error = record(result) && record(result.error) ? result.error : {}
        const code = typeof error.code === 'string' ? error.code : 'unavailable'
        throw new HLBridgeError(`feedback/${code}`, code === 'version-conflict' ? '评价已在另一端更新，请重试' : `无法更新评价：${code}`)
      }
      return result.value
    }
    if (method === 'workspaces.list') {
      const controller = new AbortController()
      const lifetime = AbortSignal.any([this.signal(peer, signal), controller.signal])
      try {
        const frame = await firstFrame(await this.stream(peer, 'workspace', 'follow', {}, lifetime))
        if (!record(frame) || frame.type !== 'baseline') throw new HLBridgeError('mobile/missing-baseline', 'Invalid workspace baseline')
        return frame.value
      } finally { controller.abort() }
    }
    if (method === 'workspaces.create' || method === 'workspaces.rename') return this.call(peer, 'workspace', action!, { request }, signal)
    if (method === 'models.list') return this.call(peer, 'session', 'modelCatalog', {}, signal)
    if (method === 'models.select') return this.call(peer, 'session', 'selectModel', { request }, signal)
    if (method === 'files.list' || method === 'files.stat' || method === 'files.read') {
      return this.call(peer, 'workspaceFiles', action!, this.fileArgs(request, method === 'files.read' ? { range: request.range ?? {} } : {}), signal)
    }
    if (method === 'jobs.kill') return this.call(peer, 'job', 'kill', { request }, signal)
    if (method === 'jobs.list') {
      const controller = new AbortController()
      try { return await firstFrame(await this.stream(peer, 'job', 'list', { request }, AbortSignal.any([this.signal(peer, signal), controller.signal]))) }
      finally { controller.abort() }
    }
    if (method === 'questions.answer') {
      const sessionId = textField(request.agentId ?? request.sessionId, 'sessionId')
      const callId = textField(request.callId, 'callId')
      const snapshot = await this.call(peer, 'session', 'projections', { request: { sessionId } }, signal)
      const values = record(snapshot) && record(snapshot.values) ? snapshot.values : undefined
      const questions = values && record(values.userQuestions) ? values.userQuestions : undefined
      const pending = questions && Array.isArray(questions.active) ? questions.active.find(q => record(q) && q.callId === callId && q.state === 'continued') : undefined
      if (!record(pending)) return false
      validateQuestionAnswer(pending.questions, request.answer)
      // A stored continued question can outlive its live Agent. Retain an official activation
      // lease while answering; this does not switch the phone's currently selected conversation.
      const activation = new AbortController()
      const lifetime = AbortSignal.any([this.signal(peer, signal), activation.signal])
      const stream = await this.stream(peer, 'session', 'follow', { request: { address: { kind: 'session', sessionId }, activate: true, maxMessages: 1 } }, lifetime)
      const iterator = stream[Symbol.asyncIterator]()
      try {
        const opening = await iterator.next()
        if (opening.done || !record(opening.value) || opening.value.type !== 'snapshot') throw new HLBridgeError('mobile/question-not-ready', '询问所属会话尚未就绪')
        return await this.call(peer, 'userQuestions', 'answer', { agentId: sessionId, callId, answer: request.answer }, lifetime)
      } catch (error) {
        if (record(error) && error.code === 'REPLY_QUEUED') return false
        throw error
      } finally { activation.abort(); try { await iterator.return?.() } catch { /* Cancellation already released the lease. */ } }
    }
    if (method === 'interactions.reply') return this.interactionChannels.get(peer)?.reply(request, this.signal(peer, signal)) ?? { accepted: false }
    throw new HLBridgeError('mobile/method-not-found', `Unsupported mobile method: ${method}`)
  }

  private fileArgs(request: HLParams, extra: HLParams = {}): HLParams {
    const { sessionId, workspaceFileScopeId, path } = request
    return { workspaceFileScopeId: textField(workspaceFileScopeId ?? sessionId, 'sessionId'), path: typeof path === 'string' && path.length > 0 ? path : '.', ...extra }
  }

  /** Raw bytes stay internal; AttachmentManager turns them into a device-owned download handle. */
  readDownload(peer: HLPeer<S>, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const request = paramsOf(params)
    return this.call(peer, 'workspaceFiles', 'readBytes', this.fileArgs(request, { options: request.options ?? {} }), signal)
  }

  /** Use the authenticated in-process Fetch seam, never a public listener or startup token. */
  fetch(peer: HLPeer<S>, request: Request): Promise<Response> {
    const signal = this.signal(peer, request.signal)
    signal.throwIfAborted()
    return this.sharedFetch.fetch(new Request(request, { signal }), peer.scope)
  }

  private async postInteractionResult(peer: HLPeer<S>, result: HLParams, signal?: AbortSignal): Promise<void> {
    const rpcId = randomUUID()
    const response = await this.fetch(peer, new Request('http://dsh.internal/api/$events/result', {
      method: 'POST', signal: this.signal(peer, signal), headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: '$events/result', payload: { args: result } }),
    }))
    const envelope: unknown = await response.json()
    if (!response.ok || !record(envelope) || envelope.rpcId !== rpcId || !record(envelope.result)) {
      throw new HLBridgeError('mobile/upstream-response', 'DSH returned an invalid interaction response')
    }
    if (envelope.result.ok !== true) {
      const error = paramsOf(envelope.result.error)
      throw new HLBridgeError(typeof error.code === 'string' ? error.code : 'mobile/upstream-error', typeof error.message === 'string' ? error.message : 'Interaction reply failed')
    }
  }

  private interactionChannel(peer: HLPeer<S>): HLInteractionChannel {
    let channel = this.interactionChannels.get(peer)
    if (!channel) {
      channel = new HLInteractionChannel(
        signal => this.host.typertGateway.wireStream.open('$events', { args: {} }, emptyUplink, peer.scope, this.signal(peer, signal)),
        (result, signal) => this.postInteractionResult(peer, result, signal), peer.scope.signal,
      )
      this.interactionChannels.set(peer, channel)
    }
    return channel
  }

  /** Each subscription owns its upstream lifetime; no afterSeq is invented for session/follow. */
  async *subscribe(peer: HLPeer<S>, topic: string, params: unknown, signal: AbortSignal): AsyncIterable<unknown> {
    const controller = new AbortController()
    const lifetime = AbortSignal.any([this.signal(peer, signal), controller.signal])
    const request = paramsOf(params)
    try {
      switch (topic) {
        case 'sessions':
          yield* sessionListStream(this.interactionChannel(peer).subscribe(false, lifetime), () => this.invoke(peer, 'sessions.list', {}, lifetime), lifetime)
          break
        case 'interactions':
          yield* this.interactionChannel(peer).subscribe(true, lifetime)
          break
        case 'questionWait': {
          const frame = this.interactionChannels.get(peer)?.request(request.clientId, request.eventId)
          const body = frame && record(frame.request) ? frame.request : undefined
          const wait = body && record(body.wait) ? body.wait : undefined
          if (frame?.event === 'user-questions/request' && wait?.timed === true && typeof wait.callId === 'string') {
            for await (const value of await this.stream(peer, 'userQuestions', 'attachWait', { agentId: frame.agentId, callId: wait.callId }, lifetime)) {
              if (record(value)) yield { type: 'waiting', eventId: request.eventId, remainingMs: value.remainingMs }
            }
          }
          yield { type: 'ended', eventId: request.eventId }
          break
        }
        case 'session': {
          if ('afterSeq' in request || 'resumeCursor' in request) throw new HLBridgeError('mobile/invalid-params', 'session/follow does not accept an afterSeq or resumeCursor')
          const { sessionId, ...fields } = request
          const address = fields.address ?? { kind: 'session', sessionId: textField(sessionId, 'sessionId') }
          const id = record(address) && typeof address.sessionId === 'string' ? address.sessionId : typeof sessionId === 'string' ? sessionId : undefined
          const tracker = id === undefined ? undefined : this.presentation(peer, id)
          for await (const frame of await this.stream(peer, 'session', 'follow', { request: { activate: true, assistantStream: true, ...fields, address } }, lifetime)) {
            if (tracker && record(frame) && frame.type === 'snapshot') {
              tracker.baseline(frame); yield { ...frame, presentation: tracker.snapshot() }
            } else if (tracker && record(frame) && frame.type === 'event') {
              tracker.append(frame.event)
              yield record(frame.event) && frame.event.type === 'turn/end' ? { ...frame, presentation: tracker.snapshot() } : frame
            } else yield frame
          }
          break
        }
        case 'feedback': {
          const sessionId = textField(request.sessionId, 'sessionId')
          // Subscribe first. A queued mutation triggers another authoritative read instead of
          // replaying an older patch over a more recent list response.
          const source = await this.stream(peer, 'session', 'follow', { request: {
            address: { kind: 'session', sessionId }, activate: false,
          } }, lifetime)
          for await (const frame of source) {
            if (!record(frame)) continue
            const event = record(frame.event) ? frame.event : undefined
            if (frame.type === 'snapshot' || (frame.type === 'event' && typeof event?.type === 'string' && event.type.startsWith('feedback/message-'))) {
              yield { type: 'baseline', value: await this.invoke(peer, 'feedback.list', { sessionId }, lifetime) }
            }
          }
          break
        }
        case 'sessionState': yield* await this.stream(peer, 'session', 'observeState', { request }, lifetime); break
        case 'sessionControl': yield* await this.stream(peer, 'session', 'control', {}, lifetime); break
        case 'workspaces': yield* await this.stream(peer, 'workspace', 'follow', {}, lifetime); break
        case 'jobs': yield* await this.stream(peer, 'job', 'list', { request }, lifetime); break
        case 'job': yield* await this.stream(peer, 'job', 'follow', { request }, lifetime); break
        case 'files': yield* await this.stream(peer, 'workspaceFiles', 'changes', this.fileArgs(request), lifetime); break
        default: throw new HLBridgeError('mobile/topic-not-found', `Unsupported topic: ${topic}`)
      }
    } finally { controller.abort() }
  }
}
