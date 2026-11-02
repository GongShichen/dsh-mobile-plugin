import type { HLPersonalPersistence } from '../../ports/HLPersonalPersistence.js'
import type { HLPersonalTriggerSource } from '../../ports/HLPersonalTriggerSource.js'
import type { HLActionBroker } from '../HLActionBroker.js'
import { HLPersonalError, hlObject, hlText } from '../../core/HLPersonalValidation.js'

/** Only threads already read or sent by this task can become reply watches. */
export function hlGmailReplySource(store: HLPersonalPersistence, actions: HLActionBroker, now: () => number = Date.now): HLPersonalTriggerSource {
  return { id: 'google.gmail.reply', description: 'Follow a reply in a thread this task already read or sent: {accountId,threadId}. Give an explicit deadline.',
    parse(taskId, value) {
      const args = hlObject(value); const accountId = hlText(args.accountId, '账户', 128); const threadId = hlText(args.threadId, '线程', 200)
      const sent = store.list('action').find(row => row.taskId === taskId && row.accountId === accountId && row.operation === 'google.gmail.send' && row.state === 'confirmed'
        && row.result && typeof row.result === 'object' && !Array.isArray(row.result) && row.result.threadId === threadId)
      const read = store.get('marker', `mail-resource:${taskId}:${accountId}:${threadId}`)
      if (!sent && !read) throw new HLPersonalError('PERSONAL_SOURCE_SCOPE', '只能跟进当前事务已读取或发送的邮件线程')
      const result = sent?.result && typeof sent.result === 'object' && !Array.isArray(sent.result) ? sent.result : {}
      return { accountId, threadId, after: now(), baselineId: read?.value ?? (typeof result.id === 'string' ? result.id : '') }
    },
    async poll(taskId, params, cursor, signal) {
      const result = await actions.query(taskId, 'google.gmail.thread', String(params.accountId), { threadId: params.threadId }, signal)
      const object = hlObject(result); const messages = Array.isArray(object.messages) ? object.messages as Array<Record<string, unknown>> : []
      const ownEmail = store.get('connection', String(params.accountId))?.email.toLowerCase() ?? ''
      const fresh = messages.filter(row => row.id !== (cursor ?? params.baselineId) && Number(row.internalDate) > Number(params.after)
        && ownEmail && !String(row.from).toLowerCase().includes(ownEmail))
      return { cursor: String(messages.at(-1)?.id ?? cursor ?? params.baselineId), events: fresh.map(row => ({ id: String(row.id), summary: '指定邮件线程收到回复' })) }
    } }
}
