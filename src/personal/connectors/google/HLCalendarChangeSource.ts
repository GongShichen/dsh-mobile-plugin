import { createHash } from 'node:crypto'
import type { HLPersonalPersistence } from '../../ports/HLPersonalPersistence.js'
import type { HLPersonalTriggerSource } from '../../ports/HLPersonalTriggerSource.js'
import type { HLActionBroker } from '../HLActionBroker.js'
import { HLPersonalError, hlCanonical, hlObject, hlText } from '../../core/HLPersonalValidation.js'
import type { HLJson } from '../../core/HLPersonalTypes.js'

export function hlCalendarWatchKey(taskId: string, accountId: string, input: Record<string, unknown>): string {
  const instant = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : value
  const range = { calendarId: input.calendarId ?? 'primary', timeMin: instant(input.timeMin), timeMax: instant(input.timeMax) }
  return `calendar-resource:${taskId}:${accountId}:` + createHash('sha256').update(hlCanonical(range)).digest('hex')
}
export function hlCalendarDigest(result: HLJson): string {
  return createHash('sha256').update(hlCanonical(result)).digest('hex')
}
/** A previously requested, bounded calendar window; no account-wide scan is installed. */
export function hlCalendarChangeSource(store: HLPersonalPersistence, actions: HLActionBroker): HLPersonalTriggerSource {
  return { id: 'google.calendar.changed', description: 'Watch a calendar window already read by this task: {accountId,calendarId,timeMin,timeMax}. Give an explicit deadline.',
    parse(taskId, value) {
      const params = hlObject(value)
      const accountId = hlText(params.accountId, '账户', 128)
      const scope = { calendarId: params.calendarId ?? 'primary', timeMin: params.timeMin, timeMax: params.timeMax }
      const marker = store.get('marker', hlCalendarWatchKey(taskId, accountId, scope))
      if (!marker) throw new HLPersonalError('PERSONAL_SOURCE_SCOPE', '只能跟进当前事务已查询的日程范围')
      const previous = hlObject(JSON.parse(marker.value))
      return { accountId, input: previous.input as Record<string, HLJson>, baseline: String(previous.digest) }
    },
    async poll(taskId, params, cursor, signal) {
      const result = await actions.query(taskId, 'google.calendar.list', String(params.accountId), params.input, signal)
      const digest = hlCalendarDigest(result)
      return { cursor: digest, events: digest === (cursor ?? params.baseline) ? [] : [{ id: digest, summary: '指定日程范围发生变化' }] }
    } }
}
