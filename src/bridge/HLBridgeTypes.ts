/** The documented DSH Host seams used by the mobile adapter; no runtime package imports. */
export interface HLPeerScope {
  readonly signal: AbortSignal
  dispose(): Promise<void>
}

export interface HLPeer<S extends HLPeerScope = HLPeerScope> {
  readonly deviceId: string
  readonly scope: S
}

export interface HLGatewayRequest<S extends HLPeerScope> {
  readonly namespace: string
  readonly method: string
  readonly args: Readonly<Record<string, unknown>>
  readonly peer: S
  readonly signal?: AbortSignal
}

export interface HLSharedFetch<S extends HLPeerScope> {
  fetch(request: Request, peer: S): Promise<Response>
}

export interface HLDSHHostServices<S extends HLPeerScope = HLPeerScope> {
  readonly connection: {
    createPeer(options: { principal: { kind: 'owner' }; interactions: 'answer' | 'none' }): S
    createSharedFetchHandler(channel: '/api'): HLSharedFetch<S>
  }
  readonly typertGateway: {
    invoke(request: HLGatewayRequest<S>): Promise<unknown>
    stream(request: HLGatewayRequest<S>): Promise<AsyncIterable<unknown>>
    readonly wireStream: {
      open(endpoint: string, payload: unknown, uplink: AsyncIterable<unknown>, peer: S, signal: AbortSignal): Promise<AsyncIterable<unknown>>
    }
  }
}

export type HLParams = Readonly<Record<string, unknown>>
