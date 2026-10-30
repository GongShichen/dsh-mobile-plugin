import { randomUUID } from 'node:crypto'
import { BridgeError, paramsOf, record, textField } from './errors.ts'
import type { DshHostServices, MobilePeer, Params, PeerScope, SharedFetch } from './types.ts'
import { firstFrame, sessionListStream } from '../sync/streams.ts'

export type { DshHostServices, MobilePeer, PeerScope, Params } from './types.ts'
export { BridgeError } from './errors.ts'

const SESSION_METHODS = new Set(['list', 'search', 'create', 'rename', 'fork', 'prompt', 'cancel', 'updateQueue', 'events', 'state', 'projections'])
const ARCHIVE_METHODS: Readonly<Record<string, string>> = {
  archive: 'archiveSession', unarchive: 'unarchiveSession', pin: 'pinSession', unpin: 'unpinSession',
}
const emptyUplink = { async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {} }

/** Fixed mobile vocabulary over the pinned Gateway; caller authorization belongs to transport. */
export class DshBridge<S extends PeerScope = PeerScope> {
  private readonly peers = new Set<MobilePeer<S>>()
  private readonly sharedFetch: SharedFetch<S>

  constructor(private readonly host: DshHostServices<S>) {
    this.sharedFetch = host.connection.createSharedFetchHandler('/api')
  }

  createPeer(deviceId: string): MobilePeer<S> {
    textField(deviceId, 'deviceId')
    const peer = Object.freeze({ deviceId, scope: this.host.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' }) })
    this.peers.add(peer)
    return peer
  }

  async disposePeer(peer: MobilePeer<S>): Promise<void> {
    this.peers.delete(peer)
    await peer.scope.dispose()
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.peers].map(peer => this.disposePeer(peer)))
  }

  private signal(peer: MobilePeer<S>, signal?: AbortSignal): AbortSignal {
    if (!this.peers.has(peer)) throw new BridgeError('mobile/peer-closed', 'Device connection is closed')
    peer.scope.signal.throwIfAborted()
    return signal === undefined ? peer.scope.signal : AbortSignal.any([peer.scope.signal, signal])
  }

  private call(peer: MobilePeer<S>, namespace: string, method: string, args: Params, signal?: AbortSignal): Promise<unknown> {
    return this.host.typertGateway.invoke({ namespace, method, args, peer: peer.scope, signal: this.signal(peer, signal) })
  }

  private stream(peer: MobilePeer<S>, namespace: string, method: string, args: Params, signal: AbortSignal): Promise<AsyncIterable<unknown>> {
    return this.host.typertGateway.stream({ namespace, method, args, peer: peer.scope, signal: this.signal(peer, signal) })
  }

  /** Preserve named Gateway arguments while removing only adapter operation metadata. */
  async invoke(peer: MobilePeer<S>, method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    this.signal(peer, signal).throwIfAborted()
    const { operationId: _operationId, ...request } = paramsOf(params)
    const [domain, action, extra] = method.split('.')
    if (extra !== undefined) throw new BridgeError('mobile/method-not-found', 'Unknown mobile method')
    if (domain === 'sessions' && action !== undefined) {
      if (SESSION_METHODS.has(action)) {
        if (action === 'prompt') textField(request.requestId, 'requestId')
        // `_request` is the actual named parameter of session/list in the pinned build.
        return this.call(peer, 'session', action, { [action === 'list' ? '_request' : 'request']: request }, signal)
      }
      const workspaceMethod = Object.hasOwn(ARCHIVE_METHODS, action) ? ARCHIVE_METHODS[action] : undefined
      if (workspaceMethod !== undefined) return this.call(peer, 'workspace', workspaceMethod, { request }, signal)
    }
    if (method === 'workspaces.list') {
      const controller = new AbortController()
      const lifetime = AbortSignal.any([this.signal(peer, signal), controller.signal])
      try {
        const frame = await firstFrame(await this.stream(peer, 'workspace', 'follow', {}, lifetime))
        if (!record(frame) || frame.type !== 'baseline') throw new BridgeError('mobile/missing-baseline', 'Invalid workspace baseline')
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
      const { sessionId, agentId, ...args } = request
      return this.call(peer, 'userQuestions', 'answer', { ...args, agentId: agentId ?? sessionId }, signal)
    }
    if (method === 'interactions.reply') return this.reply(peer, request, signal)
    throw new BridgeError('mobile/method-not-found', `Unsupported mobile method: ${method}`)
  }

  private fileArgs(request: Params, extra: Params = {}): Params {
    const { sessionId, workspaceFileScopeId, path } = request
    return { workspaceFileScopeId: textField(workspaceFileScopeId ?? sessionId, 'sessionId'), path: typeof path === 'string' && path.length > 0 ? path : '.', ...extra }
  }

  /** Raw bytes stay internal; AttachmentManager turns them into a device-owned download handle. */
  readDownload(peer: MobilePeer<S>, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const request = paramsOf(params)
    return this.call(peer, 'workspaceFiles', 'readBytes', this.fileArgs(request, { options: request.options ?? {} }), signal)
  }

  /** Use the authenticated in-process Fetch seam, never a public listener or startup token. */
  fetch(peer: MobilePeer<S>, request: Request): Promise<Response> {
    const signal = this.signal(peer, request.signal)
    signal.throwIfAborted()
    return this.sharedFetch.fetch(new Request(request, { signal }), peer.scope)
  }

  private async reply(peer: MobilePeer<S>, result: Params, signal?: AbortSignal): Promise<unknown> {
    const rpcId = randomUUID()
    const response = await this.fetch(peer, new Request('http://dsh.internal/api/$events/result', {
      method: 'POST', signal: this.signal(peer, signal), headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: '$events/result', payload: { args: result } }),
    }))
    const envelope: unknown = await response.json()
    if (!response.ok || !record(envelope) || envelope.rpcId !== rpcId || !record(envelope.result)) {
      throw new BridgeError('mobile/upstream-response', 'DSH returned an invalid interaction response')
    }
    if (envelope.result.ok !== true) {
      const error = paramsOf(envelope.result.error)
      throw new BridgeError(typeof error.code === 'string' ? error.code : 'mobile/upstream-error', typeof error.message === 'string' ? error.message : 'Interaction reply failed')
    }
    return { accepted: true }
  }

  private events(peer: MobilePeer<S>, signal: AbortSignal): Promise<AsyncIterable<unknown>> {
    return this.host.typertGateway.wireStream.open('$events', { args: {} }, emptyUplink, peer.scope, this.signal(peer, signal))
  }

  /** Each subscription owns its upstream lifetime; no afterSeq is invented for session/follow. */
  async *subscribe(peer: MobilePeer<S>, topic: string, params: unknown, signal: AbortSignal): AsyncIterable<unknown> {
    const controller = new AbortController()
    const lifetime = AbortSignal.any([this.signal(peer, signal), controller.signal])
    const request = paramsOf(params)
    try {
      switch (topic) {
        case 'sessions':
          yield* sessionListStream(await this.events(peer, lifetime), () => this.invoke(peer, 'sessions.list', {}, lifetime), lifetime)
          break
        case 'interactions':
          for await (const event of await this.events(peer, lifetime)) {
            if (record(event) && (event.type === 'ready' || event.type === 'waterfall' || event.type === 'cancel')) yield event
          }
          break
        case 'session': {
          if ('afterSeq' in request || 'resumeCursor' in request) throw new BridgeError('mobile/invalid-params', 'session/follow does not accept an afterSeq or resumeCursor')
          const { sessionId, ...fields } = request
          const address = fields.address ?? { kind: 'session', sessionId: textField(sessionId, 'sessionId') }
          yield* await this.stream(peer, 'session', 'follow', { request: { activate: true, assistantStream: true, ...fields, address } }, lifetime)
          break
        }
        case 'sessionState': yield* await this.stream(peer, 'session', 'observeState', { request }, lifetime); break
        case 'sessionControl': yield* await this.stream(peer, 'session', 'control', {}, lifetime); break
        case 'workspaces': yield* await this.stream(peer, 'workspace', 'follow', {}, lifetime); break
        case 'jobs': yield* await this.stream(peer, 'job', 'list', { request }, lifetime); break
        case 'job': yield* await this.stream(peer, 'job', 'follow', { request }, lifetime); break
        case 'files': yield* await this.stream(peer, 'workspaceFiles', 'changes', this.fileArgs(request), lifetime); break
        default: throw new BridgeError('mobile/topic-not-found', `Unsupported topic: ${topic}`)
      }
    } finally { controller.abort() }
  }
}
