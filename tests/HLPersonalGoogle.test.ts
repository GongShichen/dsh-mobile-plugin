import test from 'node:test'
import assert from 'node:assert/strict'
import { HLGoogleOAuth } from '../src/personal/connectors/google/HLGoogleOAuth.ts'
import { hlGmailOperations } from '../src/personal/connectors/google/HLGmailConnector.ts'
import { hlCalendarOperations } from '../src/personal/connectors/google/HLCalendarConnector.ts'
import { HLPersonalSQLite } from '../src/personal/storage/HLPersonalSQLite.ts'
import type { HLPersonalAction } from '../src/personal/core/HLPersonalTypes.ts'
import { HL_GOOGLE_CLIENT_KEY, hlParseGoogleClientJson } from '../src/personal/connectors/google/HLGoogleClient.ts'
import { HLPersonalFramework } from '../src/personal/core/HLPersonalFramework.ts'
import { HLPersonalAPI } from '../src/personal/transport/HLPersonalAPI.ts'
import { randomUUID } from 'node:crypto'

type HLGoogleRequest = Parameters<HLGoogleOAuth['request']>
function fakeGoogle(run: (...args: HLGoogleRequest) => Promise<Record<string, unknown>>): HLGoogleOAuth {
  // This provider seam is test-only; no real account, OAuth code, credential or network endpoint is used.
  return { request: run } as unknown as HLGoogleOAuth
}
test('Gmail validates all recipients and headers before preparing a task write', () => {
  const send = hlGmailOperations(fakeGoogle(async () => ({}))).find(row => row.id === 'google.gmail.send')!
  const parsed = send.parse({ to: ['Me@example.com'], cc: ['cc@example.com'], bcc: ['private@example.com'], subject: '摘要', body: '内容' })
  assert.deepEqual(parsed.recipients, ['me@example.com', 'cc@example.com', 'private@example.com'])
  assert.throws(() => send.parse({ to: ['a@example.com\r\nBcc: outside@example.com'], subject: 's', body: 'body' }))
  assert.throws(() => send.parse({ to: ['Group: outside@example.com'], subject: 's', body: 'body' }))
  assert.throws(() => send.parse({ to: ['a@example.com'], subject: 'hello\nextra header', body: 'body' }))
  assert.throws(() => send.parse({ to: Array.from({ length: 11 }, (_, i) => `x${i}@example.com`), subject: 's', body: 'body' }))
})

test('Gmail MIME uses a stable action Message-ID and sends only declared recipients', async () => {
  const requests: HLGoogleRequest[] = []
  const google = fakeGoogle(async (...args) => { requests.push(args); return { id: 'sent-1', threadId: 'thread-1' } })
  const send = hlGmailOperations(google).find(row => row.id === 'google.gmail.send')!
  const parsed = send.parse({ to: ['me@example.com'], bcc: ['private@example.com'], subject: '中文主题', body: '中文正文' })
  await send.execute('account', parsed.input, 'fixed-action', new AbortController().signal)
  await send.execute('account', parsed.input, 'fixed-action', new AbortController().signal)
  const raw = (requests[0]![3].body as { raw: string }).raw
  const decoded = Buffer.from(raw, 'base64url').toString()
  assert.match(decoded, /To: me@example.com/)
  assert.match(decoded, /Bcc: private@example.com/)
  assert.match(decoded, /Subject: =\?UTF-8\?B\?/)
  assert.equal((requests[1]![3].body as { raw: string }).raw, raw)
  assert.equal(Buffer.from(decoded.split('\r\n\r\n')[1]!, 'base64').toString(), '中文正文')
  assert.equal(requests[0]![2], '/messages/send')
})

test('Calendar creates deterministic valid event ids; updates carry the expected ETag', async () => {
  const requests: HLGoogleRequest[] = []
  const google = fakeGoogle(async (...args) => {
    requests.push(args)
    if (args[3].method === undefined) return { id: 'existing', attendees: [], etag: '"v1"' }
    return { id: 'created', etag: '"v2"', htmlLink: 'https://calendar.google.com/event' }
  })
  const operations = hlCalendarOperations(google)
  const create = operations.find(row => row.id === 'google.calendar.create')!
  const update = operations.find(row => row.id === 'google.calendar.update')!
  const input = { summary: '阅读', start: '2026-11-02T14:00:00+08:00', end: '2026-11-02T14:30:00+08:00', timeZone: 'Asia/Shanghai' }
  await create.execute('account', create.parse(input).input, 'one-action', new AbortController().signal)
  await create.execute('account', create.parse(input).input, 'one-action', new AbortController().signal)
  const first = requests[0]![3].body as { id: string }
  assert.match(first.id, /^[a-v0-9]{5,1024}$/)
  assert.equal((requests[1]![3].body as { id: string }).id, first.id)
  await update.execute('account', update.parse({ ...input, eventId: 'existing', etag: '"v1"' }).input, 'update-action', new AbortController().signal)
  assert.equal(requests.at(-1)![3].etag, '"v1"')
  assert.equal(requests.at(-1)![3].method, 'PATCH')
})

test('Calendar reconciliation does not confirm an unrelated matching-time event', async () => {
  const google = fakeGoogle(async () => ({ id: 'existing', summary: '阅读', start: { dateTime: '2026-11-02T06:00:00Z' }, end: { dateTime: '2026-11-02T06:30:00Z' },
    description: 'old', etag: '"unchanged"', attendees: [] }))
  const update = hlCalendarOperations(google).find(row => row.id === 'google.calendar.update')!
  const input = update.parse({ summary: '阅读', start: '2026-11-02T14:00:00+08:00', end: '2026-11-02T14:30:00+08:00', timeZone: 'Asia/Shanghai', description: 'new', eventId: 'existing', etag: '"unchanged"' }).input
  const action: HLPersonalAction = { id: 'action', taskId: 'task', accountId: 'account', operation: update.id, input, preview: '', fingerprint: '',
    recipients: [], calendarIds: ['primary'], state: 'unknown', createdAt: 0, updatedAt: 0 }
  assert.deepEqual(await update.reconcile!(action, new AbortController().signal), { state: 'unknown' })
})

test('Desktop OAuth binds PKCE and a temporary loopback callback; invalid state stores no credentials', async () => {
  const store = new HLPersonalSQLite(':memory:'); const secrets = new Map<string, string>(); let opened = ''
  const oauth = new HLGoogleOAuth({ configuration: { clientId: 'test.apps.googleusercontent.com' }, store, changed() {},
    secrets: { async get(key) { return secrets.get(key) }, async set(key, value) { secrets.set(key, value) }, async delete(key) { secrets.delete(key) } },
    openBrowser(url) { opened = url } })
  try {
    const pending = await oauth.begin()
    assert.equal(opened, pending.url)
    const url = new URL(pending.url)
    assert.equal(url.hostname, 'accounts.google.com')
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    assert.ok((url.searchParams.get('code_challenge') ?? '').length > 30)
    const callback = new URL(url.searchParams.get('redirect_uri')!)
    assert.equal(callback.hostname, '127.0.0.1')
    callback.searchParams.set('state', 'wrong-state'); callback.searchParams.set('code', 'not-a-real-code')
    const response = await fetch(callback)
    assert.equal(response.status, 400); assert.equal(secrets.size, 0); assert.equal(store.list('connection').length, 0)
  } finally { await oauth.dispose(); store.close() }
})

const clientJson = (name = 'own-client') => JSON.stringify({ installed: { client_id: `${name}.apps.googleusercontent.com`, client_secret: 'test-only-client-secret',
  auth_uri: 'https://invalid.example/steal', token_uri: 'https://invalid.example/steal', project_id: 'ignored-project' } })
function oauthFixture() {
  const store = new HLPersonalSQLite(':memory:'); const values = new Map<string, string>()
  const secrets = { async get(key: string) { return values.get(key) }, async set(key: string, value: string) { values.set(key, value) }, async delete(key: string) { values.delete(key) } }
  const create = () => new HLGoogleOAuth({ configuration: {}, store, secrets, changed() {}, openBrowser() {} })
  return { store, values, secrets, create, oauth: create() }
}

test('Optional Google configuration accepts Desktop JSON and rejects other credential types without echoing them', () => {
  assert.deepEqual(hlParseGoogleClientJson(clientJson()), { clientId: 'own-client.apps.googleusercontent.com', clientSecret: 'test-only-client-secret' })
  for (const value of ['', '{', null, '[]', JSON.stringify({ web: { client_id: 'x', client_secret: 'do-not-echo' } }),
    JSON.stringify({ type: 'service_account', private_key: 'do-not-echo' }), clientJson().replace('own-client.apps.googleusercontent.com', 'invalid.example'),
    clientJson().replace('test-only-client-secret', ''), 'x'.repeat(65537)]) {
    assert.throws(() => hlParseGoogleClientJson(value), error => error instanceof Error && !error.message.includes('do-not-echo'))
  }
})

test('User-owned OAuth configuration survives restart in Keychain and is absent from Personal snapshots', async () => {
  const f = oauthFixture(); let reopened: HLGoogleOAuth | undefined
  try {
    await f.oauth.initialize(); assert.equal(f.oauth.configured, false)
    await assert.rejects(f.oauth.begin(), { code: 'PERSONAL_GOOGLE_NOT_CONFIGURED' })
    assert.deepEqual(await f.oauth.importClient(clientJson()), { configured: true })
    const saved = JSON.parse(f.values.get(HL_GOOGLE_CLIENT_KEY)!)
    assert.deepEqual(Object.keys(saved.installed).sort(), ['client_id', 'client_secret'])
    await f.oauth.dispose(); reopened = f.create(); await reopened.initialize()
    assert.equal(reopened.configured, true)
    const framework = new HLPersonalFramework({ store: f.store, id: randomUUID, directory: id => `/tmp/hl-unused/${id}` })
    framework.attachGoogle(reopened)
    assert.equal(framework.snapshot().googleConfigured, true)
    assert.ok(!JSON.stringify(framework.snapshot()).includes('test-only-client-secret'))
    assert.ok(!JSON.stringify(framework.snapshot()).includes('own-client.apps.googleusercontent.com'))
    const pending = await reopened.begin(); const url = new URL(pending.url)
    assert.equal(url.hostname, 'accounts.google.com')
    assert.equal(url.searchParams.get('client_id'), 'own-client.apps.googleusercontent.com')
    assert.ok(!pending.url.includes('invalid.example'))
    assert.deepEqual(await reopened.clearClient(), { configured: false })
    assert.equal(f.values.has(HL_GOOGLE_CLIENT_KEY), false)
    assert.equal(framework.snapshot().googleConfigured, false)
  } finally { await f.oauth.dispose(); await reopened?.dispose(); f.store.close() }
})

test('Changing the client requires disconnecting accounts and invalidates an old pending login', async () => {
  const f = oauthFixture()
  try {
    await f.oauth.importClient(clientJson())
    const pending = await f.oauth.begin()
    f.store.transaction(() => f.store.put('connection', { id: 'google:one', provider: 'google', email: 'fixture@example.com', scopes: [], state: 'connected', updatedAt: 0 }))
    await assert.rejects(f.oauth.importClient(clientJson('new-client')), { code: 'PERSONAL_GOOGLE_CLIENT_IN_USE' })
    await assert.rejects(f.oauth.clearClient(), { code: 'PERSONAL_GOOGLE_CLIENT_IN_USE' })
    await f.oauth.disconnect('google:one')
    await f.oauth.importClient(clientJson('new-client'))
    const replacement = await f.oauth.begin()
    assert.notEqual(replacement.url, pending.url)
    assert.equal(new URL(replacement.url).searchParams.get('client_id'), 'new-client.apps.googleusercontent.com')
  } finally { await f.oauth.dispose(); f.store.close() }
})

test('Only the authenticated desktop owner may import, remove or launch Google authorization', async () => {
  const f = oauthFixture()
  const framework = new HLPersonalFramework({ store: f.store, id: randomUUID, directory: id => `/tmp/hl-unused/${id}` })
  framework.attachGoogle(f.oauth)
  const api = new HLPersonalAPI(framework, f.oauth); const signal = new AbortController().signal
  try {
    for (const method of ['importGoogleClient', 'clearGoogleClient', 'beginGoogleAuth']) {
      await assert.rejects(api.invoke(`personal.${method}`, { clientJson: clientJson() }, { deviceId: 'paired-phone', desktop: false }, signal), { code: 'PERSONAL_DESKTOP_REQUIRED' })
    }
    assert.equal(f.values.size, 0)
    assert.deepEqual(await api.invoke('personal.importGoogleClient', { clientJson: clientJson() }, { deviceId: 'owner', desktop: true }, signal), { configured: true })
    assert.deepEqual(await api.invoke('personal.clearGoogleClient', {}, { deviceId: 'owner', desktop: true }, signal), { configured: false })
  } finally { await f.oauth.dispose(); f.store.close() }
})

test('Failed Keychain writes leave the prior optional configuration intact and return a safe error', async () => {
  const f = oauthFixture()
  const broken = new HLGoogleOAuth({ configuration: {}, store: f.store, changed() {}, secrets: { ...f.secrets, async set() { throw new Error('sensitive provider detail') } } })
  try {
    await assert.rejects(broken.importClient(clientJson()), error => error instanceof Error && !error.message.includes('sensitive provider detail'))
    assert.equal(broken.configured, false); assert.equal(f.values.size, 0)
  } finally { await broken.dispose(); await f.oauth.dispose(); f.store.close() }
})

test('Concurrent login launches reuse a single PKCE callback', async () => {
  const f = oauthFixture()
  try {
    await f.oauth.importClient(clientJson())
    const [one, two] = await Promise.all([f.oauth.begin(), f.oauth.begin()])
    assert.equal(one.url, two.url)
  } finally { await f.oauth.dispose(); f.store.close() }
})
