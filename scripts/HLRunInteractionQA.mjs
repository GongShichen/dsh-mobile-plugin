#!/usr/bin/env node
// Run only against tests/fixtures/HLInteractionFixture.ts on an isolated DSH profile.
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { EndpointAddr, EndpointTicket } from '@number0/iroh'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1] }
const serial = option('--device')
const onlyMode = option('--only')
const allModes = ['approval', 'reject', 'desktop', 'cancel', 'reconnect', 'permission', 'plan', 'questions', 'skip', 'timed']
if (onlyMode && ![...allModes, 'conversation', 'changes'].includes(onlyMode)) throw new Error(`Unknown QA mode: ${onlyMode}`)
const modes = onlyMode ? [onlyMode] : allModes
if (!serial) throw new Error('Use --device with an explicit adb device identifier; no device is selected automatically')
const mobile = resolve(option('--mobile', join(root, '../dsh-mobile')))
const directory = resolve(option('--directory', join(root, '.local/interactions-qa')))
const authFile = resolve(option('--auth', join(root, '.local/integration/auth.json')))
const { origin, cookie } = JSON.parse(await readFile(authFile, 'utf8'))
if (new URL(origin).protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) throw new Error('QA origin must be loopback')
const adb = join(process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME ?? join(process.env.HOME, 'Library/Android/sdk'), 'platform-tools/adb')
const pkg = 'org.harnesslink.app'
await mkdir(directory, { recursive: true }); await chmod(directory, 0o700)

function run(command, argv, input, binary = false) {
  return new Promise((resolveRun, reject) => {
    const p = spawn(command, argv, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout = []; let stderr = ''
    p.stdout.on('data', data => { stdout.push(data) }); p.stderr.on('data', data => { stderr += data })
    p.on('error', reject); p.on('close', code => code === 0 ? resolveRun(binary ? Buffer.concat(stdout) : Buffer.concat(stdout).toString()) : reject(new Error(`Command failed (${code}): ${stderr.slice(-300)}`)))
    p.stdin.end(input)
  })
}
const phone = (argv, input) => run(adb, ['-s', serial, ...argv], input)
const phoneBytes = argv => run(adb, ['-s', serial, ...argv], undefined, true)
if ((await phone(['shell', 'dumpsys', 'connectivity'])).includes('Active default network: none')) {
  throw new Error('The test device has no active network. Enable Wi-Fi before running P2P interaction QA.')
}
async function rpc(method, payload) {
  const r = await fetch(`${origin}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }), signal: AbortSignal.timeout(12_000) })
  if (!r.ok) throw new Error(`QA Host HTTP ${r.status}`)
  const body = await r.json()
  if (body.result?.ok !== true) throw new Error(`QA Host rejected ${method}`)
  return body.result.value
}
const management = (name, payload = {}) => rpc(`mobileAccess/${name}`, payload)
const hostState = async () => JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))
const status = await management('status')
assert.equal(status.hostName, 'Harness Link interaction QA', 'Refusing to test against a production Host')
const initial = await hostState()
assert.equal(initial.ready, true, 'Load the isolated interaction fixture first')
const oldSessions = new Set(Object.keys(initial.sessions))
let invitation = await management('startPairing')
const decodeInvitation = value => JSON.parse(Buffer.from(new URL(value.uri).searchParams.get('data'), 'base64url').toString())
let pairing = decodeInvitation(invitation)
let uri = invitation.uri
if (serial.startsWith('emulator-')) {
  // Android's emulator reaches the host loopback through this documented guest alias.
  // Only the test invitation gets this routing hint; identity and invitation authentication stay intact.
  let address, local
  for (let attempt = 0; attempt < 40; attempt++) {
    address = EndpointTicket.fromString(pairing.ticket).endpointAddr()
    local = address.directAddresses().find(a => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a))
    if (local) break
    await delay(250); invitation = await management('startPairing'); pairing = decodeInvitation(invitation)
  }
  assert.ok(local, 'Wait for a private IPv4 UDP address; a public NAT-mapped port cannot route through the emulator host alias')
  const ticket = EndpointTicket.fromAddr(new EndpointAddr(address.id(), address.relayUrl(), [...address.directAddresses(), `10.0.2.2:${local.split(':').at(-1)}`]))
  const u = new URL(invitation.uri); u.searchParams.set('data', Buffer.from(JSON.stringify({ ...pairing, ticket: ticket.toString() })).toString('base64url')); uri = u.href
}
const config = JSON.stringify({ uri, endpointId: status.endpointId, workspaceId: initial.workspaceId, run: randomUUID() })
await phone(['shell', 'run-as', pkg, 'rm', '-f', 'files/hl-interaction-qa-status.json', 'files/hl-interaction-failure.png', 'files/hl-interaction-failure.xml'])
await phone(['shell', `run-as ${pkg} sh -c 'umask 077; mkdir -p files; cat > files/hl-interaction-qa.json'`], config)
await writeFile(join(directory, 'result.json'), JSON.stringify({ ok: null, modes, stage: 'starting' }, null, 2), { mode: 0o600 })
let output = '', finished = false, exitCode
const child = spawn(adb, ['-s', serial, 'shell', 'am', 'instrument', '-w', '-r', '-e', 'HL_INTERACTION_QA', '1', ...(onlyMode ? ['-e', 'HL_ONLY_MODE', onlyMode] : []),
  ...(serial.startsWith('emulator-') && ['conversation', 'changes'].includes(onlyMode) ? ['-e', 'HL_EMULATOR_VIEWPORTS', '1'] : []),
  '-e', 'class', `${pkg}.HLInteractionsFlowTest`, `${pkg}.test/androidx.test.runner.AndroidJUnitRunner`], { stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
child.on('close', code => { finished = true; exitCode = code })
const acted = new Set()
let approvedDevice
let lastStage
try {
  const deadline = Date.now() + 12 * 60_000
  while (!finished && Date.now() < deadline) {
    const s = await management('status')
    const pending = (s.pending ?? []).find(p => p.pairingId === pairing.pairingId && p.platform === 'android' && p.name === 'Android interaction QA')
    if (pending) { await management('confirmDevice', { requestId: pending.requestId, approved: true }); approvedDevice = pending.deviceId }
    let progress
    try { progress = JSON.parse(await phone(['exec-out', 'run-as', pkg, 'cat', 'files/hl-interaction-qa-status.json'])) } catch { /* The Activity may still be starting. */ }
    if (progress?.stage !== lastStage && progress?.stage) { lastStage = progress.stage; console.log(`Phone QA: ${lastStage}`) }
    if (progress?.stage === 'needs-unlock') throw new Error('PHONE_LOCKED: unlock the connected phone and rerun')
    if (['desktop-visible', 'cancel-visible'].includes(progress?.stage) && !acted.has(progress.sessionId)) {
      const state = await hostState(); const frame = state.desktop[progress.sessionId]
      if (frame) {
        if (progress.stage === 'desktop-visible') await rpc('$events/result', { args: { clientId: frame.clientId, eventId: frame.eventId, outcome: { kind: 'result', value: 'rejected' } } })
        else await rpc('session/cancel', { args: { request: { sessionId: progress.sessionId } } })
        acted.add(progress.sessionId)
      }
    }
    await delay(150)
  }
  if (!finished) { child.kill('SIGTERM'); throw new Error('Timed out waiting for the phone QA runner') }
  await writeFile(join(directory, 'android-instrumentation.log'), output, { mode: 0o600 })
  assert.equal(exitCode, 0)
  assert.match(output, /OK \(1 test\)/, 'Phone QA failed; see the ignored android-instrumentation.log')
  // Wait for each selected result to reach the real Session log, including late answers.
  let state
  for (let i = 0; i < 60; i++) {
    state = await hostState()
    const rows = Object.entries(state.sessions).filter(([id]) => !oldSessions.has(id))
    if (modes.every(mode => rows.some(([, s]) => s.mode === mode && (mode === 'timed' ? s.lateReply : s.ended)))) break
    await delay(100)
  }
  const entries = Object.entries(state.sessions).filter(([id]) => !oldSessions.has(id))
  const row = mode => entries.find(([, s]) => s.mode === mode)?.[1]
  const includes = mode => modes.includes(mode)
  for (const mode of modes) assert.ok(row(mode)?.ended, `The ${mode} turn must finish`)
  if (includes('approval')) assert.equal(row('approval')?.result, 'allowed-once')
  if (includes('reject')) assert.equal(row('reject')?.result, 'rejected')
  if (includes('desktop')) assert.equal(row('desktop')?.result, 'rejected')
  if (includes('reconnect')) assert.equal(row('reconnect')?.result, 'allowed-once')
  if (includes('permission')) assert.equal(row('permission')?.result?.answers?.[0]?.selected?.[0], 'grant-persistent')
  if (includes('plan')) assert.equal(row('plan')?.result?.answers?.[0]?.selected?.[0], '同意测试计划')
  const answers = mode => JSON.parse(row(mode)?.toolResult?.message?.content?.find(b => b.type === 'text')?.text ?? '{}').answers
  if (includes('questions')) {
    const batch = answers('questions')
    assert.deepEqual(batch?.find(a => a.id === 'scope')?.selected, ['消息同步', '权限确认'])
    assert.equal(batch?.find(a => a.id === 'note')?.custom, 'HL physical device answer')
  }
  if (includes('skip')) assert.deepEqual(answers('skip')?.[0]?.selected, [])
  if (includes('timed')) assert.ok(row('timed')?.lateReply)
  if (includes('conversation')) assert.equal(row('conversation')?.result?.verified, true)
  if (includes('changes')) { assert.equal(row('changes')?.result?.verified, true); assert.ok(row('changes')?.changes?.seq, 'The official Host must announce a change snapshot') }
  const audit = Object.values(state.audit).filter(a => entries.some(([id]) => id === a.sessionId))
  assert.ok(audit.every(a => a.decisions.length === 1), 'An approval may settle only once')
  const copied = []
  for (const name of [...['approval', 'permission', 'plan', 'questions', 'continued'].filter(name => includes(name === 'continued' ? 'timed' : name)), ...(includes('changes') ? ['changes-list', 'changes-diff', 'changes-landscape'] : [])]) {
    try {
      const bytes = await phoneBytes(['exec-out', 'run-as', pkg, 'cat', `files/hl-interaction-${name}.png`])
      await writeFile(join(directory, `android-${name}.png`), bytes, { mode: 0o600 })
      copied.push(name)
    } catch { /* Screenshot is diagnostic, not the pass condition. */ }
  }
  await writeFile(join(directory, 'result.json'), JSON.stringify({ ok: true, modes, singleApprovalSettlement: audit.every(a => a.decisions.length === 1), diagnostics: copied }, null, 2), { mode: 0o600 })
  console.log(`PASS: live Android ↔ DSH (${modes.join(', ')})`)
} catch (error) {
  await writeFile(join(directory, 'result.json'), JSON.stringify({ ok: false, modes, stage: lastStage }, null, 2), { mode: 0o600 })
  for (const extension of ['png', 'xml']) {
    try {
      const bytes = await phoneBytes(['exec-out', 'run-as', pkg, 'cat', `files/hl-interaction-failure.${extension}`])
      await writeFile(join(directory, `android-failure.${extension}`), bytes, { mode: 0o600 })
    } catch { /* A failure before Activity startup may have no UI diagnostic. */ }
  }
  throw error
} finally {
  if (!finished) child.kill('SIGTERM')
  await writeFile(join(directory, 'android-instrumentation.log'), output, { mode: 0o600 })
  const remaining = await hostState().catch(() => undefined)
  for (const [sessionId, row] of Object.entries(remaining?.sessions ?? {})) {
    if (!oldSessions.has(sessionId) && !row.ended) await rpc('session/cancel', { args: { request: { sessionId } } }).catch(() => {})
  }
  if (approvedDevice) await management('revokeDevice', { deviceId: approvedDevice }).catch(() => {})
  await phone(['shell', 'run-as', pkg, 'rm', '-f', 'files/hl-interaction-qa.json']).catch(() => {})
  await phone(['shell', 'am', 'start', '-n', `${pkg}/.HLMainActivity`]).catch(() => {})
}
