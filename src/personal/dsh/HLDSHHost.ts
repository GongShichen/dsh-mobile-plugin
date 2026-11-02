import type { HLDSHHostServices } from '../../bridge/HLBridgeTypes.js'

/** Structural excerpts of the pinned public services; runtime implementations remain Host-owned. */
export interface HLDSHAgent {
  id: string
  session: { id: string; header: { cwd?: string } }
  inbox: { nextTurn: Array<{ id: string; source: Record<string, unknown> }>; nextStep: Array<{ id: string; source: Record<string, unknown> }> }
  model: { current(): { provider: string; model: string; reasoningEffort?: string } | undefined; select(value: { provider: string; model: string; reasoningEffort?: string }): void }
  followup(message: unknown): void
}
export interface HLDSHOptionalServices {
  /** Published alpha.2 reminders predate the baseline's Remote create/edit surface. */
  schedule: {
    remoteCreate?: unknown
    create(sessionId: string, request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
    catalog(): Promise<Array<{ id: string; sessionId: string }>>
    history(request: { id: string; sessionId: string; limit: number }): Promise<unknown>
    delete(request: { id: string; sessionId: string }, signal?: AbortSignal): Promise<unknown>
  }
  llm: { resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<unknown>; resolveCallConfig(selection: { provider: string; model: string; reasoningEffort?: string }): Promise<unknown> }
  attachments: {
    readFileStream(ref: unknown, signal?: AbortSignal): AsyncIterable<Uint8Array>
    readImage(ref: unknown, signal?: AbortSignal): Promise<unknown>
    fileHostPath(ref: unknown): string | undefined
    imageHostPath(ref: unknown): string | undefined
  }
}
export interface HLPersonalDSHHost extends HLDSHHostServices {
  get?<K extends keyof HLDSHOptionalServices>(name: K): HLDSHOptionalServices[K] | undefined
  agents: { get(id: string): HLDSHAgent | undefined }
  sessions: { flush(session: HLDSHAgent['session']): Promise<boolean> }
  sessionQuery: { readSession(id: string): Promise<{ events: Array<{ type: string; seq: number; data: Record<string, unknown> }> }> }
  agentPresets: {
    register(definition: { id: string; name: string; description: string; order: number; plugins: Array<{ name: string; config?: Record<string, unknown> }> }): Promise<() => Promise<void>>
    resolve(id: string): Promise<unknown>
  }
  tools: { register(definition: unknown, options?: { when(context: { agent: { id: string } }): boolean }): () => void }
  systemPrompt: { context(provider: { name: string; order: number; interpolate: false; text(context: { agent?: { id: string } }): string }): () => void }
}
