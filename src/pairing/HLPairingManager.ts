import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { HLKeyValueStore } from '../storage/HLSQLiteStore.js'
import { HLError } from '../transport/HLError.js'

export interface HLPairedDevice { id: string; name: string; platform: 'android' | 'ios'; pairedAt: number; lastSeenAt: number }
export interface HLInvitation { v: 1; endpointId: string; ticket: string; pairingId: string; secret: string; expiresAt: number; name: string }
export interface HLPendingPairing { requestId: string; pairingId: string; deviceId: string; name: string; platform: 'android' | 'ios'; createdAt: number; expiresAt: number; status: 'pending' | 'approved' | 'rejected' | 'expired' }
const hash = (secret: string) => createHash('sha256').update(secret).digest()

export class HLPairingManager {
  private invitation?: HLInvitation
  private secretHash?: Buffer
  private readonly requests = new Map<string, HLPendingPairing>()
  private readonly attempts = new Map<string, { count: number; until: number }>()
  constructor(private readonly store: HLKeyValueStore, private readonly now: () => number = Date.now, private readonly ttlMs = 300_000) {}

  create(endpointId: string, ticket: string, name: string): { invitation: HLInvitation; url: string } {
    for (const request of this.requests.values()) if (request.status === 'pending') request.status = 'expired'
    for (const [id, request] of this.requests) if (request.expiresAt + this.ttlMs < this.now()) this.requests.delete(id)
    while (this.requests.size > 100) this.requests.delete(this.requests.keys().next().value!)
    for (const [id, attempt] of this.attempts) if (attempt.until <= this.now()) this.attempts.delete(id)
    this.invitation = { v: 1, endpointId, ticket, name, pairingId: randomUUID(), secret: randomBytes(32).toString('base64url'), expiresAt: this.now() + this.ttlMs }
    this.secretHash = hash(this.invitation.secret)
    return { invitation: this.invitation, url: `dsh-mobile://pair?data=${Buffer.from(JSON.stringify(this.invitation)).toString('base64url')}` }
  }

  current(): { invitation: HLInvitation; url: string } | undefined {
    if (!this.invitation || this.invitation.expiresAt <= this.now()) return undefined
    return { invitation: this.invitation, url: `dsh-mobile://pair?data=${Buffer.from(JSON.stringify(this.invitation)).toString('base64url')}` }
  }

  request(deviceId: string, input: { pairingId: string; secret: string; name: string; platform: 'android' | 'ios' }): { status: 'pending'; requestId: string } {
    const previous = [...this.requests.values()].find(item => item.deviceId === deviceId && item.pairingId === input.pairingId && item.status === 'pending')
    const attempt = this.attempts.get(deviceId)
    if (!attempt && this.attempts.size >= 1024) {
      for (const [id, entry] of this.attempts) if (entry.until <= this.now()) this.attempts.delete(id)
      if (this.attempts.size >= 1024) throw new HLError('PAIRING_BUSY', 'Pairing is temporarily busy')
    }
    if (attempt && attempt.until > this.now() && attempt.count >= 5) throw new HLError('PAIRING_RATE_LIMITED', 'Too many pairing attempts')
    this.attempts.set(deviceId, { count: attempt && attempt.until > this.now() ? attempt.count + 1 : 1, until: this.now() + 60_000 })
    if (!this.invitation || !this.secretHash || this.invitation.expiresAt <= this.now() || input.pairingId !== this.invitation.pairingId || !timingSafeEqual(hash(input.secret), this.secretHash)) {
      throw new HLError('PAIRING_INVALID', 'Invitation is invalid or expired')
    }
    if (previous) return { status: 'pending', requestId: previous.requestId }
    if (this.pending().length >= 10) throw new HLError('PAIRING_BUSY', 'Too many pending requests')
    const name = input.name.trim()
    if (!name || name.length > 100 || !['android', 'ios'].includes(input.platform)) throw new HLError('INVALID_ARGUMENT', 'Invalid device description')
    const requestId = randomUUID()
    this.requests.set(requestId, { requestId, pairingId: input.pairingId, deviceId, name, platform: input.platform, createdAt: this.now(), expiresAt: this.invitation.expiresAt, status: 'pending' })
    return { status: 'pending', requestId }
  }

  status(deviceId: string, requestId: string): HLPendingPairing['status'] {
    const item = this.requests.get(requestId)
    if (!item || item.deviceId !== deviceId) throw new HLError('PAIRING_NOT_FOUND', 'Pairing request not found')
    if (item.status === 'pending' && item.expiresAt <= this.now()) item.status = 'expired'
    return item.status
  }

  pending(): HLPendingPairing[] {
    return [...this.requests.values()].filter(item => this.status(item.deviceId, item.requestId) === 'pending').map(item => ({ ...item }))
  }

  approve(requestId: string): HLPairedDevice {
    const item = this.requests.get(requestId)
    if (!item || this.status(item.deviceId, requestId) !== 'pending' || item.pairingId !== this.invitation?.pairingId) throw new HLError('PAIRING_EXPIRED', 'Pairing request is no longer pending')
    const device: HLPairedDevice = { id: item.deviceId, name: item.name, platform: item.platform, pairedAt: this.now(), lastSeenAt: this.now() }
    this.store.transaction(() => this.store.set(`devices/${device.id}`, device))
    item.status = 'approved'
    for (const other of this.requests.values()) if (other.status === 'pending') other.status = 'expired'
    this.invitation = undefined
    this.secretHash = undefined
    return device
  }

  reject(requestId: string): void {
    const item = this.requests.get(requestId)
    if (!item || this.status(item.deviceId, requestId) !== 'pending') throw new HLError('PAIRING_NOT_FOUND', 'Pairing request not found')
    item.status = 'rejected'
  }
  device(deviceId: string): HLPairedDevice | undefined { return this.store.get<HLPairedDevice>(`devices/${deviceId}`) }
  devices(): HLPairedDevice[] { return this.store.list<HLPairedDevice>('devices/').map(row => row.value) }
  touch(deviceId: string): void { const device = this.device(deviceId); if (device) this.store.set(`devices/${deviceId}`, { ...device, lastSeenAt: this.now() }) }
  revoke(deviceId: string): void { this.store.delete(`devices/${deviceId}`) }
}
