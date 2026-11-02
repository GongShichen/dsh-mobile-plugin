import { OAuth2Client } from 'google-auth-library'
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import type { HLSecretStore } from '../../../storage/HLSecretStore.js'
import type { HLPersonalPersistence } from '../../ports/HLPersonalPersistence.js'
import { HLPersonalError } from '../../core/HLPersonalValidation.js'
import { HL_GOOGLE_CLIENT_KEY, hlParseGoogleClientJson, hlSerializeGoogleClient, type HLGoogleClientConfiguration } from './HLGoogleClient.js'
export type { HLGoogleClientConfiguration } from './HLGoogleClient.js'

export const HL_GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events.owned',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send']
interface HLStoredGoogleTokens { refresh_token?: string; access_token?: string; expiry_date?: number; scope?: string; token_type?: string }
export interface HLGoogleOAuthOptions {
  configuration: HLGoogleClientConfiguration; secrets: HLSecretStore; store: HLPersonalPersistence
  changed(): void; now?: () => number; fetch?: typeof fetch; openBrowser?: (url: string) => void
}

/** Each Host profile owns its optional Desktop OAuth client and account tokens in Keychain. */
export class HLGoogleOAuth {
  private configuration: HLGoogleClientConfiguration
  private initializing?: Promise<void>
  private configurationWork?: Promise<{ configured: boolean }>
  private starting?: Promise<{ url: string; expiresAt: number }>
  private readonly now: () => number
  private readonly fetcher: typeof fetch
  private pending?: { server: Server; url: string; expiresAt: number; timer: ReturnType<typeof setTimeout> }
  private readonly tokenJobs = new Map<string, Promise<string>>()
  private readonly requests = new Set<AbortController>()
  private readonly authJobs = new Set<Promise<void>>()
  private closing = false
  constructor(private readonly options: HLGoogleOAuthOptions) {
    this.configuration = { ...options.configuration }
    this.now = options.now ?? Date.now; this.fetcher = options.fetch ?? fetch
  }
  get configured(): boolean { return typeof this.configuration.clientId === 'string' && this.configuration.clientId.endsWith('.apps.googleusercontent.com') }
  initialize(): Promise<void> {
    if (!this.initializing) this.initializing = (async () => {
      try {
        const saved = await this.options.secrets.get(HL_GOOGLE_CLIENT_KEY)
        if (saved) this.configuration = hlParseGoogleClientJson(saved)
      } catch { /* An unavailable optional credential must not prevent non-Google work. */ }
      if (!this.closing) this.options.changed()
    })()
    return this.initializing
  }
  async importClient(value: unknown): Promise<{ configured: boolean }> {
    const configuration = hlParseGoogleClientJson(value)
    await this.initialize()
    return this.changeClient(configuration)
  }
  async clearClient(): Promise<{ configured: boolean }> {
    await this.initialize()
    return this.changeClient(undefined)
  }
  private async changeClient(configuration: Required<HLGoogleClientConfiguration> | undefined): Promise<{ configured: boolean }> {
    if (this.closing) throw new HLPersonalError('PERSONAL_STOPPING', 'Google 连接正在关闭')
    if (this.configurationWork || this.starting || this.authJobs.size || this.tokenJobs.size || this.requests.size) throw new HLPersonalError('PERSONAL_GOOGLE_BUSY', 'Google 连接正在处理请求，请稍后再更改配置。')
    if (this.options.store.list('connection').some(row => row.provider === 'google' && row.state !== 'disconnected')) throw new HLPersonalError('PERSONAL_GOOGLE_CLIENT_IN_USE', '请先断开已连接的 Google 账户，再更换或移除 OAuth 配置。')
    this.endPending()
    this.configurationWork = (async () => {
      try {
        if (configuration) await this.options.secrets.set(HL_GOOGLE_CLIENT_KEY, hlSerializeGoogleClient(configuration))
        else if (await this.options.secrets.get(HL_GOOGLE_CLIENT_KEY) !== undefined) await this.options.secrets.delete(HL_GOOGLE_CLIENT_KEY)
      } catch { throw new HLPersonalError('PERSONAL_GOOGLE_CLIENT_SAVE', '无法保存到本机钥匙串，请检查 macOS 钥匙串访问权限后重试。') }
      this.configuration = configuration ?? {}
      if (!this.closing) this.options.changed()
      return { configured: this.configured }
    })()
    try { return await this.configurationWork } finally { this.configurationWork = undefined }
  }
  async begin(): Promise<{ url: string; expiresAt: number }> {
    await this.initialize()
    if (this.closing) throw new HLPersonalError('PERSONAL_STOPPING', '账户连接正在关闭')
    if (this.configurationWork) throw new HLPersonalError('PERSONAL_GOOGLE_BUSY', '正在保存 Google 配置，请稍后再登录。')
    if (!this.configured) throw new HLPersonalError('PERSONAL_GOOGLE_NOT_CONFIGURED', '如需 Google 能力，请先在电脑的私人助理“账户”页导入自己的桌面应用 OAuth JSON；其他能力可继续使用。')
    if (this.pending && this.pending.expiresAt > this.now()) return { url: this.pending.url, expiresAt: this.pending.expiresAt }
    if (this.starting) return this.starting
    this.endPending()
    this.starting = this.start()
    try { return await this.starting } finally { this.starting = undefined }
  }
  private async start(): Promise<{ url: string; expiresAt: number }> {
    const configuration = { ...this.configuration }
    const state = randomBytes(32).toString('base64url')
    const client = new OAuth2Client(configuration.clientId, configuration.clientSecret)
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync()
    let redirect = ''
    let accepting = true
    const server = createServer((request, response) => {
      const fail = () => { response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); response.end('授权回调无效，请返回 Harness Link 重试。') }
      let url: URL
      try { url = new URL(request.url ?? '/', redirect) } catch { fail(); return }
      if (!accepting || request.method !== 'GET' || url.pathname !== '/oauth/google/callback' || request.headers.host !== new URL(redirect).host
        || url.searchParams.get('state') !== state || (this.pending?.expiresAt ?? 0) < this.now()) { fail(); return }
      accepting = false
      const code = url.searchParams.get('code')
      if (!code || url.searchParams.has('error')) { response.writeHead(400); response.end('Google 登录未完成。'); this.endPending(); return }
      const exchange = (async () => {
        try {
          const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirect })
          if (!tokens.id_token || !tokens.refresh_token) throw new Error('Missing account proof or offline token')
          const proof = await client.verifyIdToken({ idToken: tokens.id_token, audience: configuration.clientId })
          const payload = proof.getPayload()
          if (!payload?.sub || !payload.email || !payload.email_verified) throw new Error('Account identity unavailable')
          const accountId = `google:${payload.sub}`
          if (this.closing) throw new Error('OAuth owner disposed')
          const saved: HLStoredGoogleTokens = { refresh_token: tokens.refresh_token, ...(tokens.access_token ? { access_token: tokens.access_token } : {}),
            ...(tokens.expiry_date ? { expiry_date: tokens.expiry_date } : {}), ...(tokens.scope ? { scope: tokens.scope } : {}) }
          await this.options.secrets.set(`personal:google:${accountId}`, JSON.stringify(saved))
          if (this.closing) { await this.options.secrets.delete(`personal:google:${accountId}`); throw new Error('OAuth owner disposed') }
          this.options.store.transaction(() => this.options.store.put('connection', { id: accountId, provider: 'google', email: payload.email!,
            scopes: tokens.scope?.split(' ').filter(Boolean) ?? [], state: 'connected', updatedAt: this.now() }))
          this.options.changed()
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" })
          response.end('<!doctype html><meta charset="utf-8"><title>Harness Link</title><style>body{font:17px system-ui;padding:80px 24px;text-align:center;color:#182230}h1{color:#355ce0}</style><h1>Google 账户已连接</h1><p>可以关闭此页面，返回 Harness Link。</p>')
        } catch {
          response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); response.end('账户连接未完成，请在 Harness Link 重新登录。')
        } finally { this.endPending() }
      })()
      this.authJobs.add(exchange)
      void exchange.finally(() => this.authJobs.delete(exchange)).catch(() => undefined)
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() }) })
    if (this.closing) { server.close(); throw new HLPersonalError('PERSONAL_STOPPING', '账户连接正在关闭') }
    const address = server.address()
    if (!address || typeof address === 'string') { server.close(); throw new HLPersonalError('PERSONAL_GOOGLE_CALLBACK', '无法启动本机授权回调') }
    redirect = `http://127.0.0.1:${address.port}/oauth/google/callback`
    const url = client.generateAuthUrl({ redirect_uri: redirect, access_type: 'offline', prompt: 'consent', scope: HL_GOOGLE_SCOPES,
      state, code_challenge: codeChallenge, code_challenge_method: 'S256' as import('google-auth-library').CodeChallengeMethod })
    const expiresAt = this.now() + 10 * 60_000
    const timer = setTimeout(() => this.endPending(), 10 * 60_000); timer.unref()
    this.pending = { server, url, expiresAt, timer }
    if (this.options.openBrowser) this.options.openBrowser(url)
    else execFile('open', [url], { timeout: 5000 }, () => undefined)
    return { url, expiresAt }
  }
  private endPending(): void {
    if (!this.pending) return
    clearTimeout(this.pending.timer); this.pending.server.close(); this.pending.server.closeIdleConnections(); this.pending = undefined
  }
  private token(accountId: string): Promise<string> {
    const inFlight = this.tokenJobs.get(accountId)
    if (inFlight) return inFlight
    const work = this.loadToken(accountId).finally(() => this.tokenJobs.delete(accountId))
    this.tokenJobs.set(accountId, work); return work
  }
  private async loadToken(accountId: string): Promise<string> {
    await this.initialize()
    const connection = this.options.store.get('connection', accountId)
    if (!connection || connection.state !== 'connected') throw new HLPersonalError('PERSONAL_CONNECTION_REQUIRED', '请在桌面连接或重新授权 Google 账户')
    const bytes = await this.options.secrets.get(`personal:google:${accountId}`)
    if (!bytes) throw new HLPersonalError('PERSONAL_CONNECTION_REQUIRED', 'Google 凭据不可用，请重新登录')
    try {
      const stored = JSON.parse(bytes) as HLStoredGoogleTokens
      const client = new OAuth2Client(this.configuration.clientId, this.configuration.clientSecret)
      client.setCredentials(stored)
      const access = await client.getAccessToken()
      if (!access.token) throw new Error('No access token')
      const merged = { ...stored, ...client.credentials }
      await this.options.secrets.set(`personal:google:${accountId}`, JSON.stringify(merged))
      if (this.options.store.get('connection', accountId)?.state !== 'connected') throw new HLPersonalError('PERSONAL_CONNECTION_REQUIRED', 'Google 账户已断开')
      return access.token
    } catch (error) {
      if (error instanceof HLPersonalError) throw error
      this.options.store.transaction(() => this.options.store.put('connection', { ...connection, state: 'reauth-required', updatedAt: this.now() })); this.options.changed()
      throw new HLPersonalError('PERSONAL_GOOGLE_REAUTH', 'Google 授权已失效，请在桌面重新登录')
    }
  }
  async request(accountId: string, api: 'gmail' | 'calendar', path: string, request: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown; etag?: string }, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (this.closing) throw new HLPersonalError('PERSONAL_STOPPING', 'Google 连接正在关闭')
    if (!path.startsWith('/') || path.startsWith('//') || /[\r\n]/.test(path)) throw new HLPersonalError('PERSONAL_INPUT', '无效的服务请求')
    const connection = this.options.store.get('connection', accountId)
    const required = api === 'gmail' ? request.method === 'POST' ? 'https://www.googleapis.com/auth/gmail.send' : 'https://www.googleapis.com/auth/gmail.readonly'
      : path.startsWith('/users/me/calendarList') ? 'https://www.googleapis.com/auth/calendar.calendarlist.readonly' : 'https://www.googleapis.com/auth/calendar.events.owned'
    if (connection?.state === 'connected' && !connection.scopes.includes(required)) throw new HLPersonalError('PERSONAL_GOOGLE_PERMISSION', '该 Google 账户缺少此能力的权限，请重新连接并授权')
    const token = await this.token(accountId)
    signal.throwIfAborted()
    const controller = new AbortController(); this.requests.add(controller)
    try {
      const origin = api === 'gmail' ? 'https://gmail.googleapis.com/gmail/v1/users/me' : 'https://www.googleapis.com/calendar/v3'
      const response = await this.fetcher(origin + path, { method: request.method ?? 'GET', redirect: 'error',
        signal: AbortSignal.any([signal, controller.signal, AbortSignal.timeout(30_000)]),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(request.etag ? { 'If-Match': request.etag } : {}) },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) })
      if (!response.ok) {
        if (response.status === 412) throw new HLPersonalError('PERSONAL_PROVIDER_CONFLICT', '日程已在其他端修改，请重新读取后核对')
        if (response.status === 401 || response.status === 403) throw new HLPersonalError('PERSONAL_GOOGLE_PERMISSION', 'Google 没有授予此操作所需权限，请核对账户授权')
        if (response.status === 429) throw new HLPersonalError('PERSONAL_GOOGLE_RATE_LIMIT', 'Google 服务暂时限流，请稍后继续')
        if (response.status === 404) throw new HLPersonalError('PERSONAL_PROVIDER_NOT_FOUND', 'Google 中的对象已不存在')
        throw new HLPersonalError('PERSONAL_GOOGLE_REQUEST', `Google 服务请求未完成（${response.status}）`)
      }
      const body = await response.text()
      if (Buffer.byteLength(body) > 4 * 1024 * 1024) throw new HLPersonalError('PERSONAL_PROVIDER_LIMIT', '服务返回内容过大，请缩小查询范围')
      const result: unknown = body ? JSON.parse(body) : {}
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new HLPersonalError('PERSONAL_GOOGLE_RESPONSE', 'Google 返回了无效结果')
      return result as Record<string, unknown>
    } finally { this.requests.delete(controller) }
  }
  async disconnect(accountId: string): Promise<void> {
    const connection = this.options.store.get('connection', accountId)
    if (!connection) throw new HLPersonalError('PERSONAL_NOT_FOUND', '账户不存在')
    this.options.store.transaction(() => {
      this.options.store.put('connection', { ...connection, state: 'disconnected', updatedAt: this.now() })
      for (const grant of this.options.store.list('grant').filter(row => row.accountId === accountId && row.state === 'active')) this.options.store.put('grant', { ...grant, state: 'revoked', revision: grant.revision + 1 })
    }); this.options.changed()
    await Promise.allSettled([...this.tokenJobs.values()])
    await this.options.secrets.delete(`personal:google:${accountId}`)
  }
  async dispose(): Promise<void> {
    this.closing = true; this.endPending()
    for (const controller of this.requests) controller.abort()
    await Promise.allSettled([this.initializing, this.configurationWork, this.starting, ...this.tokenJobs.values(), ...this.authJobs])
  }
}
