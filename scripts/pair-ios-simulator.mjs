#!/usr/bin/env node
// Test helper for the isolated .local/integration host. Invitations never enter argv or logs.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const directory = join(root, '.local/integration')
const args = process.argv.slice(2)
const mode = args.shift()
const option = name => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
if (!['create', 'approve', 'status'].includes(mode)) {
  console.error('Usage: node scripts/pair-ios-simulator.mjs create [--simulator booted|UUID]\n       node scripts/pair-ios-simulator.mjs approve [--name device-name] [--timeout-ms 240000]\n       node scripts/pair-ios-simulator.mjs status')
  process.exit(2)
}

const { origin, cookie } = JSON.parse(await readFile(join(directory, 'auth.json'), 'utf8'))
const parsedOrigin = new URL(origin)
if (parsedOrigin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsedOrigin.hostname)) {
  throw new Error('The simulator helper only operates on the isolated loopback host')
}

async function management(method, payload = {}) {
  const response = await fetch(`${origin}/api/mobileAccess/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: `mobileAccess/${method}`, payload }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Desktop management HTTP ${response.status}`)
  const envelope = await response.json()
  if (envelope.result?.ok !== true) throw new Error(`Desktop management rejected ${method}`)
  return envelope.result.value
}

async function privateJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await chmod(path, 0o600)
}

async function simulatorClipboard(simulator, invitation) {
  await new Promise((resolveRun, reject) => {
    const child = spawn('xcrun', ['simctl', 'pbcopy', simulator], { stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('error', () => reject(new Error('Could not start simctl')))
    child.on('close', code => code === 0 ? resolveRun() : reject(new Error(`simctl clipboard failed (${code})`)))
    child.stdin.end(invitation)
  })
}

if (mode === 'create') {
  const invitation = await management('startPairing')
  if (typeof invitation.uri !== 'string') throw new Error('Desktop did not return an invitation')
  const data = new URL(invitation.uri).searchParams.get('data')
  const payload = JSON.parse(Buffer.from(data ?? '', 'base64url').toString('utf8'))
  await privateJson(join(directory, 'ios-pairing.json'), { uri: invitation.uri, pairingId: payload.pairingId, expiresAt: invitation.expiresAt })
  const simulator = option('--simulator')
  if (simulator !== undefined) await simulatorClipboard(simulator, invitation.uri)
  console.log(JSON.stringify({ ready: true, invitationFile: join(directory, 'ios-pairing.json'),
    clipboard: simulator === undefined ? 'not changed' : 'simulator only', expiresAt: invitation.expiresAt }))
} else if (mode === 'approve') {
  const invitation = JSON.parse(await readFile(join(directory, 'ios-pairing.json'), 'utf8'))
  const timeout = Number(option('--timeout-ms') ?? 240_000)
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 300_000) throw new Error('timeout-ms must be 1000..300000')
  const expectedName = option('--name')
  const deadline = Math.min(Date.now() + timeout, invitation.expiresAt)
  let approved = false
  while (Date.now() < deadline) {
    const status = await management('status')
    const matches = (status.pending ?? []).filter(request => request.platform === 'ios'
      && request.pairingId === invitation.pairingId && (expectedName === undefined || request.name === expectedName))
    if (matches.length > 1) throw new Error('More than one iOS device used this invitation; select --name explicitly')
    if (matches.length === 1) {
      const request = matches[0]
      await management('confirmDevice', { requestId: request.requestId, approved: true })
      const result = { approved: true, deviceId: request.deviceId, name: request.name, platform: request.platform }
      await privateJson(join(directory, 'ios-pairing-result.json'), result)
      console.log(JSON.stringify(result))
      approved = true
      break
    }
    await delay(250)
  }
  if (!approved) throw new Error('Timed out waiting for the intended simulator pairing request')
} else {
  const status = await management('status')
  console.log(JSON.stringify({ running: status.running, hostName: status.hostName,
    devices: (status.devices ?? []).map(({ id, deviceId, name, platform }) => ({ deviceId: deviceId ?? id, name, platform })),
    pending: (status.pending ?? []).map(({ name, platform }) => ({ name, platform })),
    connections: (status.connections ?? []).length }))
}
