/** The documented DSH Host seams used by the mobile adapter; no runtime package imports. */
export interface PeerScope {
  readonly signal: AbortSignal
  dispose(): Promise<void>
}

export interface MobilePeer<S extends PeerScope = PeerScope> {
  readonly deviceId: string
  readonly scope: S
}

export interface GatewayRequest<S extends PeerScope> {
  readonly namespace: string
  readonly method: string
  readonly args: Readonly<Record<string, unknown>>
  readonly peer: S
  readonly signal?: AbortSignal
}

export interface SharedFetch<S extends PeerScope> {
  fetch(request: Request, peer: S): Promise<Response>
}

export interface DshHostServices<S extends PeerScope = PeerScope> {
  readonly connection: {
    createPeer(options: { principal: { kind: 'owner' }; interactions: 'answer' }): S
    createSharedFetchHandler(channel: '/api'): SharedFetch<S>
  }
  readonly typertGateway: {
    invoke(request: GatewayRequest<S>): Promise<unknown>
    stream(request: GatewayRequest<S>): Promise<AsyncIterable<unknown>>
    readonly wireStream: {
      open(endpoint: string, payload: unknown, uplink: AsyncIterable<unknown>, peer: S, signal: AbortSignal): Promise<AsyncIterable<unknown>>
    }
  }
}

export type Params = Readonly<Record<string, unknown>>
