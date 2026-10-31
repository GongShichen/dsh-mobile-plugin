#!/usr/bin/env node
// Native iOS UI QA. Only the isolated official Host may receive fixture prompts.
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, chmod, readdir, rm, cp } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1] }
const device = option('--device'), simulator = option('--simulator'), testRun = option('--xctestrun')
if (Boolean(device) === Boolean(simulator) || !testRun) throw new Error('Provide exactly one explicit --device or --simulator and its build-for-testing --xctestrun')
const targetId = device ?? simulator
const platform = simulator ? 'ios-simulator' : 'ios-device'
const destination = `${simulator ? 'platform=iOS Simulator' : 'platform=iOS'},id=${targetId}`
const runKey = createHash('sha256').update(`${simulator ? 'simulator' : 'physical'}:${targetId}`).digest('hex').slice(0, 12)
const directory = resolve(option('--directory', join(root, '.local/interactions-qa')))
const allModes = ['approval', 'reject', 'desktop', 'cancel', 'reconnect', 'permission', 'plan', 'questions', 'skip', 'timed']
const only = option('--only')
assert.ok(!only || allModes.includes(only), 'Unknown interaction QA mode')
const modes = only ? [only] : allModes
const { origin, cookie } = JSON.parse(await readFile(resolve(option('--auth', join(root, '.local/integration/auth.json'))), 'utf8'))
assert.ok(new URL(origin).protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname), 'QA origin must be loopback')
await mkdir(directory, { recursive: true }); await chmod(directory, 0o700)
const privateJson = async (path, value) => { await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 }); await chmod(path, 0o600) }
function run(command, argv, input) {
  return new Promise((done, reject) => {
    const child = spawn(command, argv, { stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks = []; let error = ''
    child.stdout.on('data', d => chunks.push(d)); child.stderr.on('data', d => { error += d })
    child.on('error', reject)
    child.on('close', code => code === 0 ? done(Buffer.concat(chunks).toString()) : reject(new Error(`QA command failed (${code}): ${error.slice(-180)}`)))
    child.stdin.end(input)
  })
}
async function rpc(method, payload = {}) {
  const response = await fetch(`${origin}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }), signal: AbortSignal.timeout(12_000) })
  assert.equal(response.ok, true, `QA HTTP failed: ${method}`)
  const body = await response.json()
  assert.equal(body.result?.ok, true, `QA RPC failed: ${method}`)
  return body.result.value
}
const management = (name, payload = {}) => rpc(`mobileAccess/${name}`, payload)
const fixture = async () => JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))
assert.equal((await management('status')).hostName, 'Harness Link interaction QA', 'Refusing to use a production Host')
assert.equal((await fixture()).ready, true)
async function settingsSnapshot(label) {
  const path = join(directory, `ios-settings-${label}-${Date.now()}`)
  await mkdir(path, { mode: 0o700 })
  if (simulator) {
    const container = (await run('xcrun', ['simctl', 'get_app_container', simulator, 'org.harnesslink.app', 'data'])).trim()
    await cp(join(container, 'Library/Application Support/databases'), path, { recursive: true })
  } else await run('xcrun', ['devicectl', 'device', 'copy', 'from', '--device', device, '--domain-type', 'appDataContainer', '--domain-identifier', 'org.harnesslink.app',
    '--source', 'Library/Application Support/databases', '--destination', path])
  for (const file of await readdir(path)) await chmod(join(path, file), 0o600)
  return JSON.parse(await run('python3', ['-c', `import sqlite3,json,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
p=c.execute("SELECT preference_value FROM preference WHERE preference_key='selected.host'").fetchone()
hosts={r[0]:json.loads(r[1])['name'] for r in c.execute('SELECT host_id,raw_json FROM desktop_host')}
print(json.dumps({'originalHostId':p[0] if p else None,'hostIds':list(hosts),'hostNames':hosts}))`, join(path, 'dsh-mobile.db')]))
}
const originalFile = join(directory, `ios-original-state-${runKey}.json`)
let original
try { original = JSON.parse(await readFile(originalFile, 'utf8')) }
catch (error) { if (error.code !== 'ENOENT') throw error; original = await settingsSnapshot('before'); await privateJson(originalFile, original) }
if (!original.hostNames) { original.hostNames = (await settingsSnapshot('names')).hostNames; await privateJson(originalFile, original) }
assert.equal(new Set(Object.values(original.hostNames)).size, original.hostIds.length, 'The UI QA fixture requires uniquely named computers')
const status = await management('status'), initial = await fixture()
const oldSessions = new Set(Object.keys(initial.sessions))
const invitation = await management('startPairing')
const invite = JSON.parse(Buffer.from(new URL(invitation.uri).searchParams.get('data'), 'base64url').toString())
const config = { uri: invitation.uri, endpointId: status.endpointId, originalHostId: original.originalHostId, hostNames: { ...original.hostNames, [status.endpointId]: status.hostName }, modes }
const redact = value => value.replaceAll(config.uri, '[redacted one-use invitation]')
assert.notEqual(config.originalHostId, status.endpointId, 'Restore the original non-QA computer before starting')
const source = resolve(testRun)
const base = JSON.parse(await run('plutil', ['-convert', 'json', '-o', '-', source]))
function absolutePaths(value) {
  if (typeof value === 'string') return value.replaceAll('__TESTROOT__', dirname(source))
  if (Array.isArray(value)) return value.map(absolutePaths)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, absolutePaths(v)]))
  return value
}
const runFile = join(directory, `HLInteractions-${runKey}.xctestrun`)
async function configureRun(restoreOnly = false) {
  const value = absolutePaths(base)
  const targets = value.TestConfigurations?.flatMap(c => c.TestTargets ?? []) ?? Object.values(value).filter(v => v && typeof v === 'object' && v.TestBundlePath)
  const target = targets.find(t => t.BlueprintName === 'HLAppUITests' || String(t.TestBundlePath).includes('HLAppUITests.xctest'))
  assert.ok(target, 'The build-for-testing product must contain HLAppUITests')
  target.EnvironmentVariables = { ...target.EnvironmentVariables, HL_IOS_INTERACTION_QA: JSON.stringify({ ...config, restoreOnly }), NSUnbufferedIO: 'YES' }
  target.OnlyTestIdentifiers = ['HLIOSInteractionFlowTests/testSynchronizeDesktopInteractions']
  target.SkipTestIdentifiers = []
  await privateJson(runFile, value); await run('plutil', ['-convert', 'xml1', runFile]); await chmod(runFile, 0o600)
}
await configureRun()
const resultBundle = join(directory, `ios-${simulator ? 'simulator' : 'physical'}-${Date.now()}.xcresult`)
const command = ['test-without-building', '-xctestrun', runFile, '-destination', destination, '-resultBundlePath', resultBundle,
  '-only-testing:HLAppUITests/HLIOSInteractionFlowTests/testSynchronizeDesktopInteractions']
await privateJson(join(directory, 'ios-result.json'), { ok: null, platform, modes })
let output = '', finished = false, exitCode
const child = spawn('xcodebuild', command, { stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.on('data', d => { output += d }); child.stderr.on('data', d => { output += d })
child.on('error', () => { finished = true; exitCode = -1 }); child.on('close', code => { finished = true; exitCode = code })
const started = new Map(), acted = new Set()
let approvedDevice, phase, held = false, succeeded = false, loggedLength = 0
try {
  const deadline = Date.now() + 12 * 60_000
  while (!finished && Date.now() < deadline) {
    if (output.length !== loggedLength) { await writeFile(join(directory, 'ios-live.log'), redact(output), { mode: 0o600 }); loggedLength = output.length }
    const s = await management('status')
    const pending = s.pending.filter(p => p.pairingId === invite.pairingId && p.platform === 'ios')
    assert.ok(pending.length <= 1, 'More than one iPhone used the private invitation')
    if (pending[0]) { await management('confirmDevice', { requestId: pending[0].requestId, approved: true }); approvedDevice = pending[0].deviceId }
    const stages = [...output.matchAll(/HL_IOS_QA:([a-z:-]+)/g)].map(m => m[1])
    if (stages.at(-1) && stages.at(-1) !== phase) { phase = stages.at(-1); console.log(`${simulator ? 'iOS Simulator' : 'iPhone'} QA: ${phase}`) }
    for (const mode of modes) if (stages.includes(`request:${mode}`) && !started.has(mode)) {
      const session = await rpc('session/create', { args: { request: { workspaceId: initial.workspaceId } } })
      started.set(mode, session.sessionId)
      await rpc('session/rename', { args: { request: { sessionId: session.sessionId, title: `HL QA · ${mode}` } } })
      await rpc('session/selectModel', { args: { request: { sessionId: session.sessionId, provider: 'hl-interaction-fixture', model: 'hl-interaction-fixture' } } })
      await rpc('session/prompt', { args: { request: { sessionId: session.sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: `[HL_QA:${mode}:${randomUUID()}]` }] } } })
    }
    for (const mode of ['desktop', 'cancel']) if (stages.includes(`${mode}-visible`) && !acted.has(mode)) {
      const sessionId = started.get(mode), frame = (await fixture()).desktop[sessionId]
      if (frame) {
        if (mode === 'desktop') await rpc('$events/result', { args: { clientId: frame.clientId, eventId: frame.eventId, outcome: { kind: 'result', value: 'rejected' } } })
        else await rpc('session/cancel', { args: { request: { sessionId } } })
        acted.add(mode)
      }
    }
    if (stages.includes('timed-held') && !held) {
      const p = await rpc('session/projections', { args: { request: { sessionId: started.get('timed') } } })
      assert.ok(p.values?.userQuestions?.active?.some(q => q.state === 'open'), 'Focused iPhone must retain the official timed wait')
      held = true
    }
    await delay(200)
  }
  assert.equal(finished, true, 'iOS QA exceeded its time budget')
  await writeFile(join(directory, 'ios-instrumentation.log'), redact(output), { mode: 0o600 })
  assert.equal(exitCode, 0, 'iOS UI QA failed; see the private xcresult and instrumentation log')
  assert.ok(output.includes('HL_IOS_QA:complete') && output.includes('HL_IOS_QA:restored'), 'The flow must complete and restore the original computer')
  let state
  for (let i = 0; i < 60; i++) {
    state = await fixture()
    if (modes.every(mode => { const row = state.sessions[started.get(mode)]; return row?.ended && (mode !== 'timed' || row.lateReply) })) break
    await delay(100)
  }
  const row = mode => state.sessions[started.get(mode)]
  for (const mode of modes) assert.ok(row(mode)?.ended, `${mode} must finish in the Host journal`)
  for (const [mode, value] of [['approval', 'allowed-once'], ['reject', 'rejected'], ['desktop', 'rejected'], ['reconnect', 'allowed-once']]) if (modes.includes(mode)) assert.equal(row(mode).result, value)
  if (modes.includes('permission')) assert.equal(row('permission').result.answers[0].selected[0], 'grant-persistent')
  if (modes.includes('plan')) assert.equal(row('plan').result.answers[0].selected[0], '同意测试计划')
  const answers = mode => JSON.parse(row(mode).toolResult.message.content.find(b => b.type === 'text').text).answers
  if (modes.includes('questions')) { const a = answers('questions'); assert.deepEqual(a.find(q => q.id === 'scope').selected, ['消息同步', '权限确认']); assert.equal(a.find(q => q.id === 'note').custom, 'HL iOS physical answer') }
  if (modes.includes('skip')) assert.deepEqual(answers('skip')[0].selected, [])
  if (modes.includes('timed')) { assert.equal(held, true); assert.ok(row('timed').lateReply) }
  const audit = Object.values(state.audit).filter(a => [...started.values()].includes(a.sessionId))
  assert.ok(audit.every(a => a.decisions.length === 1))
  const after = await settingsSnapshot('after')
  assert.equal(after.originalHostId, original.originalHostId, 'The original computer selection must be restored')
  assert.deepEqual([...after.hostIds].sort(), [...original.hostIds].sort(), 'Existing paired computers must be preserved and the QA entry removed')
  await privateJson(join(directory, 'ios-result.json'), { ok: true, platform, modes, restoredOriginalComputer: true, singleApprovalSettlement: true, resultBundle })
  await rm(originalFile)
  succeeded = true
  console.log(`PASS: ${simulator ? 'iOS Simulator' : 'physical iPhone'} ↔ DSH (${modes.join(', ')})`)
} finally {
  if (!finished) child.kill('SIGTERM')
  await writeFile(join(directory, 'ios-instrumentation.log'), redact(output), { mode: 0o600 })
  for (const sessionId of started.values()) if (!(await fixture()).sessions[sessionId]?.ended) await rpc('session/cancel', { args: { request: { sessionId } } }).catch(() => {})
  if (approvedDevice) await management('revokeDevice', { deviceId: approvedDevice }).catch(() => {})
  if (!succeeded) {
    await privateJson(join(directory, 'ios-result.json'), { ok: false, platform, modes, phase, resultBundle })
    // UI restoration is idempotent and uses no pairing or fixture prompt on this recovery pass.
    await configureRun(true)
    await run('xcodebuild', ['test-without-building', '-xctestrun', runFile, '-destination', destination,
      '-only-testing:HLAppUITests/HLIOSInteractionFlowTests/testSynchronizeDesktopInteractions']).catch(() => {})
  }
  await rm(runFile, { force: true })
}
