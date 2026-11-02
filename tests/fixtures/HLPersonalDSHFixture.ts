/** Runs only inside a disposable official DSH profile. No real provider or account is used. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { HLPersonalRuntime } from '../../src/personal/HLPersonalRuntime.ts'
import type { HLPersonalDSHHost } from '../../src/personal/dsh/HLDSHHost.ts'

export const name = 'hl-personal-dsh-fixture'
export const inject = ['connection', 'typertGateway', 'agents', 'sessions', 'sessionQuery', 'sessionController', 'workspaceController',
  'agentPresets', 'tools', 'systemPrompt', 'llm', 'agentDefaultModel']

interface HLFixtureHost extends HLPersonalDSHHost {
  llm: { registerAdapter(names: string[], adapter: unknown): void }
  agentDefaultModel: { saveSelection(selection: { provider: string; model: string }): Promise<void> }
  effect(factory: () => (() => Promise<void>)): unknown
  on(name: string, callback: (...args: unknown[]) => void, options: { global: true }): unknown
}

export function apply(host: HLFixtureHost, config: { directory: string; resultPath: string; runtimeRoot: string; scopeEntry: string }): void {
  // Preset diagnostics await the Host Loader. Let this fixture's Loader entry settle first.
  setTimeout(() => { void hlRunPersonalFixture(host, config) }, 0)
}
async function hlRunPersonalFixture(host: HLFixtureHost, config: { directory: string; resultPath: string; runtimeRoot: string; scopeEntry: string }): Promise<void> {
  const checks: string[] = []
  const secrets = new Map<string, string>()
  const personal = new HLPersonalRuntime({ directory: join(config.directory, 'personal'), scopeEntry: config.scopeEntry,
    secrets: { async get(key) { return secrets.get(key) }, async set(key, value) { secrets.set(key, value) }, async delete(key) { secrets.delete(key) } } })
  let closing = false
  host.effect(() => async () => { closing = true; await personal.stop() })
  host.on('session/event', (...args) => {
    if (!closing) personal.framework.observe((args[0] as { id: string }).id, args[1] as Parameters<typeof personal.framework.observe>[1])
  }, { global: true })
  const load = (name: string) => import(pathToFileURL(join(config.runtimeRoot, 'node_modules', name, 'lib/index.js')).href)
  try {
    const llm = await load('@deepseek-ai/dsh-llm')
    class HLPersonalFixtureAdapter extends llm.LlmAdapter {
      private readonly rounds = new Map<string, number>()
      async listModels(provider: string) { return [{ provider, id: 'hl-personal-fixture', name: 'HL Personal fixture' }] }
      async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
      async *stream(options: { purpose?: string; sessionId?: string; tools?: Array<{ name: string }> }): AsyncIterable<unknown> {
        const sid = String(options.sessionId)
        const worker = options.tools?.some(tool => tool.name === 'hl_personal_task_report') === true
        const round = worker ? (this.rounds.get(sid) ?? 0) + 1 : 0
        if (worker) this.rounds.set(sid, round)
        let tool: { name: string; arguments: string } | undefined
        if (worker && round === 1) tool = { name: 'hl_personal_write_artifact', arguments: JSON.stringify({ name: 'HLResult.txt', content: 'Harness Link personal result\n' }) }
        if (worker && (round === 2 || round === 4)) tool = { name: 'hl_personal_task_report', arguments: JSON.stringify({ outcome: 'ready', summary: '隔离事务已完成并写入成果文件', artifacts: ['HLResult.txt'], actionIds: [] }) }
        if (tool) {
          const id = `hl-personal-${round === 4 ? 2 : round}` // Provider call ids may repeat in a later native turn.
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id, name: tool.name, argumentsDelta: tool.arguments }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, ...tool } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        } else {
          const text = options.purpose ? 'HL fixture' : '会话执行已完成。'
          yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }; yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
    }
    host.llm.registerAdapter(['hl-personal-fixture'], new HLPersonalFixtureAdapter())
    await host.agentDefaultModel.saveSelection({ provider: 'hl-personal-fixture', model: 'hl-personal-fixture' })
    await personal.attach(host)
    checks.push('presets.install')
    const framework = personal.framework
    const actor = { deviceId: 'fixture-owner', desktop: true }
    const call = (name: string, params: Record<string, unknown> = {}) => framework.invoke('personal.' + name, { operationId: `fixture-${checks.length}-${name}`, ...params }, actor, new AbortController().signal)
    await call('configure', { revision: framework.profile().revision, enabled: true })
    await call('open')
    async function until(predicate: () => boolean) {
      const deadline = Date.now() + 20_000
      while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Timed out: ' + JSON.stringify(framework.snapshot().tasks))
        await framework.tick(); await delay(40)
      }
    }
    await until(() => framework.profile().mainSessionReady === true)
    const main = host.agents.get(framework.profile().mainSessionId!)!
    main.model.select({ provider: 'hl-personal-fixture', model: 'hl-personal-fixture' })
    checks.push('assistant.open')
    const first = await call('createTask', { title: '内部成果', instruction: '创建测试成果文件' }) as { id: string }
    await until(() => framework.snapshot().tasks.find(row => row.id === first.id)?.state === 'completed')
    checks.push('worker.nativeToolsAndReport', 'worker.checkpointAndArtifact')
    const internalSession = framework.snapshot().tasks.find(row => row.id === first.id)!.binding!.sessionId
    const owner = host.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
    try {
      await host.typertGateway.invoke({ namespace: 'session', method: 'prompt', args: { request: { sessionId: internalSession,
        requestId: 'fixture-native-owner-continue', mode: 'queue', content: [{ type: 'text', text: '继续核对已有成果，不重复创建文件。' }] } }, peer: owner })
      await until(() => framework.snapshot().tasks.some(row => row.id === first.id && row.attempt === 2 && row.state === 'completed'))
      checks.push('worker.nativeOwnerContinuation')
    } finally { await owner.dispose() }
    const workspacePath = join(config.directory, 'workspace'); await mkdir(workspacePath, { recursive: true })
    const peer = host.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
    try {
      const created = await host.typertGateway.invoke({ namespace: 'workspace', method: 'create', args: { request: { path: workspacePath } }, peer }) as { workspace: { workspaceId: string } }
      const second = await call('createTask', { operationId: 'new-workspace-task', title: '工作区新会话', instruction: '返回测试确认', target: { kind: 'workspace-new', workspaceId: created.workspace.workspaceId } }) as { id: string }
      await until(() => framework.snapshot().tasks.find(row => row.id === second.id)?.state === 'waiting')
      const secondRow = framework.snapshot().tasks.find(row => row.id === second.id)!
      assert.equal(secondRow.waitReason, 'verification')
      assert.equal(secondRow.binding?.cwd, workspacePath)
      assert.equal(secondRow.binding?.workspaceId, created.workspace.workspaceId)
      assert.equal(secondRow.binding?.ownership, 'created')
      checks.push('workspace.actualDirectoryAndSession')
      await call('confirmTask', { taskId: second.id, revision: secondRow.revision })
      const sid = secondRow.binding!.sessionId
      const preset = secondRow.binding?.agentPreset
      const third = await call('createTask', { operationId: 'continue-workspace-task', title: '继续原会话', instruction: '继续并返回测试确认', target: { kind: 'session-continue', sessionId: sid, workspaceId: created.workspace.workspaceId } }) as { id: string }
      await until(() => framework.snapshot().tasks.find(row => row.id === third.id)?.state === 'waiting')
      const thirdRow = framework.snapshot().tasks.find(row => row.id === third.id)!
      assert.equal(thirdRow.binding?.sessionId, sid)
      assert.equal(thirdRow.binding?.agentPreset, preset)
      assert.equal(thirdRow.binding?.ownership, 'borrowed')
      checks.push('session.continueWithoutReplacingPreset')
      const rule = await call('createRoutine', { title: 'HL one-shot fixture', instruction: '创建测试成果文件', timing: { kind: 'after', after_seconds: 1 } }) as { id: string }
      await until(() => framework.snapshot().tasks.some(row => row.source.kind === 'routine' && row.source.id === rule.id && row.state === 'completed'))
      checks.push('schedule.receiptCreatesOneTask')
      const stored = personal.store.get('routine', rule.id)!
      personal.store.transaction(() => personal.store.put('routine', { ...stored, state: 'unknown', scheduleId: undefined, revision: stored.revision + 1 }))
      const reconciled = await call('reconcileRoutine', { routineId: rule.id, revision: stored.revision + 1 }) as { scheduleId?: string }
      assert.equal(reconciled.scheduleId, stored.scheduleId)
      assert.equal(framework.snapshot().tasks.filter(row => row.source.kind === 'routine' && row.source.id === rule.id).length, 1)
      checks.push('schedule.unknownOutcomeReconciles')
    } finally { await peer.dispose() }
    await writeFile(config.resultPath, JSON.stringify({ ok: true, checks, snapshot: framework.snapshot() }))
  } catch (error) {
    await writeFile(config.resultPath, JSON.stringify({ ok: false, checks, error: String(error), stack: error instanceof Error ? error.stack : undefined, snapshot: personal.framework.snapshot() }))
  }
}
