import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'

const runtime = resolve('.local/dsh-runtime/node_modules/.bin/dsh')
test('Personal native presets, verified artifacts and existing Workspace delegation use the real Host', {
  skip: !existsSync(runtime) && 'Install the pinned isolated DSH runtime', timeout: 65_000,
}, async () => {
  await mkdir('.local/personal-smoke', { recursive: true })
  const directory = await mkdtemp(resolve('.local/personal-smoke/run-'))
  const fixture = join(directory, 'HLFixture.mjs'); const scopeEntry = join(directory, 'HLPersonalScope.mjs'); const resultPath = join(directory, 'result.json')
  await build({ entryPoints: ['tests/fixtures/HLPersonalDSHFixture.ts'], outfile: fixture, bundle: true, format: 'esm', platform: 'node', target: 'node24', packages: 'external' })
  await build({ entryPoints: ['src/personal/HLPersonalScope.ts'], outfile: scopeEntry, bundle: true, format: 'esm', platform: 'node', target: 'node24', packages: 'external' })
  const overlay = join(directory, 'overlay.yml')
  await writeFile(overlay, JSON.stringify([{ insert: [{ id: 'hl-personal-fixture', name: fixture,
    config: { directory, resultPath, runtimeRoot: resolve('.local/dsh-runtime'), scopeEntry } }] }]))
  const log = createWriteStream(join(directory, 'host.log'), { mode: 0o600 })
  const child = spawn(runtime, ['web', '--patch', overlay, '--no-open', '--port', '0'], { env: { ...process.env, DSH_HOME: join(directory, 'home') }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
  try {
    const end = Date.now() + 55_000
    while (!existsSync(resultPath)) {
      if (child.exitCode !== null || Date.now() > end) throw new Error('Personal Host fixture did not finish: ' + (await readFile(join(directory, 'host.log'), 'utf8')).slice(-7000))
      await delay(100)
    }
    const result = JSON.parse(await readFile(resultPath, 'utf8')) as { ok: boolean; checks: string[]; error?: string; snapshot?: unknown }
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(result.checks, ['presets.install', 'assistant.open', 'worker.nativeToolsAndReport', 'worker.checkpointAndArtifact', 'worker.nativeOwnerContinuation', 'workspace.actualDirectoryAndSession', 'session.continueWithoutReplacingPreset', 'schedule.receiptCreatesOneTask', 'schedule.unknownOutcomeReconciles'])
  } finally {
    if (child.exitCode === null) {
      const done = once(child, 'close'); child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 4000); force.unref()
      try { await done } finally { clearTimeout(force) }
    }
    await new Promise<void>(resolve => log.end(resolve))
    // Failed runs remain in ignored .local for diagnosis; successful runs contain no user data.
  }
})
