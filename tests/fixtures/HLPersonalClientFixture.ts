/** Explicitly opt-in, credential-free Host for Android/iOS/Web regression. Never load on a user profile. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { applyWithDependencies, HLConfig, type HLHostContext } from '../../src/HLPlugin.js'
import { HLRuntime } from '../../src/transport/HLRuntime.js'
import { HLPersonalRuntime } from '../../src/personal/HLPersonalRuntime.js'
import type { HLPersonalDSHHost } from '../../src/personal/dsh/HLDSHHost.js'

export const name = 'hl-personal-client-fixture'
export const inject = ['connection', 'typertGateway', 'agents', 'sessions', 'sessionQuery', 'sessionController', 'workspaceController',
  'agentPresets', 'tools', 'systemPrompt', 'llm', 'agentDefaultModel']
type HLFixtureHost = HLHostContext & HLPersonalDSHHost & {
  llm: { registerAdapter(names: string[], adapter: unknown): void }
  agentDefaultModel: { saveSelection(selection: { provider: string; model: string }): Promise<void> }
}
interface HLFixtureConfig { directory: string; runtimeRoot: string; preview: string }
export function apply(host: HLFixtureHost, config: HLFixtureConfig): void {
  setTimeout(() => { void start(host, config).catch(async error => {
    await writeFile(join(config.directory, 'failure.json'), JSON.stringify({ error: String(error), stack: error instanceof Error ? error.stack : undefined }), { mode: 0o600 })
  }) }, 0)
}
async function start(host: HLFixtureHost, config: HLFixtureConfig) {
  const directory = config.directory
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const llm = await import(pathToFileURL(join(config.runtimeRoot, 'node_modules/@deepseek-ai/dsh-llm/lib/index.js')).href)
  class HLFixtureModel extends llm.LlmAdapter {
    private readonly rounds = new Map<string, number>()
    private readonly delegated = new Set<string>()
    async listModels(provider: string) { return [{ provider, id: 'hl-personal-qa', name: 'HL Personal QA' }] }
    async resolveModel(provider: string, id: string) { return { provider, id, name: 'HL Personal QA', context: { contextWindow: 1_000_000 }, reasoning: { efforts: [{ id: 'high', name: '高' }, { id: 'low', name: '低' }], defaultEffort: 'high' } } }
    async *stream(options: { purpose?: string; sessionId?: string; messages?: unknown; tools?: Array<{ name: string }>; signal?: AbortSignal }): AsyncIterable<unknown> {
      const sid = String(options.sessionId)
      const worker = !options.purpose && options.tools?.some(row => row.name === 'hl_personal_task_report')
      const round = worker ? (this.rounds.get(sid) || 0) + 1 : 0
      if (worker) this.rounds.set(sid, round)
      let tool: { name: string; arguments: string } | undefined
      if (worker && round === 1) tool = { name: 'hl_personal_write_artifact', arguments: JSON.stringify({ name: 'HLResult.txt', content: 'Harness Link isolated Personal QA result.\n' }) }
      if (worker && round === 2) tool = { name: 'hl_personal_task_report', arguments: JSON.stringify({ outcome: 'ready', summary: '已整理好任务结果，并保存为 HLResult.txt。', artifacts: ['HLResult.txt'], actionIds: [] }) }
      const marker = [...JSON.stringify(options.messages).matchAll(/HL_QA:personal:([a-z0-9-]+)/g)].at(-1)?.[1]
      if (!options.purpose && !worker && marker && options.tools?.some(row => row.name === 'hl_personal_create_task') && !this.delegated.has(marker)) {
        this.delegated.add(marker)
        tool = { name: 'hl_personal_create_task', arguments: JSON.stringify({ title: 'HL QA 对话交办', instruction: '整理用户明确交办的测试内容', resultKind: 'files' }) }
      }
      if (!options.purpose) {
        const reasoning = '核对任务范围与执行位置，再整理可确认的结果。'
        yield { type: 'block-start', index: 0, blockType: 'reasoning' }; yield { type: 'reasoning-delta', index: 0, text: reasoning }
        yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }
      }
      if (tool) {
        const block = { type: 'tool-call', id: `hl-qa-${sid}-${round}-${marker || ''}`, ...tool }
        yield { type: 'block-start', index: 1, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 1, id: block.id, name: block.name, argumentsDelta: block.arguments }
        yield { type: 'block-end', index: 1, block }; yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        const text = options.purpose ? 'HL Personal QA' : '已完成本次检查。可以在私人助理中查看事务进度，也可以打开原会话继续工作。'
        yield { type: 'block-start', index: 1, blockType: 'text' }
        for (let i = 0; i < text.length; i += 6) { yield { type: 'text-delta', index: 1, text: text.slice(i, i + 6) }; await delay(30, undefined, { signal: options.signal }) }
        yield { type: 'block-end', index: 1, block: { type: 'text', text } }
        yield { type: 'usage', usage: { inputTokens: 120, cacheReadTokens: 500, cacheWriteTokens: 0, outputTokens: 80, reasoningTokens: 20 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  host.llm.registerAdapter(['hl-personal-qa'], new HLFixtureModel())
  await host.agentDefaultModel.saveSelection({ provider: 'hl-personal-qa', model: 'hl-personal-qa' })
  const secrets = new Map<string, string>()
  let personal!: HLPersonalRuntime; let runtime!: HLRuntime
  await applyWithDependencies(host, { ...HLConfig({} as HLConfig), hostName: 'Harness Link Personal QA', dataDirectory: join(directory, 'plugin') }, {
    createSecretStore: () => ({ async get(key) { return secrets.get(key) }, async set(key, value) { secrets.set(key, value) }, async delete(key) { secrets.delete(key) } }),
    createPersonalRuntime(options) { personal = new HLPersonalRuntime(options); return personal },
    createRuntime(options) {
      runtime = new HLRuntime({ ...options, onStateChange() {
        options.onStateChange?.()
        queueMicrotask(() => {
          for (const pending of runtime?.status().pending || []) if (['HL Personal Android QA', 'HL Personal iOS QA'].includes(pending.name)) runtime.approve(pending.requestId)
        })
      } }); return runtime
    },
  })
  const deadline = Date.now() + 40_000
  while (!personal.framework.snapshot().available) { if (Date.now() > deadline) throw new Error('Personal Host services did not attach'); await delay(100) }
  const actor = { deviceId: 'fixture-desktop', desktop: true }
  const call = (method: string, params: object = {}) => personal.framework.invoke(`personal.${method}`, { operationId: crypto.randomUUID(), ...params }, actor, new AbortController().signal)
  await call('configure', { revision: personal.framework.profile().revision, enabled: true }); await call('open')
  await call('createGoal', { title: '阅读与学习', objective: '定期整理阅读资料，并输出要点。' })
  await call('createGoal', { title: '产品迭代', objective: '在已有工作区继续推进项目。' })
  const peer = host.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
  const workspacePath = join(directory, 'workspace'); await mkdir(workspacePath, { recursive: true })
  const workspace = await host.typertGateway.invoke({ namespace: 'workspace', method: 'create', args: { request: { path: workspacePath } }, peer }) as { workspace: { workspaceId: string } }
  const session = await host.typertGateway.invoke({ namespace: 'session', method: 'create', args: { request: { workspaceId: workspace.workspace.workspaceId } }, peer }) as { sessionId: string }
  await peer.dispose()
  const fetches = host.connection.fetch as unknown as { register(route: { path: string; methods: ['GET']; requestBody: 'buffered'; fetch(request: Request): Promise<Response> }): () => Promise<void> }
  for (const asset of ['', '.js']) {
    const release = fetches.register({ path: `/api/hlPersonalQA/${asset ? 'script' : 'page'}`, methods: ['GET'], requestBody: 'buffered', async fetch(request) {
      const admission = host.connection.admit(request)
      if ('rejection' in admission || admission.peer !== host.connection.browserPeer) return new Response('Forbidden', { status: 403 })
      return new Response(asset ? await readFile(config.preview) : '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Harness Link Personal QA</title><style>body{font-family:system-ui,sans-serif;margin:0;background:#fafbfe;color:#202632}main{max-width:1120px;margin:36px auto;padding:24px;background:white;border-radius:24px}#opened{font-size:12px;color:#718097}@media(prefers-color-scheme:dark){body{background:#13171e;color:#dde4ef}main{background:#1b202a}}</style><main><div id="root"></div><output id="opened"></output></main><script type="module" src="/api/hlPersonalQA/script"></script></html>', { headers: { 'content-type': asset ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
    } }); host.effect(() => release)
  }
  await writeFile(join(directory, 'state.json'), JSON.stringify({ ready: true, endpointId: runtime.status().endpointId, workspaceId: workspace.workspace.workspaceId, sessionId: session.sessionId }), { mode: 0o600 })
}
