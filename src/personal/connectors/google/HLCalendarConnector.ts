import { createHash } from 'node:crypto'
import type { HLConnectorOperation, HLParsedOperation } from '../../ports/HLConnectorPort.js'
import type { HLJson } from '../../core/HLPersonalTypes.js'
import { HLPersonalError, hlInteger, hlObject, hlText } from '../../core/HLPersonalValidation.js'
import { hlEmail } from '../../core/HLAuthorizationService.js'
import type { HLGoogleOAuth } from './HLGoogleOAuth.js'

const eventId = (id: string) => 'hl' + createHash('sha256').update(id).digest('hex').slice(0, 48)
function instant(value: unknown, name: string): string {
  const text = hlText(value, name, 100)
  if (!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(text) || !Number.isFinite(Date.parse(text))) throw new HLPersonalError('PERSONAL_INPUT', `${name}需要包含时区的完整日期时间`)
  return new Date(text).toISOString()
}
function parse(value: unknown, write: boolean, update = false): HLParsedOperation {
  const args = hlObject(value)
  const calendarId = args.calendarId === undefined ? 'primary' : hlText(args.calendarId, '日历 ID', 300)
  if (!write) {
    const timeMin = instant(args.timeMin, '开始时间'); const timeMax = instant(args.timeMax, '结束时间')
    if (Date.parse(timeMax) <= Date.parse(timeMin) || Date.parse(timeMax) - Date.parse(timeMin) > 31 * 86400_000) throw new HLPersonalError('PERSONAL_INPUT', '单次日程查询范围应在 31 天内')
    return { input: { calendarId, timeMin, timeMax, maxResults: args.maxResults === undefined ? 20 : hlInteger(args.maxResults, '数量', 1, 100) }, recipients: [], calendarIds: [calendarId], preview: '查询指定时间范围的日程' }
  }
  const summary = hlText(args.summary, '日程标题', 200)
  const start = instant(args.start, '开始时间'); const end = instant(args.end, '结束时间')
  if (Date.parse(end) <= Date.parse(start)) throw new HLPersonalError('PERSONAL_INPUT', '日程结束时间必须晚于开始时间')
  const timeZone = args.timeZone === undefined ? 'Asia/Shanghai' : hlText(args.timeZone, '时区', 100)
  try { new Intl.DateTimeFormat('en', { timeZone }).format() } catch { throw new HLPersonalError('PERSONAL_INPUT', '时区无效') }
  const attendees = args.attendees === undefined ? [] : Array.isArray(args.attendees) && args.attendees.length <= 10 ? args.attendees.map(item => hlEmail(hlText(item, '参会邮箱', 254)))
    : (() => { throw new HLPersonalError('PERSONAL_INPUT', '参会邮箱数量无效') })()
  const input: Record<string, HLJson> = { calendarId, summary, start, end, timeZone, attendees,
    ...(args.description === undefined ? {} : { description: hlText(args.description, '日程说明', 8000) }),
    ...(args.location === undefined ? {} : { location: hlText(args.location, '地点', 300) }) }
  if (update) { input.eventId = hlText(args.eventId, '日程 ID', 1024); input.etag = hlText(args.etag, '日程版本', 300) }
  return { input, recipients: attendees, calendarIds: [calendarId], preview: `${update ? '修改' : '创建'}日程「${summary}」\n${start} — ${end}\n${timeZone}${attendees.length ? '\n邀请：' + attendees.join('、') : ''}` }
}
export function hlCalendarOperations(google: HLGoogleOAuth): HLConnectorOperation[] {
  return [
    { id: 'google.calendar.calendars', effect: 'read', description: 'List owned calendars: {}. Default to primary unless the user selects another calendar.',
      parse() { return { input: {}, recipients: [], calendarIds: [], preview: '读取拥有的日历目录' } },
      async execute(account, _input, _id, signal) {
        const result = await google.request(account, 'calendar', '/users/me/calendarList?minAccessRole=owner&maxResults=100', {}, signal)
        return { items: (Array.isArray(result.items) ? result.items as Array<Record<string, unknown>> : []).map(row => ({ id: String(row.id), summary: String(row.summary ?? ''), timeZone: String(row.timeZone ?? ''), primary: row.primary === true })) }
      } },
    { id: 'google.calendar.list', effect: 'read', description: 'List events: {calendarId?:primary,timeMin:ISO8601,timeMax:ISO8601,maxResults?:20}; one request covers at most 31 days.', parse: value => parse(value, false),
      async execute(account, input, _id, signal) {
        const query = new URLSearchParams({ timeMin: String(input.timeMin), timeMax: String(input.timeMax), singleEvents: 'true', orderBy: 'startTime', maxResults: String(input.maxResults) })
        const result = await google.request(account, 'calendar', `/calendars/${encodeURIComponent(String(input.calendarId))}/events?${query}`, {}, signal)
        const items = Array.isArray(result.items) ? result.items as Array<Record<string, unknown>> : []
        return { items: items.map(row => ({ id: String(row.id), summary: String(row.summary ?? ''), start: row.start as HLJson, end: row.end as HLJson,
          etag: String(row.etag ?? ''), htmlLink: String(row.htmlLink ?? ''), status: String(row.status ?? ''),
          attendees: (Array.isArray(row.attendees) ? row.attendees as Array<Record<string, unknown>> : []).map(item => ({ email: String(item.email ?? '') })) })) }
      } },
    ...[false, true].map((update): HLConnectorOperation => ({ id: update ? 'google.calendar.update' : 'google.calendar.create', effect: 'write',
      description: `${update ? 'Update' : 'Create'} event: {calendarId?:primary,summary,start:ISO,end:ISO,timeZone,description?,location?,attendees?:email[]${update ? ',eventId,etag' : ''}}. Attendees cause invitations and require recipient authorization.`,
      parse: value => parse(value, true, update),
      async execute(account, input, actionId, signal) {
        const path = `/calendars/${encodeURIComponent(String(input.calendarId))}/events${update ? '/' + encodeURIComponent(String(input.eventId)) : ''}`
        if (update) {
          const previous = await google.request(account, 'calendar', path, {}, signal)
          const oldAttendees = Array.isArray(previous.attendees) ? previous.attendees as Array<Record<string, unknown>> : []
          const recipients = new Set((input.attendees as string[]) ?? [])
          if (oldAttendees.some(row => typeof row.email === 'string' && !recipients.has(row.email.toLowerCase()))) throw new HLPersonalError('PERSONAL_CALENDAR_ATTENDEES', '原日程的邀请对象发生变化，请核对完整参会列表后重新准备')
        }
        const body = { ...(!update ? { id: eventId(actionId) } : {}), summary: input.summary,
          start: { dateTime: input.start, timeZone: input.timeZone }, end: { dateTime: input.end, timeZone: input.timeZone },
          ...(input.description ? { description: input.description } : {}), ...(input.location ? { location: input.location } : {}),
          attendees: (input.attendees as string[]).map(email => ({ email })) }
        const result = await google.request(account, 'calendar', path + '?sendUpdates=' + ((input.attendees as string[]).length ? 'all' : 'none'),
          { method: update ? 'PATCH' : 'POST', body, ...(update ? { etag: String(input.etag) } : {}) }, signal)
        if (!result.id || !result.etag) throw new HLPersonalError('PERSONAL_GOOGLE_RESPONSE', 'Google 未返回日程回执')
        return { id: String(result.id), etag: String(result.etag), htmlLink: String(result.htmlLink ?? ''), summary: String(result.summary ?? '') }
      },
      async reconcile(action, signal) {
        const id = update ? String(action.input.eventId) : eventId(action.id)
        try {
          const result = await google.request(action.accountId, 'calendar', `/calendars/${encodeURIComponent(String(action.input.calendarId))}/events/${encodeURIComponent(id)}`, {}, signal)
          const start = hlObject(result.start); const end = hlObject(result.end)
          if (result.summary !== action.input.summary || Date.parse(String(start.dateTime)) !== Date.parse(String(action.input.start)) || Date.parse(String(end.dateTime)) !== Date.parse(String(action.input.end))) return { state: 'unknown' }
          if (action.input.description !== undefined && result.description !== action.input.description || action.input.location !== undefined && result.location !== action.input.location) return { state: 'unknown' }
          const attendees = (Array.isArray(result.attendees) ? result.attendees as Array<Record<string, unknown>> : []).map(row => String(row.email).toLowerCase()).sort()
          if (JSON.stringify(attendees) !== JSON.stringify([...(action.input.attendees as string[])].sort())) return { state: 'unknown' }
          if (update && result.etag === action.input.etag) return { state: 'unknown' }
          return { state: 'confirmed', result: { id, etag: String(result.etag ?? ''), htmlLink: String(result.htmlLink ?? '') } }
        } catch { return { state: 'unknown' } }
      },
    })),
  ]
}
