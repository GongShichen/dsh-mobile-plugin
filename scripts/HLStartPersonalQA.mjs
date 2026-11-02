#!/usr/bin/env node
// Disposable, local-only official DSH Host. Never points at an existing user profile.
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)
const runtimeRoot = resolve('.local/dsh-runtime')
const runtime = join(runtimeRoot, 'node_modules/.bin/dsh')
if (!existsSync(runtime)) throw new Error('Install the pinned official DSH package in .local/dsh-runtime first')
await mkdir('.local/personal-qa', { recursive: true, mode: 0o700 })
const index = process.argv.indexOf('--directory')
const directory = index < 0 ? await mkdtemp(resolve('.local/personal-qa/run-')) : resolve(process.argv[index + 1])
if (relative(resolve('.local'), directory).startsWith('..')) throw new Error('QA output must stay in the ignored .local directory')
await mkdir(directory, { recursive: true, mode: 0o700 })
if (existsSync(join(directory, 'home'))) throw new Error('Use a new QA directory; existing profiles are never reused')
const entry = join(directory, 'HLFixture.mjs'); const preview = join(directory, 'HLPreview.js')
await build({ entryPoints: ['tests/fixtures/HLPersonalClientFixture.ts'], outfile: entry, bundle: true, format: 'esm', platform: 'node', packages: 'external', target: 'node24' })
await build({ entryPoints: ['src/personal/HLPersonalScope.ts'], outfile: join(directory, 'HLPersonalScope.js'), bundle: true, format: 'esm', platform: 'node', packages: 'external', target: 'node24' })
await build({ entryPoints: ['tests/fixtures/HLPersonalPreview.tsx'], outfile: preview, bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', target: 'es2022', define: { 'process.env.NODE_ENV': '"production"' } })
const overlay = join(directory, 'overlay.yml')
await writeFile(overlay, JSON.stringify([{ insert: [{ id: 'hl-personal-client-qa', name: entry, config: { directory, runtimeRoot, preview } }] }]))
const log = createWriteStream(join(directory, 'host.log'), { mode: 0o600 })
const child = spawn(runtime, ['web', '--patch', overlay, '--no-open', '--port', '0'], { env: { ...process.env, DSH_HOME: join(directory, 'home') }, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''; let closed = false
child.stdout.on('data', chunk => { output += chunk }); child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
child.on('close', () => { closed = true; log.end() })
await writeFile(join(directory, 'host.pid'), String(child.pid), { mode: 0o600 })
const stop = () => { child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 5000); force.unref() }
process.once('SIGINT', stop); process.once('SIGTERM', stop)
let authenticated = false
const deadline = Date.now() + 65_000
while (!closed && Date.now() < deadline) {
  const bootstrap = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0]
  if (bootstrap && !authenticated) {
    const response = await fetch(bootstrap, { redirect: 'manual' })
    const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    if (!cookie) throw new Error('Owner bootstrap returned no authentication cookie')
    await writeFile(join(directory, 'auth.json'), JSON.stringify({ origin: new URL(bootstrap).origin, cookie }), { mode: 0o600 })
    authenticated = true; output = ''
  }
  if (existsSync(join(directory, 'failure.json'))) { stop(); throw new Error(await readFile(join(directory, 'failure.json'), 'utf8')) }
  if (authenticated && existsSync(join(directory, 'state.json'))) {
    console.log(`Personal QA ready: ${directory}`)
    console.log('Uses a disposable profile, a deterministic model, and memory-only test credentials.')
    break
  }
  await delay(150)
}
if (!authenticated || !existsSync(join(directory, 'state.json'))) { stop(); throw new Error('QA Host failed to become ready; inspect its private host.log') }
await new Promise(resolveClose => child.once('close', resolveClose))
