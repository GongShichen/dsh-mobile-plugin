import assert from 'node:assert/strict'
import { existsSync, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { build } from 'esbuild'

const runtime = resolve('.local/dsh-runtime/node_modules/.bin/dsh')

test('adapter calls real DSH session, workspace, file and upload services in an isolated profile', {
  skip: !existsSync(runtime) && 'Install the pinned DSH in .local/dsh-runtime to run this integration test',
  timeout: 45_000,
}, async () => {
  await mkdir('.local/smoke-runs', { recursive: true })
  const directory = await mkdtemp(resolve('.local/smoke-runs/run-'))
  const fixture = join(directory, 'fixture.mjs')
  const resultPath = join(directory, 'result.json')
  await build({ entryPoints: ['tests/fixtures/dsh-bridge-smoke.ts'], outfile: fixture, bundle: true,
    format: 'esm', platform: 'node', target: 'node24' })
  const overlay = join(directory, 'overlay.yml')
  await writeFile(overlay, JSON.stringify([{ insert: [{ id: 'mobile-bridge-smoke', name: fixture,
    config: { directory: join(directory, 'work'), resultPath, runtimeRoot: resolve('.local/dsh-runtime') } }] }]))
  const log = createWriteStream(join(directory, 'host.log'), { mode: 0o600 })
  const child = spawn(runtime, ['web', '--patch', overlay, '--no-open', '--port', '0'], {
    env: { ...process.env, DSH_HOME: join(directory, 'home') }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  let spawnFailure: Error | undefined
  child.on('error', error => { spawnFailure = error })
  try {
    const deadline = Date.now() + 35_000
    while (!existsSync(resultPath)) {
      if (spawnFailure !== undefined) throw spawnFailure
      if (child.exitCode !== null) throw new Error(`Isolated DSH exited with ${child.exitCode}`)
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the isolated DSH fixture')
      await delay(100)
    }
    const captured = await readFile(resultPath, 'utf8')
    await writeFile('.local/dsh-captured-turn.json', captured, { mode: 0o600 })
    const result = JSON.parse(captured) as { ok: boolean; checks: string[]; error?: string }
    assert.equal(result.ok, true, result.error)
    assert.deepEqual(result.checks, [
      'workspace.create', 'session.create', 'session.list', 'session.rename', 'session.state',
      'workspaceFiles.list', 'workspaceFiles.read', 'workspaceFiles.readBytes', 'fileUploads.binaryReceipt',
      'session.follow.snapshot', 'session.prompt.idempotent', 'agentLoop.reasoningAndText', 'tool.approvalAndResult',
      'session.follow.realTurn', 'workspace.archiveAndUnarchive',
    ])
  } finally {
    if (child.exitCode === null) {
      const closed = once(child, 'close')
      child.kill('SIGTERM')
      const force = setTimeout(() => child.kill('SIGKILL'), 3000)
      force.unref()
      try { await closed } finally { clearTimeout(force) }
    }
    await new Promise<void>(resolve => log.end(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
