import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { HLPersonalFramework } from '../src/personal/core/HLPersonalFramework.ts'
import { HLPersonalSQLite } from '../src/personal/storage/HLPersonalSQLite.ts'
import { HLPersonalError } from '../src/personal/core/HLPersonalValidation.ts'
import type { HLAgentExecutionPort, HLDSHSessionState, HLSessionRow } from '../src/personal/ports/HLAgentExecutionPort.ts'
import type { HLPersonalTask, HLPersonalGoal, HLSessionBinding } from '../src/personal/core/HLPersonalTypes.ts'
import { hlCalendarChangeSource } from '../src/personal/connectors/google/HLCalendarChangeSource.ts'

function fixture() {
  const store = new HLPersonalSQLite(':memory:')
  let clock = 1_800_000_000_000
  const prompts: Array<{ sessionId: string; requestId: string; text: string }> = []
  const creations: Array<{ target: unknown; id: string }> = []
  const cancellations: Array<{ sessionId: string; ownsTurn: boolean }> = []
  const states = new Map<string, HLDSHSessionState>()
  let rows: HLSessionRow[] = [{ sessionId: 'existing-session', title: 'Original', workspaceId: 'workspace-a', cwd: '/fixture/project', agentPreset: 'original-preset', running: false, archived: false }]
  let partialFailure = false
  let observeMain = true
  let mainSeq = 0
  const execution: HLAgentExecutionPort = {
    async workspaces() { return [{ workspaceId: 'workspace-a', title: 'A', path: '/fixture/project', sessionIds: rows.map(row => row.sessionId) }] },
    async sessions() { return rows }, async context() { return {} },
    async ensureSession(request) {
      if (request.target.kind === 'session-continue') return { sessionId: request.target.sessionId, workspaceId: request.target.workspaceId, ownership: 'borrowed', cwd: '/fixture/project', agentPreset: 'original-preset' }
      if (partialFailure) throw new HLPersonalError('PERSONAL_WORKSPACE_ATTACH_FAILED', 'Created but unattached', { sessionId: 'partial-session', workspaceId: 'workspace-a' })
      const id = 'actual-' + request.requestedId
      creations.push({ target: request.target, id })
      const result: HLSessionBinding = { sessionId: id, ownership: request.target.kind === 'internal' ? 'internal' : 'created', cwd: request.directory,
        ...(request.target.kind === 'workspace-new' ? { workspaceId: request.target.workspaceId } : {}) }
      states.set(id, { cursor: 0, running: false, active: true, queue: [], pendingInput: [] }); return result
    },
    async state(id) { return states.get(id) ?? { cursor: 0, running: false, active: false, queue: [], pendingInput: [] } },
    async prompt(sessionId, requestId, text) {
      if (!prompts.some(row => row.sessionId === sessionId && row.requestId === requestId)) prompts.push({ sessionId, requestId, text })
      if (observeMain && sessionId === framework.profile().mainSessionId) {
        framework.observe(sessionId, { type: 'turn/start', seq: ++mainSeq, data: { turn: mainSeq } })
        framework.observe(sessionId, { type: 'user/message', seq: ++mainSeq, data: { source: { kind: 'user', rpcId: requestId }, content: [{ type: 'text', text }] } })
      }
    },
    async cancel(sessionId, _id, ownsTurn) { cancellations.push({ sessionId, ownsTurn }) },
    async checkpoint() {}, async verifyArtifacts() {}, async notice() {}, async dispose() {},
  }
  const framework = new HLPersonalFramework({ store, id: randomUUID, now: () => clock, directory: id => '/fixture/tasks/' + id })
  framework.attachExecution(execution, { async create() { return 'schedule-1' }, async edit() {}, async history() { return [] } })
  const actor = { deviceId: 'phone-a', desktop: false }
  const call = (method: string, params: Record<string, unknown> = {}, op: string = randomUUID()) => { clock++; return framework.invoke('personal.' + method, { ...params, operationId: op }, actor, new AbortController().signal) }
  const enable = () => call('configure', { revision: framework.profile().revision, enabled: true })
  const flush = async () => { for (let i = 0; i < 8; i++) { await framework.tick(); await new Promise(resolve => setImmediate(resolve)) } }
  const task = (id: string) => store.get('task', id)!
  const finish = async (id: string, ready = true) => {
    const row = task(id); const run = store.get('run', row.activeRunId!)!; const sid = row.binding!.sessionId
    framework.observe(sid, { type: 'turn/start', seq: 1, data: { turn: 1 } })
    framework.observe(sid, { type: 'user/message', seq: 2, data: { source: { kind: 'user', rpcId: run.requestId } } })
    framework.observe(sid, { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: 'Visible result' }] } } })
    if (row.target.kind === 'internal') {
      const value = await framework.tool('personal.report', { outcome: ready ? 'ready' : 'waiting', summary: 'Verified result', artifacts: [], actionIds: [] }, sid, 'report-call', new AbortController().signal) as { runId: string }
      framework.observe(sid, { type: 'tool/result', seq: 4, data: { message: { source: { kind: 'tool', callId: 'report-call' }, isError: false }, meta: { hlPersonalRunId: value.runId } } })
    }
    framework.observe(sid, { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } })
    await flush()
  }
  return { store, framework, execution, call, enable, flush, task, finish, prompts, creations, cancellations, states,
    setRows(value: HLSessionRow[]) { rows = value }, partial() { partialFailure = true }, advance(ms: number) { clock += ms }, holdMain() { observeMain = false },
    async close() { await framework.stop(); store.close() } }
}

test('Google setup is requested only by actual scoped service use, and repeated calls do not repeat the request', async () => {
  const f = fixture()
  try {
    await f.enable(); await f.call('open'); await f.flush()
    assert.deepEqual(f.framework.snapshot().serviceRequests, [])
    const task = await f.call('createTask', { title: '只读测试', instruction: '完成当前事务' }) as HLPersonalTask
    await f.flush()
    assert.deepEqual(f.framework.snapshot().serviceRequests, [])
    const sessionId = f.task(task.id).binding!.sessionId
    await f.framework.tool('personal.requestGoogle', { service: 'gmail' }, sessionId, 'request-1', new AbortController().signal)
    await f.framework.tool('personal.requestGoogle', { service: 'gmail' }, sessionId, 'request-2', new AbortController().signal)
    const requests = f.framework.snapshot().serviceRequests!
    assert.equal(requests.length, 1); assert.equal(requests[0]!.taskId, task.id); assert.equal(requests[0]!.service, 'gmail')
    await assert.rejects(f.framework.tool('personal.requestGoogle', { service: 'drive' }, sessionId, 'invalid', new AbortController().signal), { code: 'PERSONAL_INPUT' })
    await assert.rejects(f.framework.tool('personal.requestGoogle', { service: 'calendar' }, 'ordinary-session', 'outside', new AbortController().signal), { code: 'PERSONAL_TOOL_SCOPE' })
  } finally { await f.close() }
})

test('several goals and an independent task coexist; two slots admit different goals fairly', async () => {
  const f = fixture()
  try {
    const goals = await Promise.all(['A', 'B', 'C'].map(title => f.call('createGoal', { title, objective: title }).catch(() => undefined)))
    assert.deepEqual(goals, [undefined, undefined, undefined], 'disabled assistant refuses changes')
    await f.enable()
    await f.call('configure', { revision: f.framework.profile().revision, paused: true })
    const a = await f.call('createGoal', { title: 'A', objective: 'Goal A', priority: 'high' }) as HLPersonalGoal
    const b = await f.call('createGoal', { title: 'B', objective: 'Goal B' }) as HLPersonalGoal
    const c = await f.call('createGoal', { title: 'C', objective: 'Goal C' }) as HLPersonalGoal
    const a1 = await f.call('createTask', { title: 'A1', instruction: 'one', goalId: a.id }) as HLPersonalTask
    await f.call('createTask', { title: 'A2', instruction: 'two', goalId: a.id })
    const b1 = await f.call('createTask', { title: 'B1', instruction: 'three', goalId: b.id }) as HLPersonalTask
    await f.call('createTask', { title: 'Independent', instruction: 'temporary' })
    await f.call('configure', { revision: f.framework.profile().revision, paused: false })
    await f.flush()
    assert.equal(f.framework.snapshot().goals.length, 3)
    assert.equal(f.task(a1.id).state, 'running')
    assert.equal(f.task(b1.id).state, 'running')
    assert.equal(f.framework.snapshot().tasks.filter(row => row.state === 'running').length, 2)
    assert.ok(f.framework.snapshot().tasks.some(row => !row.goalId))
    assert.equal(f.store.get('goal', c.id)?.state, 'active')
    await f.finish(a1.id)
    assert.equal(f.task(a1.id).state, 'completed')
    assert.equal(f.task(b1.id).state, 'running')
  } finally { await f.close() }
})

test('command replay returns one task; different content under the same id is refused', async () => {
  const f = fixture()
  try {
    await f.enable()
    const params = { title: 'one', instruction: 'do it' }
    const first = await f.call('createTask', params, 'same-operation') as HLPersonalTask
    const second = await f.call('createTask', params, 'same-operation') as HLPersonalTask
    assert.equal(second.id, first.id); assert.equal(f.store.list('task').length, 1)
    await assert.rejects(f.call('createTask', { ...params, instruction: 'different' }, 'same-operation'), { code: 'PERSONAL_OPERATION_CONFLICT' })
    await f.flush(); assert.equal(f.prompts.length, 1)
    assert.match(f.task(first.id).binding!.sessionId, /^actual-/)
  } finally { await f.close() }
})

test('borrowed sessions keep identity; busy sessions wait and human intervention yields without cancellation', async () => {
  const f = fixture()
  try {
    await f.enable()
    f.states.set('existing-session', { cursor: 0, running: true, active: true, queue: [], pendingInput: [] })
    const t = await f.call('createTask', { title: 'Continue', instruction: 'continue original work', target: { kind: 'session-continue', workspaceId: 'workspace-a', sessionId: 'existing-session' } }) as HLPersonalTask
    await f.flush(); assert.equal(f.task(t.id).waitReason, 'session-busy'); assert.equal(f.prompts.length, 0)
    f.states.set('existing-session', { cursor: 0, running: false, active: true, queue: [], pendingInput: [] }); f.advance(6000); await f.flush()
    const row = f.task(t.id); const run = f.store.get('run', row.activeRunId!)!
    assert.equal(row.binding?.agentPreset, 'original-preset'); assert.equal(f.creations.length, 0)
    f.framework.observe('existing-session', { type: 'turn/start', seq: 1, data: { turn: 1 } })
    f.framework.observe('existing-session', { type: 'user/message', seq: 2, data: { source: { kind: 'user', rpcId: run.requestId } } })
    f.framework.observe('existing-session', { type: 'user/message', seq: 3, data: { source: { kind: 'user', rpcId: 'desktop-human' } } })
    assert.equal(f.task(t.id).waitReason, 'human-control')
    await f.call('cancelTask', { taskId: t.id, revision: f.task(t.id).revision }); await f.flush()
    assert.ok(f.cancellations.every(row => row.ownsTurn === false))
  } finally { await f.close() }
})

test('a partial workspace creation preserves the real session and never creates a replacement on retry', async () => {
  const f = fixture()
  try {
    await f.enable(); f.partial()
    const t = await f.call('createTask', { title: 'new', instruction: 'work', target: { kind: 'workspace-new', workspaceId: 'workspace-a' } }) as HLPersonalTask
    await f.flush(); assert.equal(f.task(t.id).binding?.sessionId, 'partial-session')
    await f.call('resumeTask', { taskId: t.id, revision: f.task(t.id).revision }); await f.flush()
    assert.equal(f.task(t.id).binding?.sessionId, 'partial-session'); assert.equal(f.task(t.id).errorCode, 'PERSONAL_WORKSPACE_ATTACH_FAILED')
    assert.equal(f.prompts.length, 0); assert.equal(f.creations.length, 0)
  } finally { await f.close() }
})

test('write grants bind task, account and recipients; uncertain writes never automatically resend', async () => {
  const f = fixture(); let sends = 0
  try {
    await f.enable()
    const t = await f.call('createTask', { title: 'mail', instruction: 'send to myself' }) as HLPersonalTask
    f.store.transaction(() => f.store.put('connection', { id: 'account-a', provider: 'google', email: 'me@example.com', scopes: [], state: 'connected', updatedAt: 0 }))
    f.store.transaction(() => f.store.put('task', { ...f.task(t.id), accountIds: ['account-a'] }))
    f.framework.connectors.register({ id: 'fixture.send', effect: 'write', description: 'fixture',
      parse(value) { const row = value as { to: string }; return { input: { to: row.to }, recipients: [row.to], calendarIds: [], preview: row.to } },
      async execute() { sends++; throw new Error('response lost') }, async reconcile() { return { state: 'confirmed', result: { id: 'real-message' } } } })
    const a = f.store.transaction(() => f.framework.actions.prepare(t.id, 'fixture.send', 'account-a', { to: 'me@example.com' }))
    await assert.rejects(f.framework.actions.commit(t.id, a.id, new AbortController().signal), { code: 'PERSONAL_AUTHORIZATION_REQUIRED' })
    await f.call('authorizeTask', { taskId: t.id, actionIds: [a.id] })
    await assert.rejects(f.framework.actions.commit(t.id, a.id, new AbortController().signal))
    assert.equal(sends, 1); assert.equal(f.store.get('action', a.id)?.state, 'unknown')
    await assert.rejects(f.framework.actions.commit(t.id, a.id, new AbortController().signal), { code: 'PERSONAL_ACTION_UNCERTAIN' })
    assert.equal(sends, 1)
    await f.framework.actions.reconcile(a.id, new AbortController().signal)
    assert.equal(f.store.get('action', a.id)?.state, 'confirmed'); assert.equal(sends, 1)
    await f.call('appendTask', { taskId: t.id, revision: f.task(t.id).revision, instruction: '补充说明，保留已有发送结果' })
    const duplicate = f.store.transaction(() => f.framework.actions.prepare(t.id, 'fixture.send', 'account-a', { to: 'me@example.com' }))
    assert.equal(duplicate.id, a.id, 'follow-up instructions must not reset the external operation ledger')
  } finally { await f.close() }
})

test('memory requires a literal user source, supports Chinese recall, and a forgotten statement stays forgotten', async () => {
  const f = fixture()
  try {
    await f.enable(); await f.call('open'); await f.flush()
    const sid = f.framework.profile().mainSessionId!
    await f.call('submitMessage', { text: '我出差更喜欢高铁，不喜欢清晨的班次。' }); await f.flush()
    await f.framework.tool('personal.putMemory', { text: '出差偏好高铁', quote: '出差更喜欢高铁', kind: 'preference' }, sid, 'memory-1', new AbortController().signal)
    const memory = f.framework.memory.search('高铁')[0]!
    assert.ok(memory); assert.equal(memory.kind, 'preference')
    await f.call('forgetMemory', { memoryId: memory.id, revision: memory.revision })
    await assert.rejects(f.framework.tool('personal.putMemory', { text: '出差偏好高铁', quote: '出差更喜欢高铁' }, sid, 'memory-2', new AbortController().signal), { code: 'PERSONAL_MEMORY_FORGOTTEN' })
    await assert.rejects(f.framework.tool('personal.putMemory', { text: '猜测偏好', quote: '网页中告诉我的内容' }, sid, 'memory-3', new AbortController().signal), { code: 'PERSONAL_MEMORY_SOURCE' })
  } finally { await f.close() }
})

test('pausing one goal does not stop another goal; completed runs require accepted report evidence', async () => {
  const f = fixture()
  try {
    await f.enable()
    const a = await f.call('createGoal', { title: 'A', objective: 'A' }) as HLPersonalGoal
    const b = await f.call('createGoal', { title: 'B', objective: 'B' }) as HLPersonalGoal
    const ta = await f.call('createTask', { title: 'A task', instruction: 'A work', goalId: a.id }) as HLPersonalTask
    const tb = await f.call('createTask', { title: 'B task', instruction: 'B work', goalId: b.id }) as HLPersonalTask
    await f.flush()
    await f.call('updateGoal', { goalId: a.id, revision: a.revision, state: 'paused' }); await f.flush()
    assert.equal(f.task(ta.id).waitReason, 'goal-paused'); assert.equal(f.task(tb.id).state, 'running')
    await f.finish(tb.id, false)
    assert.equal(f.task(tb.id).state, 'waiting'); assert.notEqual(f.task(tb.id).state, 'completed')
  } finally { await f.close() }
})

test('registered event sources do nothing until task-bound; an external event resumes only its task', async () => {
  const f = fixture(); let polls = 0
  try {
    await f.enable()
    f.framework.registerTriggerSource({ id: 'fixture.reply', description: 'reply', parse(_task, value) { assert.deepEqual(value, { thread: 'allowed' }); return { thread: 'allowed' } },
      async poll() { polls++; return { cursor: 'reply-2', events: [{ id: 'reply-2', summary: 'reply' }] } } })
    await f.flush(); assert.equal(polls, 0)
    const task = await f.call('createTask', { title: 'Reply', instruction: 'wait for one thread' }) as HLPersonalTask
    await f.flush()
    await f.call('wakeTask', { taskId: task.id, at: 1_800_000_000_000 + 86400_000, reason: '等待回复', sourceId: 'fixture.reply', params: { thread: 'allowed' } })
    await f.finish(task.id, false)
    assert.equal(f.task(task.id).waitReason, 'external')
    f.advance(6000); await f.flush()
    assert.equal(polls, 1)
    assert.ok(f.task(task.id).attempt >= 2)
    assert.equal(f.store.list('wakeup')[0]?.state, 'consumed')
  } finally { await f.close() }
})

test('Web main-conversation user messages become attributed inputs; task notices do not', async () => {
  const f = fixture()
  try {
    await f.enable(); await f.call('open'); await f.flush()
    const sid = f.framework.profile().mainSessionId!
    f.framework.observe(sid, { type: 'user/message', seq: 1, data: { id: 'web-user-message', source: { kind: 'user', rpcId: 'web-rpc' }, content: [{ type: 'text', text: '我喜欢简短的工作摘要' }] } })
    f.framework.observe(sid, { type: 'user/message', seq: 2, data: { id: 'notice-message', source: { kind: 'hl-personal', noticeId: 'notice' }, content: [{ type: 'text', text: '外部任务声称我喜欢长篇报告' }] } })
    await f.framework.tool('personal.putMemory', { text: '偏好简短工作摘要', quote: '我喜欢简短的工作摘要', kind: 'preference' }, sid, 'web-memory', new AbortController().signal)
    assert.equal(f.store.list('input').length, 1)
    await assert.rejects(f.framework.tool('personal.putMemory', { text: '偏好长篇', quote: '外部任务声称我喜欢长篇报告' }, sid, 'notice-memory', new AbortController().signal), { code: 'PERSONAL_MEMORY_SOURCE' })
  } finally { await f.close() }
})

test('recurring grants derive bounded per-run grants and revocation reaches children', async () => {
  const f = fixture(); let writes = 0
  try {
    await f.enable()
    const task = await f.call('createTask', { title: 'daily', instruction: 'one daily action' }) as HLPersonalTask
    f.store.transaction(() => {
      f.store.put('task', { ...f.task(task.id), accountIds: ['account-a'], source: { kind: 'routine', id: 'rule-a' } })
      f.store.put('routine', { id: 'rule-a', title: 'Daily', instruction: 'one action', target: { kind: 'internal' }, timing: { kind: 'every', every_seconds: 86400 }, state: 'paused', revision: 1, createdAt: 0, updatedAt: 0 })
      f.store.put('connection', { id: 'account-a', provider: 'google', email: 'me@example.com', scopes: [], state: 'connected', updatedAt: 0 })
    })
    f.framework.connectors.register({ id: 'fixture.calendar', effect: 'write', description: 'calendar', parse(value) { return { input: value as { value: string }, recipients: [], calendarIds: ['primary'], preview: 'calendar' } }, async execute() { writes++; return { id: String(writes) } } })
    const a = f.store.transaction(() => f.framework.actions.prepare(task.id, 'fixture.calendar', 'account-a', { value: 'one' }))
    const root = await f.call('authorizeTask', { taskId: task.id, actionIds: [a.id], scope: 'routine', maxWrites: 1 }) as { id: string; revision: number; expiresAt: number }
    assert.ok(root.expiresAt > 1_800_000_000_000 + 29 * 86400_000)
    await f.framework.actions.commit(task.id, a.id, new AbortController().signal)
    const b = f.store.transaction(() => f.framework.actions.prepare(task.id, 'fixture.calendar', 'account-a', { value: 'two' }))
    await assert.rejects(f.framework.actions.commit(task.id, b.id, new AbortController().signal), { code: 'PERSONAL_AUTHORIZATION_REQUIRED' })
    assert.equal(writes, 1)
    assert.equal(f.store.list('grant').filter(row => row.parentGrantId === root.id).length, 1)
    await f.call('revokeGrant', { grantId: root.id, revision: root.revision })
    assert.ok(f.store.list('grant').every(row => row.state === 'revoked'))
  } finally { await f.close() }
})

test('a ready report cannot claim email or file delivery without matching durable evidence', async () => {
  const f = fixture()
  try {
    await f.enable()
    const email = await f.call('createTask', { title: 'Mail', instruction: 'Send the requested mail', resultKind: 'email' }) as HLPersonalTask
    const files = await f.call('createTask', { title: 'Files', instruction: 'Produce a file', resultKind: 'files' }) as HLPersonalTask
    await f.flush(); await f.finish(email.id); await f.finish(files.id)
    assert.equal(f.task(email.id).state, 'waiting')
    assert.equal(f.task(email.id).errorCode, 'PERSONAL_RESULT_UNCERTAIN')
    assert.equal(f.task(files.id).errorCode, 'PERSONAL_ARTIFACT_MISSING')
    assert.equal(f.task(email.id).result, undefined)
  } finally { await f.close() }
})

test('explicit execution targets reject model substitutions while allowing scoped account subtasks', async () => {
  const f = fixture()
  try {
    await f.enable(); await f.call('open'); await f.flush()
    const sid = f.framework.profile().mainSessionId!
    await f.call('submitMessage', { text: '继续原会话并用邮件回报', target: { kind: 'session-continue', workspaceId: 'workspace-a', sessionId: 'existing-session' } })
    await f.flush()
    await assert.rejects(f.framework.tool('personal.createTask', { title: 'Wrong', instruction: 'wrong', target: { kind: 'internal' }, resultKind: 'text' }, sid, 'wrong-target', new AbortController().signal), { code: 'PERSONAL_TARGET_CONFLICT' })
    const work = await f.framework.tool('personal.createTask', Object.freeze({ title: 'Continue', instruction: 'Continue existing work', resultKind: 'session' }), sid, 'right-target', new AbortController().signal) as HLPersonalTask
    assert.equal(work.target.kind, 'session-continue')
    const mail = await f.framework.tool('personal.createTask', { title: 'Mail', instruction: 'Report via email', target: { kind: 'internal' }, resultKind: 'email' }, sid, 'mail-target', new AbortController().signal) as HLPersonalTask
    assert.equal(mail.target.kind, 'internal')
    const routine = await f.framework.tool('personal.createRoutine', { title: 'Daily continuation', instruction: 'Continue this selected work daily', timing: { kind: 'every', every_seconds: 86400 } }, sid, 'routine-target', new AbortController().signal) as { target: { kind: string } }
    assert.equal(routine.target.kind, 'session-continue')
  } finally { await f.close() }
})

test('a queued later message cannot retarget tools in the current human turn; notices have no new authority', async () => {
  const f = fixture()
  try {
    await f.enable(); await f.call('open'); await f.flush(); f.holdMain()
    const sid = f.framework.profile().mainSessionId!
    await f.call('submitMessage', { text: 'Continue first', target: { kind: 'session-continue', workspaceId: 'workspace-a', sessionId: 'existing-session' } })
    const first = f.store.list('input')[0]!
    f.framework.observe(sid, { type: 'turn/start', seq: 1, data: { turn: 1 } })
    f.framework.observe(sid, { type: 'user/message', seq: 2, data: { source: { kind: 'user', rpcId: first.requestId } } })
    await f.call('submitMessage', { text: 'Second queued task', target: { kind: 'internal' } })
    const task = await f.framework.tool('personal.createTask', Object.freeze({ title: 'First', instruction: 'First work' }), sid, 'first-tool', new AbortController().signal) as HLPersonalTask
    assert.equal(task.target.kind, 'session-continue')
    f.framework.observe(sid, { type: 'turn/end', seq: 3, data: { turn: 1 } })
    f.framework.observe(sid, { type: 'turn/start', seq: 4, data: { turn: 2 } })
    f.framework.observe(sid, { type: 'user/message', seq: 5, data: { source: { kind: 'hl-personal', noticeId: 'notice' } } })
    await assert.rejects(f.framework.tool('personal.createTask', { title: 'Unrequested', instruction: 'No human input' }, sid, 'notice-work', new AbortController().signal), { code: 'PERSONAL_USER_INTENT_REQUIRED' })
  } finally { await f.close() }
})

test('dependent work waits without using a model slot and wakes after its prerequisite is verified', async () => {
  const f = fixture()
  try {
    await f.enable()
    const first = await f.call('createTask', { title: 'First', instruction: 'first result' }) as HLPersonalTask
    const next = await f.call('createTask', { title: 'Next', instruction: 'use first result', dependsOn: [first.id] }) as HLPersonalTask
    const independent = await f.call('createTask', { title: 'Other', instruction: 'independent' }) as HLPersonalTask
    await f.flush()
    assert.equal(f.task(next.id).waitReason, 'dependency'); assert.equal(f.task(next.id).attempt, 0)
    assert.equal(f.task(independent.id).state, 'running')
    await f.finish(first.id)
    assert.equal(f.task(next.id).state, 'running')
    assert.match(f.framework.contextForSession(f.task(next.id).binding!.sessionId), /Verified result/)
  } finally { await f.close() }
})

test('desktop execution in the same workspace defers Personal writes and never cancels desktop work', async () => {
  const f = fixture()
  try {
    await f.enable()
    const original: HLSessionRow = { sessionId: 'existing-session', title: 'Original', workspaceId: 'workspace-a', running: false, archived: false }
    f.setRows([original, { ...original, sessionId: 'desktop-work', running: true }])
    const task = await f.call('createTask', { title: 'Continue', instruction: 'work', target: { kind: 'session-continue', sessionId: 'existing-session', workspaceId: 'workspace-a' } }) as HLPersonalTask
    await f.flush(); assert.equal(f.task(task.id).waitReason, 'workspace-busy'); assert.equal(f.prompts.length, 0)
    f.setRows([original]); f.advance(6000); await f.flush()
    assert.equal(f.task(task.id).state, 'running'); assert.equal(f.prompts.length, 1); assert.equal(f.cancellations.length, 0)
  } finally { await f.close() }
})

test('Host restart preserves the actual session and requires deliberate recovery instead of replaying work', async () => {
  const f = fixture(); let recovered: HLPersonalFramework | undefined
  try {
    await f.enable()
    const task = await f.call('createTask', { title: 'Work', instruction: 'work' }) as HLPersonalTask
    await f.flush(); const sid = f.task(task.id).binding!.sessionId
    await f.framework.stop()
    recovered = new HLPersonalFramework({ store: f.store, id: randomUUID, directory: id => '/fixture/tasks/' + id })
    recovered.attachExecution(f.execution, { async create() { return 'schedule' }, async edit() {}, async history() { return [] } })
    await recovered.tick()
    assert.equal(f.store.get('task', task.id)?.state, 'interrupted')
    assert.equal(f.store.get('task', task.id)?.binding?.sessionId, sid)
    assert.equal(f.prompts.length, 1)
  } finally { await recovered?.stop(); await f.close() }
})

test('calendar change watches stay within the exact range this task already read', async () => {
  const f = fixture(); let etag = 'one'; let reads = 0
  try {
    await f.enable()
    const task = await f.call('createTask', { title: 'Calendar', instruction: 'follow one calendar window' }) as HLPersonalTask
    await f.flush()
    f.store.transaction(() => {
      f.store.put('connection', { id: 'account', provider: 'google', email: 'me@example.com', scopes: [], state: 'connected', updatedAt: 0 })
      f.store.put('task', { ...f.task(task.id), accountIds: ['account'] })
    })
    f.framework.connectors.register({ id: 'google.calendar.list', effect: 'read', description: 'fixture calendar', parse(value) { return { input: value as Record<string, string>, recipients: [], calendarIds: [], preview: 'range' } }, async execute() { reads++; return { items: [{ id: 'event', etag }] } } })
    f.framework.registerTriggerSource(hlCalendarChangeSource(f.store, f.framework.actions))
    const range = { calendarId: 'primary', timeMin: '2027-01-01T00:00:00.000Z', timeMax: '2027-01-02T00:00:00.000Z' }
    const watch = { taskId: task.id, sourceId: 'google.calendar.changed', at: 1_800_000_000_000 + 86400_000, reason: '等待指定日程变化', params: { accountId: 'account', ...range, timeMin: '2027-01-01T08:00:00+08:00', timeMax: '2027-01-02T08:00:00+08:00' } }
    await assert.rejects(f.call('wakeTask', watch), { code: 'PERSONAL_SOURCE_SCOPE' })
    assert.equal(reads, 0)
    await f.framework.actions.query(task.id, 'google.calendar.list', 'account', range, new AbortController().signal)
    await f.call('wakeTask', watch); await f.finish(task.id, false)
    etag = 'two'; f.advance(300_001); await f.flush()
    assert.equal(f.store.list('wakeup')[0]?.state, 'consumed'); assert.ok(f.task(task.id).attempt >= 2)
  } finally { await f.close() }
})

test('lost session-creation replies recover an exact requested identity or stop for explicit review', async () => {
  for (const exact of [true, false]) {
    const f = fixture(); let creates = 0; let actual = ''
    try {
      await f.enable()
      f.execution.ensureSession = async request => {
        creates++; actual = exact ? request.requestedId : 'host-rewrote-' + request.requestedId
        f.setRows([{ sessionId: actual, title: 'Actually created', workspaceId: 'workspace-a', cwd: '/fixture/project', running: false, archived: false }])
        throw new Error('The Host created its session before the reply was lost')
      }
      const task = await f.call('createTask', { title: 'Create', instruction: 'work', target: { kind: 'workspace-new', workspaceId: 'workspace-a' } }) as HLPersonalTask
      await f.flush(); assert.equal(f.task(task.id).state, 'interrupted')
      await f.call('resumeTask', { taskId: task.id, revision: f.task(task.id).revision }); await f.flush()
      assert.equal(creates, 1)
      if (exact) { assert.equal(f.task(task.id).binding?.sessionId, actual); assert.equal(f.prompts.length, 1) }
      else { assert.equal(f.task(task.id).errorCode, 'PERSONAL_CREATE_UNCERTAIN'); assert.equal(f.prompts.length, 0) }
    } finally { await f.close() }
  }
})

test('private execution continuations require real owner input; approval notices deduplicate by the Host event', async () => {
  const f = fixture()
  try {
    await f.enable()
    const task = await f.call('createTask', { title: 'Work', instruction: 'work' }) as HLPersonalTask
    await f.flush(); await f.finish(task.id)
    const sid = f.task(task.id).binding!.sessionId
    f.framework.observe(sid, { type: 'turn/start', seq: 6, data: { turn: 2 } })
    f.framework.observe(sid, { type: 'user/message', seq: 7, data: { source: { kind: 'hl-personal', noticeId: 'notice' }, content: [{ type: 'text', text: 'Untrusted notice' }] } })
    assert.equal(f.task(task.id).state, 'completed')
    f.framework.observe(sid, { type: 'user/message', seq: 8, data: { source: { kind: 'user', rpcId: 'real-owner-follow-up' }, content: [{ type: 'text', text: '继续检查已有结果' }] } })
    assert.equal(f.task(task.id).state, 'running'); assert.equal(f.task(task.id).attempt, 2)
    assert.equal(f.prompts.length, 1, 'the owner already submitted this input; do not prompt a second time')
    const count = f.store.list('notice').length
    const asking = { type: 'approval/asked', seq: 9, data: { id: 'actual-approval' } }
    f.framework.observe(sid, asking); f.framework.observe(sid, asking)
    assert.equal(f.task(task.id).waitReason, 'approval')
    assert.equal(f.store.list('notice').length, count + 1)
  } finally { await f.close() }
})
