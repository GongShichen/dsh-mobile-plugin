/** Public, owner-only desktop management contract. No provider credentials belong here. */
export interface NotificationStatus {
  configured: { apns: boolean; fcm: boolean }
  apps?: Array<{ deviceId: string; platform: string; applicationId: string; teamId?: string; environment?: string }>
  setup?: Array<{ provider: string; expiresAt: number; waitingForDevice: boolean }>
  tokens: Array<{ deviceId: string; provider: string; updatedAt: number; enabled: boolean }>
  outbox: Array<{ id: string; deviceId: string; kind: string; state: string; attempts: number; updatedAt: number; error?: string }>
}
export interface MobileAccessStatus {
  hostName: string
  endpointId: string
  invitation?: { uri: string; expiresAt: number }
  devices: Array<{ deviceId: string; name: string; platform: string; revokedAt?: number; lastSeenAt?: number }>
  pending: Array<{ requestId: string; deviceId: string; name: string; platform: string; expiresAt?: number }>
  connections: Array<{ deviceId: string; path?: string; connectedAt?: number }>
  notifications: NotificationStatus
}
export type OwnerCall = <T>(method: string, params?: unknown, signal?: AbortSignal) => Promise<T>

/** Keep the Connection envelope explicit, as the official carrier returns it unchanged. */
export function createOwnerCall(rpc: { call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> }): OwnerCall {
  return async <T>(method: string, params: unknown = {}, signal?: AbortSignal): Promise<T> => {
    const response = await rpc.call('/api', `mobileAccess/${method}`, params, signal) as {
      ok: boolean; value?: T; error?: { code?: string; message?: string }
    }
    if (!response || response.ok !== true) {
      // Server errors are sanitized by the owner boundary; never render submitted import contents.
      throw new Error(response?.error?.message || '移动访问请求失败')
    }
    return response.value as T
  }
}
