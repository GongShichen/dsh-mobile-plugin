/** Isolated, credential-free fixture. Exercises real Agent, approval, question and Gateway services. */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { mkdir, writeFile, rename } from 'node:fs/promises'
import { HLDSHBridge } from '../../src/bridge/HLDSHBridge.ts'

export const name = 'hl-interaction-qa'
export const inject = ['connection', 'typertGateway', 'sessionController', 'workspaceController', 'llm', 'tools', 'approval', 'userQuestions', 'agents']

export async function apply(host: any, config: { directory: string; runtimeRoot: string }): Promise<void> {
  const directory = config.directory
  await mkdir(join(directory, 'workspace'), { recursive: true })
  await writeFile(join(directory, 'state.json'), JSON.stringify({ ready: false, startedAt: Date.now() }), { mode: 0o600 })
  const load = (name: string) => import(pathToFileURL(join(config.runtimeRoot, 'node_modules', name, 'lib/index.js')).href)
  const llm = await load('@deepseek-ai/dsh-llm')
  const tools = await load('@deepseek-ai/dsh-tools')
  const askUser = await load('@deepseek-ai/dsh-tool-ask-user')
  const lifetime = new AbortController()
  const state: any = { ready: false, sessions: {}, desktop: {}, cancellations: [], audit: {} }
  let saves = Promise.resolve()
  function save() {
    const text = JSON.stringify(state, null, 2)
    saves = saves.then(async () => {
      const path = join(directory, 'state.json')
      await writeFile(path + '.tmp', text, { mode: 0o600 }); await rename(path + '.tmp', path)
    })
  }
  host.effect(() => () => lifetime.abort())
  // Official timed tool, scoped to each fixture Agent. No production preset or global tool is changed.
  host.on('agent/created', async ({ agent }: any) => {
    await agent.ctx.inject(['tools', 'userQuestions'], (scope: any) => {
      askUser.apply(scope, { mode: 'timed', timeout: 120 })
    })
  }, { global: true })

  const questions = (mode: string) => mode === 'skip'
    ? [{ id: 'skip', question: '可选测试问题', options: [{ label: '测试选项' }] }]
    : mode === 'timed'
      ? [{ id: 'late', header: '超时补答', question: '请补充测试结论', options: [{ label: '补答已完成' }] }]
      : [
        { id: 'scope', header: '测试范围', question: '选择需要验证的范围', multi_select: true, options: [{ label: '消息同步' }, { label: '权限确认' }, { label: '文件预览' }] },
        { id: 'note', header: '备注', question: '补充一条测试备注' },
      ]
  class HLInteractionAdapter extends llm.LlmAdapter {
    private readonly seen = new Set<string>()
    async listModels(provider: string) { return [{ provider, id: 'hl-interaction-fixture', name: 'HL isolated interaction fixture' }] }
    async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
    async *stream(options: any): AsyncIterable<unknown> {
      if (options.purpose !== undefined) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'HL 交互验证' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'HL 交互验证' } }
        yield { type: 'finish', reason: { kind: 'stop' } }; return
      }
      const marker = [...JSON.stringify(options.messages).matchAll(/\[HL_QA:([a-z-]+):([a-z0-9-]+)\]/g)].at(-1)
      if (!marker) throw new Error('Fixture prompts must contain an explicit HL_QA marker')
      const [, mode, nonce] = marker
      const key = `${options.sessionId}:${nonce}`
      if (!this.seen.has(key)) {
        this.seen.add(key)
        const questionMode = ['questions', 'skip', 'timed'].includes(mode!)
        const args = questionMode ? { questions: questions(mode!), timeout: mode === 'timed' ? 3 : -1 } : { mode, nonce }
        const block = { type: 'tool-call', id: `hl-qa-${nonce}`, name: questionMode ? 'ask_user_question' : 'hl_interaction_fixture', arguments: JSON.stringify(args) }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: '交互验证已完成。' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '交互验证已完成。' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  host.llm.registerAdapter(['hl-interaction-fixture'], new HLInteractionAdapter())
  host.tools.register(tools.defineTool({
    name: 'hl_interaction_fixture', description: 'Harmless interaction QA: records decisions; never executes commands or changes permissions.',
    parameters: { mode: { type: 'string', required: true }, nonce: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    async execute(args: { mode: string; nonce: string }, exec: any) {
      if (!exec.agent) throw new Error('Fixture requires a real Agent')
      let result: unknown
      if (args.mode === 'permission') {
        result = await host.userQuestions.ask({ agent: exec.agent, signal: exec.signal, questions: [{
          id: 'permission', question: 'Allow the harmless QA resource?', detail: 'No actual resource permission is modified.',
          options: [{ label: 'grant-once' }, { label: 'deny' }, { label: 'grant-persistent' }],
          intent: { kind: 'approval', approve: 'grant-once', reject: 'deny', always: 'grant-persistent', subject: { name: 'HL 交互测试' },
            display: { question: { en: 'Allow the harmless QA resource?', zh: '是否允许访问测试资源？' }, detail: { en: 'No real permission is changed.', zh: '此请求只记录测试选择，不修改真实资源权限。' }, approve: { en: 'Allow this test', zh: '允许本次测试' } } },
        }] })
      } else if (args.mode === 'plan') {
        result = await host.userQuestions.ask({ agent: exec.agent, signal: exec.signal, questions: [{ id: 'plan', question: '是否同意测试计划？',
          detail: '## 交互验证计划\n\n1. 同步桌面请求。\n2. 接收手机答复。\n3. 记录验证结果。\n\n整个测试不执行系统命令。',
          options: [{ label: '同意测试计划' }, { label: '需要调整测试计划' }], intent: { kind: 'plan-review', approve: '同意测试计划' },
        }] })
      } else {
        result = await host.approval.request({ agent: exec.agent, callId: exec.callId, toolName: 'hl_interaction_fixture', signal: exec.signal,
          reason: '这是无副作用的交互测试，只记录确认结果，不执行任何系统命令。' })
      }
      state.sessions[exec.agent.id] = { ...state.sessions[exec.agent.id], mode: args.mode, nonce: args.nonce, result }
      save()
      return JSON.stringify(result)
    },
  }))
  host.on('session/event', (session: any, event: any) => {
    if (event.type === 'user/message') {
      const text = JSON.stringify(event.data.content)
      const marker = [...text.matchAll(/\[HL_QA:([a-z-]+):([a-z0-9-]+)\]/g)].at(-1)
      if (marker) state.sessions[session.id] = { ...state.sessions[session.id], mode: marker[1], nonce: marker[2] }
    }
    if (event.type === 'approval/asked') state.audit[event.data.id] = { sessionId: session.id, callId: event.data.callId, decisions: [] }
    if (event.type === 'approval/decided') state.audit[event.data.id]?.decisions.push(event.data.outcome)
    if (['tool/result', 'user/message', 'turn/end'].includes(event.type) && state.sessions[session.id]) {
      const row = state.sessions[session.id]
      if (event.type === 'tool/result') row.toolResult = event.data
      if (event.type === 'turn/end') row.ended = true
      if (event.type === 'user/message' && event.data.source?.kind === 'user-question-reply') row.lateReply = event.data
    }
    save()
  }, { global: true })

  // The same long-lived browser Peer that authenticates Web RPC results.
  void (async () => {
    try {
      const stream = await host.typertGateway.wireStream.open('$events', { args: {} }, { async *[Symbol.asyncIterator]() {} }, host.connection.browserPeer, lifetime.signal)
      let clientId: string | undefined
      for await (const frame of stream) {
        if (frame.type === 'ready') clientId = frame.clientId
        else if (frame.type === 'waterfall') {
          state.desktop[frame.agentId] = { clientId, eventId: frame.eventId, event: frame.event, request: frame.request }
        } else if (frame.type === 'cancel') state.cancellations.push(frame.eventId)
        save()
      }
    } catch (error) { if (!lifetime.signal.aborted) { state.observerError = error instanceof Error ? error.name : 'error'; save() } }
  })()
  const bridge = new HLDSHBridge(host)
  const peer = bridge.createPeer('hl-fixture-bootstrap')
  try {
    const workspace: any = await bridge.invoke(peer, 'workspaces.create', { path: join(directory, 'workspace') })
    state.ready = true; state.workspaceId = workspace.workspace.workspaceId
    state.workspacePath = join(directory, 'workspace'); state.provider = 'hl-interaction-fixture'
    save()
  } finally { await bridge.dispose() }
}
