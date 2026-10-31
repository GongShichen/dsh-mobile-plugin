import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as tick } from 'node:timers/promises'
import { HLInteractionChannel, validateQuestionAnswer } from '../src/sync/HLInteractionChannel.ts'

function fixture() {
  const input: unknown[] = [{ type: 'ready', clientId: 'client' }]
  let wake: (() => void) | undefined
  let opens = 0
  let closed = false
  const posts: unknown[] = []
  const parent = new AbortController()
  const channel = new HLInteractionChannel(async signal => {
    opens++
    return { async *[Symbol.asyncIterator]() {
      const end = () => { wake?.(); wake = undefined }
      signal.addEventListener('abort', end)
      try {
        while (!signal.aborted) {
          if (input.length) yield input.shift()
          else await new Promise<void>(resolve => { wake = resolve })
        }
      } finally { signal.removeEventListener('abort', end); closed = true }
    } }
  }, async result => { posts.push(result) }, parent.signal)
  return { channel, posts, parent, opens: () => opens, closed: () => closed,
    push: (frame: unknown) => { input.push(frame); wake?.(); wake = undefined } }
}
const approval = (id = 'approve') => ({ type: 'waterfall', event: 'approval/request', eventId: id, agentId: 'session', request: { toolName: 'safe_fixture', reason: 'Harmless fixture only' } })
async function until(check: () => boolean) {
  const end = Date.now() + 2000
  while (!check()) { assert.ok(Date.now() < end, 'Expected event did not arrive'); await tick() }
}

test('list and interaction consumers share one Gateway generation and replay pending requests', async t => {
  const f = fixture(); t.after(() => f.channel.close())
  const signal = new AbortController()
  const list = f.channel.subscribe(false, signal.signal)[Symbol.asyncIterator]()
  assert.equal((await list.next()).value.type, 'ready')
  f.push(approval())
  await until(() => f.channel.request('client', 'approve') !== undefined)
  const interaction = f.channel.subscribe(true, signal.signal)[Symbol.asyncIterator]()
  assert.equal((await interaction.next()).value.clientId, 'client')
  assert.deepEqual((await interaction.next()).value, approval())
  assert.equal(f.opens(), 1)
  f.push({ type: 'emit', event: 'api-session/added', args: [] })
  assert.equal((await list.next()).value.type, 'emit')
  assert.deepEqual(await f.channel.reply({ clientId: 'client', eventId: 'approve', outcome: { kind: 'result', value: 'allowed-once' } }, signal.signal), { accepted: true })
  assert.deepEqual((await interaction.next()).value, { type: 'cancel', eventId: 'approve' })
  assert.equal(f.channel.request('client', 'approve'), undefined)
  signal.abort(); await interaction.return?.(); await list.return?.()
})

test('desktop settlement cancels mobile UI; stale or foreign generations cannot answer again', async t => {
  const f = fixture(); t.after(() => f.channel.close())
  const signal = new AbortController()
  const stream = f.channel.subscribe(true, signal.signal)[Symbol.asyncIterator]()
  await stream.next(); f.push(approval()); await stream.next()
  assert.deepEqual(await f.channel.reply({ clientId: 'other-client', eventId: 'approve', outcome: { kind: 'result', value: 'allowed-once' } }, signal.signal), { accepted: false })
  f.push({ type: 'cancel', eventId: 'approve' }); await stream.next()
  assert.deepEqual(await f.channel.reply({ clientId: 'client', eventId: 'approve', outcome: { kind: 'result', value: 'allowed-once' } }, signal.signal), { accepted: false })
  assert.equal(f.posts.length, 0)
  signal.abort(); await stream.return?.()
})

test('unknown waterfalls delegate instead of occupying an invisible mobile answerer', async t => {
  const f = fixture(); t.after(() => f.channel.close())
  const signal = new AbortController()
  const stream = f.channel.subscribe(true, signal.signal)[Symbol.asyncIterator]()
  await stream.next()
  f.push({ type: 'waterfall', event: 'plugin/private-ui', eventId: 'unsupported', agentId: 'session', request: {} })
  await until(() => f.posts.length === 1)
  assert.deepEqual(f.posts[0], { clientId: 'client', eventId: 'unsupported', outcome: { kind: 'next' } })
  f.push(approval('supported'))
  assert.equal((await stream.next()).value.eventId, 'supported')
  signal.abort(); await stream.return?.()
})

test('approval results are closed vocabulary and Peer disposal releases its Gateway stream', async () => {
  const f = fixture()
  const signal = new AbortController()
  const stream = f.channel.subscribe(true, signal.signal)[Symbol.asyncIterator]()
  await stream.next(); f.push(approval()); await stream.next()
  await assert.rejects(f.channel.reply({ clientId: 'client', eventId: 'approve', outcome: { kind: 'result', value: 'allowed-always' } }, signal.signal), { code: 'mobile/invalid-answer' })
  assert.equal(f.posts.length, 0)
  await f.channel.close()
  assert.equal(f.closed(), true)
  await stream.return?.()
})

test('question batches preserve exact labels, allow skips and multiselect comments, and reject invented grants', () => {
  const questions = [{ id: 'q', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }, { id: 'text' }]
  validateQuestionAnswer(questions, { answers: [{ id: 'q', selected: ['A', 'B'], custom: 'comment' }, { id: 'text', selected: [] }] })
  assert.throws(() => validateQuestionAnswer(questions, { answers: [{ id: 'q', selected: ['A'] }, { id: 'q', selected: [] }] }), { code: 'mobile/invalid-answer' })
  const permission = [{ id: 'permission', intent: { kind: 'approval' }, options: [{ label: 'once' }, { label: 'no' }] }]
  validateQuestionAnswer(permission, { answers: [{ id: 'permission', selected: ['once'] }] })
  for (const answer of [{ selected: ['always'] }, { selected: [] }, { selected: ['once'], custom: 'yes' }]) {
    assert.throws(() => validateQuestionAnswer(permission, { answers: [{ id: 'permission', ...answer }] }), { code: 'mobile/invalid-answer' })
  }
})
