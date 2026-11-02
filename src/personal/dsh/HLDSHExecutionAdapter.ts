import { mkdir, open, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, resolve, relative } from 'node:path'
import type { HLPeerScope } from '../../bridge/HLBridgeTypes.js'
import { firstFrame } from '../../sync/HLStreams.js'
import { record } from '../../bridge/HLBridgeError.js'
import type { HLAgentExecutionPort, HLDSHSessionState, HLSessionRow, HLWorkspaceRow } from '../ports/HLAgentExecutionPort.js'
import type { HLSchedulePort } from '../ports/HLSchedulePort.js'
import type { HLExecutionTarget, HLPersonalNotice, HLSessionBinding } from '../core/HLPersonalTypes.js'
import { HLPersonalError, hlObject } from '../core/HLPersonalValidation.js'
import type { HLPersonalDSHHost } from './HLDSHHost.js'

export const HL_PERSONAL_PRESETS = { assistant: 'hl-personal-assistant', worker: 'hl-personal-worker', scheduler: 'hl-personal-scheduler' } as const

/** A non-interactive owner Peer never intercepts the phone's or browser's approvals. */
export class HLDSHExecutionAdapter implements HLAgentExecutionPort, HLSchedulePort {
  get timingKinds(): readonly string[] {
    return ['after', 'at', 'every', 'daily', 'weekly', 'cron', ...(typeof this.host.get?.('schedule')?.remoteCreate === 'function' ? ['rrule'] : [])]
  }
  private readonly peer: HLPeerScope
  private readonly lifetime = new AbortController()
  constructor(private readonly host: HLPersonalDSHHost, private readonly selectedModel: () => ReturnType<import('./HLDSHHost.js').HLDSHAgent['model']['current']>) {
    this.peer = host.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
  }
  private call(namespace: string, method: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.host.typertGateway.invoke({ namespace, method, args, peer: this.peer,
      signal: AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]) })
  }
  private async baseline(namespace: string, method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const controller = new AbortController()
    try {
      const stream = await this.host.typertGateway.stream({ namespace, method, args, peer: this.peer,
        signal: AbortSignal.any([this.lifetime.signal, controller.signal, signal]) })
      return hlObject(await firstFrame(stream))
    } finally { controller.abort() }
  }
  async workspaces(signal: AbortSignal): Promise<HLWorkspaceRow[]> {
    const frame = await this.baseline('workspace', 'follow', {}, signal)
    const value = hlObject(frame.value)
    return (Array.isArray(value.items) ? value.items : []).filter(record).map(row => ({ workspaceId: String(row.workspaceId), title: String(row.title), path: String(row.path),
      sessionIds: Array.isArray(row.sessionIds) ? row.sessionIds.map(String) : [] }))
  }
  async sessions(workspaceId: string | undefined, signal: AbortSignal): Promise<HLSessionRow[]> {
    const frame = await this.baseline('workspace', 'follow', {}, signal)
    const workspace = hlObject(frame.value)
    const workspaces = (Array.isArray(workspace.items) ? workspace.items : []).filter(record)
    const requested = workspaceId ? workspaces.find(row => row.workspaceId === workspaceId) : undefined
    if (workspaceId && !requested) throw new HLPersonalError('PERSONAL_WORKSPACE_MISSING', '工作区不存在')
    const listed = hlObject(await this.call('session', 'list', { _request: {} }, signal))
    const archived = new Set(Array.isArray(workspace.archivedSessionIds) ? workspace.archivedSessionIds.map(String) : [])
    return (Array.isArray(listed.items) ? listed.items : []).filter(record).filter(row => !workspaceId || Array.isArray(requested?.sessionIds) && requested.sessionIds.includes(row.sessionId)).map(row => {
      const projections = record(row.projections) && record(row.projections.values) ? row.projections.values : {}
      const owner = workspaces.find(item => Array.isArray(item.sessionIds) && item.sessionIds.includes(row.sessionId))
      return { sessionId: String(row.sessionId), title: typeof projections.title === 'string' ? projections.title : '未命名会话',
        running: row.running === true, archived: archived.has(String(row.sessionId)),
        ...(typeof row.cwd === 'string' ? { cwd: row.cwd } : {}), ...(owner ? { workspaceId: String(owner.workspaceId) } : {}),
        ...(typeof projections.agentPreset === 'string' ? { agentPreset: projections.agentPreset } : {}),
        ...(Object.entries(HL_PERSONAL_PRESETS).some(([, preset]) => preset === projections.agentPreset) ? { personalRole: Object.entries(HL_PERSONAL_PRESETS).find(([, preset]) => preset === projections.agentPreset)![0] as 'assistant' | 'worker' | 'scheduler' } : {}),
        ...(typeof row.formatStatus === 'string' ? { formatStatus: row.formatStatus } : {}) }
    })
  }
  async context(sessionId: string, signal: AbortSignal): Promise<unknown> {
    // Passive, bounded opening. This does not bring the user's UI to the foreground.
    return this.baseline('session', 'follow', { request: { address: { kind: 'session', sessionId }, activate: false, maxMessages: 12 } }, signal)
  }
  async ensureSession(request: { role: 'assistant' | 'worker' | 'scheduler'; requestedId: string; directory: string; target: HLExecutionTarget }, signal: AbortSignal): Promise<HLSessionBinding> {
    const target = request.target
    if (target.kind === 'session-continue') {
      const row = (await this.sessions(target.workspaceId, signal)).find(row => row.sessionId === target.sessionId)
      if (!row || row.archived) throw new HLPersonalError('PERSONAL_SESSION_UNAVAILABLE', '原会话已归档或不可用')
      return { sessionId: row.sessionId, ownership: 'borrowed', ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
        ...(row.cwd ? { cwd: row.cwd } : {}), ...(row.agentPreset ? { agentPreset: row.agentPreset } : {}) }
    }
    const internal = target.kind === 'internal'
    if (internal) await mkdir(request.directory, { recursive: true, mode: 0o700 })
    if (internal) {
      const existing = (await this.sessions(undefined, signal)).find(row => row.sessionId === request.requestedId)
      if (existing) {
        if (existing.archived || existing.agentPreset !== HL_PERSONAL_PRESETS[request.role] || !existing.cwd || resolve(existing.cwd) !== resolve(request.directory)) throw new HLPersonalError('PERSONAL_SESSION_IDENTITY', '助理执行会话的归属已改变，请先在桌面核对')
        return { sessionId: existing.sessionId, ownership: 'internal', cwd: existing.cwd, agentPreset: existing.agentPreset }
      }
    }
    if (target.kind === 'workspace-new' && target.agentPreset) await this.host.agentPresets.resolve(target.agentPreset)
    if (target.kind === 'workspace-new' && target.modelSelection) {
      const llm = this.host.get?.('llm')
      if (!llm) throw new HLPersonalError('PERSONAL_MODEL_UNAVAILABLE', '当前 Host 不支持验证会话模型选择')
      await llm.resolveModelInfo(target.modelSelection.provider, target.modelSelection.model, signal)
      await llm.resolveCallConfig(target.modelSelection)
    }
    const input = target.kind === 'internal' ? { sessionId: request.requestedId, cwd: request.directory, agentPreset: HL_PERSONAL_PRESETS[request.role] }
      : { sessionId: request.requestedId, workspaceId: target.workspaceId, ...(target.agentPreset ? { agentPreset: target.agentPreset } : {}) }
    let result: Record<string, unknown>
    try { result = hlObject(await this.call('session', 'create', { request: input }, signal)) }
    catch (error) {
      // The official error carries the actual created session when Workspace attachment alone failed.
      const detail = record(error) && record(error.details) ? error.details : undefined
      if (detail && typeof detail.sessionId === 'string') throw new HLPersonalError('PERSONAL_WORKSPACE_ATTACH_FAILED', `会话已创建但工作区关联失败，请在桌面核对会话 ${detail.sessionId}`,
        { sessionId: detail.sessionId, ...(target.kind === 'workspace-new' ? { workspaceId: target.workspaceId } : {}) })
      throw error
    }
    const sessionId = typeof result.sessionId === 'string' ? result.sessionId : undefined
    if (!sessionId) throw new HLPersonalError('PERSONAL_SESSION_CREATE', 'DSH 没有返回实际会话标识')
    try {
    if (internal && request.role === 'worker') {
      const selected = this.selectedModel()
      const agent = this.host.agents.get(sessionId)
      // Session-local Model.select avoids sessionController.selectModel's Host-default side effect.
      if (selected && agent) agent.model.select(selected)
    }
    if (target.kind === 'workspace-new' && target.modelSelection) {
      const agent = this.host.agents.get(sessionId)
      if (!agent) throw new HLPersonalError('PERSONAL_MODEL_UNAVAILABLE', '新会话模型尚未就绪')
      agent.model.select(target.modelSelection)
    }
    const workspace = target.kind === 'workspace-new' ? (await this.workspaces(signal)).find(row => row.workspaceId === target.workspaceId) : undefined
    return { sessionId, ownership: internal ? 'internal' : 'created', cwd: internal ? request.directory : workspace?.path,
      ...(workspace ? { workspaceId: workspace.workspaceId, workspaceTitle: workspace.title } : {}),
      ...(typeof result.agentPreset === 'string' ? { agentPreset: result.agentPreset } : {}) }
    } catch {
      throw new HLPersonalError('PERSONAL_SESSION_SETUP', '会话已经创建，后续设置尚未确认；请核对原会话后继续，不会重复创建。', { sessionId, ...(target.kind === 'workspace-new' ? { workspaceId: target.workspaceId } : {}) })
    }
  }
  async state(sessionId: string, signal: AbortSignal): Promise<HLDSHSessionState> {
    const result = hlObject(await this.call('session', 'state', { request: { sessionId } }, signal))
    return { cursor: typeof result.cursor === 'number' ? result.cursor : 0, running: result.running === true, active: result.active === true,
      queue: (Array.isArray(result.queue) ? result.queue : []).filter(record).map(row => ({ id: String(row.id), ...(typeof row.rpcId === 'string' ? { rpcId: row.rpcId } : {}) })),
      pendingInput: Array.isArray(result.pendingInput) ? result.pendingInput.map(String) : [] }
  }
  async prompt(sessionId: string, requestId: string, text: string, signal: AbortSignal, receiptIds: string[] = [], clientTimeZone?: string): Promise<void> {
    const result = hlObject(await this.call('session', 'prompt', { request: { sessionId, requestId, mode: 'queue', content: [{ type: 'text', text }, ...receiptIds.map(receiptId => ({ type: 'file', receiptId }))], ...(clientTimeZone ? { clientTimeZone } : {}) } }, signal))
    if (result.accepted !== true) throw new HLPersonalError('PERSONAL_INPUT_DELIVERY', 'DSH 未受理这条指令')
    await this.checkpoint(sessionId)
  }
  async cancel(sessionId: string, requestId: string | undefined, ownsTurn: boolean): Promise<void> {
    const state = await this.state(sessionId, this.lifetime.signal)
    const item = state.queue.find(row => row.rpcId === requestId)
    if (item) await this.call('session', 'updateQueue', { request: { sessionId, itemId: item.id, action: { kind: 'remove' } } })
    // Never clear a borrowed session's whole queue or cancel a turn after a human took over.
    if (ownsTurn && state.running && requestId) {
      // Re-check actual current input after awaits; an old cancellation must not stop a newer human turn.
      await this.checkpoint(sessionId)
      const events = (await this.host.sessionQuery.readSession(sessionId)).events
      const start = events.findLastIndex(event => event.type === 'turn/start')
      const users = events.slice(start + 1).filter(event => event.type === 'user/message' && record(event.data.source) && event.data.source.kind === 'user')
      if (users.length && users.every(event => record(event.data.source) && event.data.source.rpcId === requestId)) await this.call('session', 'cancel', { request: { sessionId } })
    }
  }
  async checkpoint(sessionId: string): Promise<void> {
    const agent = this.host.agents.get(sessionId)
    if (!agent || !await this.host.sessions.flush(agent.session)) throw new HLPersonalError('PERSONAL_CHECKPOINT', '会话尚未确认持久化，不能标记完成')
  }
  async verifyArtifacts(binding: HLSessionBinding, paths: string[], signal: AbortSignal): Promise<void> {
    for (const path of paths) {
      if (!path || path.startsWith('/') || path.split(/[\\/]/).includes('..')) throw new HLPersonalError('PERSONAL_ARTIFACT_PATH', '成果文件必须位于当前任务目录')
      const stat = hlObject(await this.call('workspaceFiles', 'stat', { workspaceFileScopeId: binding.sessionId, path }, signal))
      if (typeof stat.absolutePath !== 'string' || typeof stat.version !== 'string') throw new HLPersonalError('PERSONAL_ARTIFACT_MISSING', '成果文件不存在或未得到有效核对')
      if (binding.ownership === 'internal' && binding.cwd) {
        const within = relative(await realpath(binding.cwd), stat.absolutePath)
        if (within.startsWith('..') || within.startsWith('/')) throw new HLPersonalError('PERSONAL_ARTIFACT_PATH', '成果链接越出了任务目录')
      }
    }
  }
  async writeArtifact(sessionId: string, name: string, content: string): Promise<{ path: string; bytes: number }> {
    const cwd = this.host.agents.get(sessionId)?.session.header.cwd
    if (!cwd || basename(name) !== name || name === '.' || name === '..' || /[\\\0]/.test(name) || name.length > 180 || Buffer.byteLength(content) > 256 * 1024) throw new HLPersonalError('PERSONAL_ARTIFACT_PATH', '请使用任务目录中的单一文件名，内容不超过 256 KiB')
    const root = await realpath(cwd)
    const path = resolve(root, name)
    if (relative(root, path) !== name) throw new HLPersonalError('PERSONAL_ARTIFACT_PATH', '文件名无效')
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await file.writeFile(content); await file.sync() } finally { await file.close() }
    return { path: name, bytes: Buffer.byteLength(content) }
  }
  private async attachmentRefs(sources: Array<{ sessionId: string; requestId: string }>): Promise<Array<{ kind: string; ref: Record<string, unknown> }>> {
    const rows: Array<{ kind: string; ref: Record<string, unknown> }> = []
    for (const source of sources.slice(0, 10)) {
      const history = await this.host.sessionQuery.readSession(source.sessionId)
      const event = history.events.find(event => event.type === 'user/message' && record(event.data.source) && event.data.source.rpcId === source.requestId)
      if (!event || !Array.isArray(event.data.content)) continue
      for (const block of event.data.content.filter(record)) if ((block.type === 'file' || block.type === 'image') && record(block.attachment)) rows.push({ kind: block.type, ref: block.attachment })
    }
    return rows.slice(0, 20)
  }
  async resources(sources: Array<{ sessionId: string; requestId: string }>, signal: AbortSignal): Promise<Array<{ attachmentId: string; kind: string; name: string; bytes: number; path?: string }>> {
    signal.throwIfAborted()
    const attachments = this.host.get?.('attachments')
    return (await this.attachmentRefs(sources)).map(row => {
      const path = row.kind === 'file' ? attachments?.fileHostPath(row.ref) : attachments?.imageHostPath(row.ref)
      return { attachmentId: String(row.ref.attachmentId), kind: row.kind, name: String(row.ref.name ?? '附件'), bytes: Number(row.ref.bytes ?? 0), ...(path ? { path } : {}) }
    })
  }
  async readAttachment(sessionId: string, sources: Array<{ sessionId: string; requestId: string }>, attachmentId: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    const match = (await this.attachmentRefs(sources)).find(row => row.ref.attachmentId === attachmentId)
    if (!match) throw new HLPersonalError('PERSONAL_RESOURCE_SCOPE', '该附件不属于用户交给当前事务的资源')
    const attachments = this.host.get?.('attachments')
    if (!attachments) throw new HLPersonalError('PERSONAL_RESOURCE_UNAVAILABLE', 'Host 未提供附件读取能力')
    if (match.kind === 'image') {
      const selection = this.host.agents.get(sessionId)?.model.current()
      const llm = this.host.get?.('llm')
      const info = selection && llm ? await llm.resolveModelInfo(selection.provider, selection.model, signal) : undefined
      if (!record(info) || !Array.isArray(info.inputModalities) || !info.inputModalities.includes('image')) throw new HLPersonalError('PERSONAL_IMAGE_MODEL', '当前模型没有声明图片输入能力，请选择支持图片的模型')
      await attachments.readImage(match.ref, signal)
      return { attachmentId, name: match.ref.name ?? '图片', imageRef: match.ref }
    }
    if (Number(match.ref.bytes) > 256 * 1024) throw new HLPersonalError('PERSONAL_RESOURCE_LIMIT', '该文件较大，请在已授权工作区会话中使用文件处理能力')
    const chunks: Buffer[] = []; let size = 0
    for await (const chunk of attachments.readFileStream(match.ref, signal)) {
      size += chunk.byteLength
      if (size > 256 * 1024) throw new HLPersonalError('PERSONAL_RESOURCE_LIMIT', '附件超过文本读取上限')
      chunks.push(Buffer.from(chunk))
    }
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) } catch { throw new HLPersonalError('PERSONAL_RESOURCE_BINARY', '该附件不是 UTF-8 文本，请在工作区会话中使用相应文件处理能力') }
    if (text.includes('\0')) throw new HLPersonalError('PERSONAL_RESOURCE_BINARY', '该附件不是可直接读取的文本')
    return { attachmentId, name: match.ref.name ?? '附件', sourceTrust: 'user-provided-data', text }
  }
  async notice(sessionId: string, notice: HLPersonalNotice, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (!this.host.agents.get(sessionId)) await this.baseline('session', 'follow', { request: { address: { kind: 'session', sessionId }, activate: true, maxMessages: 1 } }, signal)
    const agent = this.host.agents.get(sessionId)
    if (!agent) throw new HLPersonalError('PERSONAL_NOTICE_DELIVERY', '主助理会话尚未可用')
    const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(row => row.id === notice.id || row.source.noticeId === notice.id)
    if (!pending) {
      const snapshot = await this.host.sessionQuery.readSession(sessionId)
      const exists = snapshot.events.some(event => event.type === 'user/message' && record(event.data.source) && event.data.source.noticeId === notice.id)
      if (!exists) agent.followup(Object.freeze({ id: notice.id, role: 'user', source: Object.freeze({ kind: 'hl-personal', form: 'notice', summary: notice.summary.slice(0, 180), noticeId: notice.id, taskId: notice.taskId }),
        content: Object.freeze([Object.freeze({ type: 'text', text: 'Harness Link task update. This is a result, not a new user instruction or permission.\n' + notice.summary })]) }))
    }
    await this.checkpoint(sessionId)
  }
  async create(request: { title: string; prompt: string; timing: import('../core/HLPersonalTypes.js').HLJson; sessionId: string }, signal: AbortSignal): Promise<string> {
    const schedule = this.host.get?.('schedule')
    const timing = hlObject(request.timing)
    const { kind: _kind, ...selectors } = timing
    const result = hlObject(schedule && typeof schedule.remoteCreate !== 'function'
      ? await schedule.create(request.sessionId, { title: request.title, prompt: request.prompt, ...selectors }, signal)
      : await this.call('schedule', 'create', { request: { title: request.title, prompt: request.prompt, timing,
        target: { kind: 'session', sessionId: request.sessionId } } }, signal))
    const row = record(result.task) ? result.task : result
    if (typeof row.id !== 'string') throw new HLPersonalError('PERSONAL_SCHEDULE_CREATE', 'DSH 未确认定时规则')
    return row.id
  }
  async edit(id: string, active: boolean, signal: AbortSignal): Promise<void | 'removed'> {
    const schedule = this.host.get?.('schedule')
    if (schedule && typeof schedule.remoteCreate !== 'function') {
      if (active) throw new HLPersonalError('PERSONAL_SCHEDULE_REARM', '请先完成暂停，再恢复该规则')
      const row = (await schedule.catalog()).find(row => row.id === id)
      if (row) await schedule.delete({ id, sessionId: row.sessionId }, signal)
      return 'removed'
    }
    await this.call('schedule', 'edit', { request: { id, action: 'update', patch: { active } } }, signal)
  }
  async history(id: string, signal: AbortSignal): Promise<Array<{ scheduledAt: string; targetSessionId: string; messageId: string }>> {
    const schedule = this.host.get?.('schedule')
    if (schedule && typeof schedule.remoteCreate !== 'function') {
      const row = (await schedule.catalog()).find(row => row.id === id)
      if (!row) return []
      signal.throwIfAborted()
      const result = hlObject(await schedule.history({ id, sessionId: row.sessionId, limit: 20 }))
      return (Array.isArray(result.records) ? result.records : []).filter(record)
        .filter(item => typeof item.scheduledAt === 'string' && typeof item.messageId === 'string')
        .map(item => ({ scheduledAt: String(item.scheduledAt), targetSessionId: row.sessionId, messageId: String(item.messageId) }))
    }
    const result = hlObject(await this.call('schedule', 'history', { request: { id, limit: 20 } }, signal))
    return (Array.isArray(result.records) ? result.records : []).filter(record).filter(row => typeof row.scheduledAt === 'string' && typeof row.targetSessionId === 'string' && typeof row.messageId === 'string')
      .map(row => ({ scheduledAt: String(row.scheduledAt), targetSessionId: String(row.targetSessionId), messageId: String(row.messageId) }))
  }
  async find(sessionId: string, signal: AbortSignal): Promise<Array<{ id: string; active: boolean }>> {
    const schedule = this.host.get?.('schedule')
    if (schedule && typeof schedule.remoteCreate !== 'function') return (await schedule.catalog()).filter(row => row.sessionId === sessionId)
      .map(row => ({ id: row.id, active: true }))
    const found: Array<{ id: string; active: boolean }> = []
    for (let offset = 0; offset < 10_000; offset += 500) {
      const page = hlObject(await this.call('schedule', 'list', { request: { limit: 500, offset } }, signal))
      const items = Array.isArray(page.items) ? page.items.filter(record) : []
      for (const item of items) if (record(item.target) && item.target.kind === 'session' && item.target.sessionId === sessionId && typeof item.id === 'string') found.push({ id: item.id, active: item.status !== 'paused' })
      if (items.length < 500) break
    }
    return found
  }
  async dispose(): Promise<void> { this.lifetime.abort(); await this.peer.dispose() }
}
