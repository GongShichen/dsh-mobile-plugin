#!/usr/bin/env node
// Native clients and the production Web panel, against HLStartPersonalQA's disposable Host.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { EndpointAddr, EndpointTicket } from '@number0/iroh'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); process.chdir(root)
const args = process.argv.slice(2); const mode = args.shift()
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1] }
const directory = resolve(option('--directory', '.local/personal-qa/current'))
const mobile = resolve(option('--mobile', '../dsh-mobile'))
if (!['web', 'android', 'ios'].includes(mode)) throw new Error('Use web, android --device SERIAL, or ios --simulator UUID')
const auth = JSON.parse(await readFile(join(directory, 'auth.json'), 'utf8'))
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(auth.origin).hostname))
const initial = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))
const output = join(directory, mode); await mkdir(output, { recursive: true, mode: 0o700 })
async function rpc(method, payload = {}) {
  const response = await fetch(`${auth.origin}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: auth.cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }), signal: AbortSignal.timeout(15_000) })
  const result = (await response.json()).result
  if (!result?.ok) throw new Error(`QA Host rejected ${method}: ${result?.error?.message || response.status}`)
  return result.value
}
const management = (name, params) => rpc('mobileAccess/' + name, params)
const hostStatus = await management('status')
assert.equal(hostStatus.hostName, 'Harness Link Personal QA', 'Refusing to test a user profile')
assert.equal(hostStatus.endpointId, initial.endpointId, 'The QA state must belong to this exact Host')
function run(command, argv, input, binary = false) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, argv, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks = []; let errors = ''
    child.stdout.on('data', data => chunks.push(data)); child.stderr.on('data', data => { errors += data })
    child.on('error', reject); child.on('close', code => code === 0 ? resolveRun(binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString()) : reject(new Error(`Command failed (${code}): ${errors.slice(-500)}`)))
    child.stdin.end(input)
  })
}
async function invitation(android = false) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const value = await management('startPairing'); if (!android) return value.uri
    const payload = JSON.parse(Buffer.from(new URL(value.uri).searchParams.get('data'), 'base64url').toString())
    const addr = EndpointTicket.fromString(payload.ticket).endpointAddr()
    const local = addr.directAddresses().find(address => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address))
    if (!local) { await delay(250); continue }
    const ticket = EndpointTicket.fromAddr(new EndpointAddr(addr.id(), undefined, [`10.0.2.2:${local.split(':').at(-1)}`]))
    const url = new URL(value.uri); url.searchParams.set('data', Buffer.from(JSON.stringify({ ...payload, ticket: ticket.toString() })).toString('base64url')); return url.href
  }
  throw new Error('The Host has no private UDP route for this emulator')
}
await writeFile(join(output, 'result.json'), JSON.stringify({ ok: null, mode, startedAt: new Date().toISOString() }), { mode: 0o600 })
try {
if (mode === 'android') {
  const serial = option('--device'); assert.ok(serial, 'Choose an explicit adb device')
  const adb = join(process.env.ANDROID_SDK_ROOT || join(process.env.HOME, 'Library/Android/sdk'), 'platform-tools/adb')
  const pkg = 'org.harnesslink.app'
  await run(adb, ['-s', serial, 'install', '-r', join(mobile, 'androidApp/build/outputs/apk/debug/androidApp-debug.apk')])
  await run(adb, ['-s', serial, 'install', '-r', join(mobile, 'androidApp/build/outputs/apk/androidTest/debug/androidApp-debug-androidTest.apk')])
  const config = { ...initial, uri: await invitation(serial.startsWith('emulator-')) }
  await run(adb, ['-s', serial, 'shell', `run-as ${pkg} sh -c 'umask 077; mkdir -p files; cat > files/hl-personal-qa.json'`], JSON.stringify(config))
  const log = await run(adb, ['-s', serial, 'shell', 'am', 'instrument', '-w', '-r', '-e', 'HL_PERSONAL_QA', '1', '-e', 'class', `${pkg}.HLPersonalFlowTest`, `${pkg}.test/androidx.test.runner.AndroidJUnitRunner`])
  await writeFile(join(output, 'instrumentation.log'), log.replaceAll(config.uri, '[one-use invitation]'), { mode: 0o600 })
  for (const name of ['assistant', 'offline', 'tasks', 'opened-session', 'failure']) {
    try {
      const bytes = await run(adb, ['-s', serial, 'exec-out', 'run-as', pkg, 'cat', `files/hl-personal-${name}.png`], undefined, true)
      if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) await writeFile(join(output, `${name}.png`), bytes)
    } catch { /* Optional failure capture. */ }
  }
  assert.match(log, /OK \(1 test\)/, 'See the private instrumentation.log')
} else if (mode === 'ios') {
  const simulator = option('--simulator'); assert.ok(simulator, 'Choose an explicit iOS simulator')
  const products = join(mobile, '.local/DerivedData/Build/Products')
  const source = option('--test-run', (await readdir(products)).filter(name => name.endsWith('.xctestrun')).map(name => join(products, name)).at(-1))
  assert.ok(source, 'Run xcodebuild build-for-testing first')
  const config = { uri: await invitation() }
  const priorTasks = new Set((await rpc('personalAccess/snapshot')).tasks.map(task => task.id))
  const base = JSON.parse(await run('plutil', ['-convert', 'json', '-o', '-', source]))
  function absolutePaths(value) {
    if (typeof value === 'string') return value.replaceAll('__TESTROOT__', dirname(source))
    if (Array.isArray(value)) return value.map(absolutePaths)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, row]) => [key, absolutePaths(row)]))
    return value
  }
  const configured = absolutePaths(base)
  const targets = configured.TestConfigurations?.flatMap(row => row.TestTargets || []) || Object.values(configured).filter(row => row && typeof row === 'object' && row.TestBundlePath)
  const target = targets.find(row => row.BlueprintName === 'HLAppUITests' || String(row.TestBundlePath).includes('HLAppUITests.xctest'))
  assert.ok(target)
  target.EnvironmentVariables = { ...target.EnvironmentVariables, HL_IOS_PERSONAL_QA: JSON.stringify(config) }
  target.OnlyTestIdentifiers = ['HLPersonalFlowTests/testModesAndTaskManagement']; target.SkipTestIdentifiers = []
  const testRun = join(output, 'HLPersonal.xctestrun')
  await writeFile(testRun, JSON.stringify(configured), { mode: 0o600 })
  await run('plutil', ['-convert', 'xml1', testRun])
  const result = join(output, `HLPersonal-${Date.now()}.xcresult`)
  // xcodebuild can print UI text (including the private invitation); keep its output in a private, redacted log.
  const child = spawn('xcodebuild', ['test-without-building', '-xctestrun', testRun, '-destination', `platform=iOS Simulator,id=${simulator}`, '-resultBundlePath', result,
    '-only-testing:HLAppUITests/HLPersonalFlowTests/testModesAndTaskManagement'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  const append = async chunk => { log += chunk; await writeFile(join(output, 'xcode.log'), log.replaceAll(config.uri, '[one-use invitation]'), { mode: 0o600 }) }
  child.stdout.on('data', append); child.stderr.on('data', append)
  const code = await new Promise(resolveCode => child.once('close', resolveCode))
  await writeFile(join(output, 'xcode.log'), log.replaceAll(config.uri, '[one-use invitation]'), { mode: 0o600 })
  assert.equal(code, 0, 'See the private xcode.log and xcresult')
  let verified = false
  for (let attempt = 0; attempt < 80; attempt++) {
    const tasks = (await rpc('personalAccess/snapshot')).tasks
    if (tasks.some(task => !priorTasks.has(task.id) && task.title === 'HL QA 对话交办' && task.state === 'completed')) { verified = true; break }
    await delay(250)
  }
  assert.ok(verified, 'iOS must create and finish its own actual Personal task')
} else {
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' })
    const pair = auth.cookie.split(';')[0]; const separator = pair.indexOf('=')
    await context.addCookies([{ name: pair.slice(0, separator), value: pair.slice(separator + 1), url: auth.origin, httpOnly: true, sameSite: 'Strict' }])
    const page = await context.newPage(); const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${auth.origin}/api/hlPersonalQA/page`, { waitUntil: 'networkidle' })
    await page.getByRole('heading', { name: '我的助理', exact: true }).waitFor()
    await page.getByLabel('名称', { exact: true }).fill('Web QA 内部成果')
    await page.getByLabel('需要完成什么').fill('保存可核验的结果文件。')
    await page.getByLabel('交付结果').selectOption('files')
    await page.getByRole('button', { name: '交给助理', exact: true }).click()
    const card = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Web QA 内部成果', exact: true }) })
    await card.getByText('已完成', { exact: true }).waitFor({ timeout: 40_000 })
    await card.getByRole('button', { name: '打开执行会话' }).click()
    assert.ok(await page.locator('#opened').textContent())
    await page.screenshot({ path: join(output, 'tasks-wide.png'), fullPage: true })
    await page.getByRole('tab', { name: '目标', exact: true }).click()
    await page.getByRole('heading', { name: '阅读与学习', exact: true }).waitFor()
    await page.screenshot({ path: join(output, 'goals-wide.png'), fullPage: true })
    await page.getByRole('tab', { name: '记忆', exact: true }).click()
    await page.getByLabel('记住的内容').fill('我喜欢简短的工作摘要。')
    await page.getByRole('button', { name: '保存记忆', exact: true }).click()
    const memory = page.locator('article').filter({ hasText: '我喜欢简短的工作摘要。' })
    await memory.getByRole('button', { name: '修改', exact: true }).click()
    await memory.getByLabel('记住的内容').fill('我更喜欢先看到结论。')
    await page.getByRole('button', { name: '保存修改', exact: true }).click()
    await page.getByText('我更喜欢先看到结论。', { exact: true }).waitFor()
    await page.screenshot({ path: join(output, 'memory-wide.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark' })
    await page.getByRole('tab', { name: '事务', exact: true }).click()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'No horizontal overflow')
    await page.screenshot({ path: join(output, 'tasks-narrow-dark.png'), fullPage: true })
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
}
await writeFile(join(output, 'result.json'), JSON.stringify({ ok: true, mode, testedAt: new Date().toISOString() }), { mode: 0o600 })
console.log(`${mode} Personal QA passed. Captures: ${output}`)
} catch (error) {
  await writeFile(join(output, 'result.json'), JSON.stringify({ ok: false, mode, testedAt: new Date().toISOString(), error: error instanceof Error ? error.message : 'QA failed' }), { mode: 0o600 })
  throw error
}
