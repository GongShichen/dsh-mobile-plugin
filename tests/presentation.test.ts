import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PresentationTracker } from '../src/sync/presentation.js'
const captured = JSON.parse(readFileSync(new URL('./fixtures/captured-dsh-turn.json', import.meta.url), 'utf8'))
const source = captured.frames.flatMap((frame: any) => frame.type === 'event' ? [frame.event] : [])

test('completed turn presentation matches exact Web accounting and retains its branch boundary', () => {
  const tracker = new PresentationTracker()
  const events = structuredClone(source)
  for (const event of events) if (event.type === 'assistant/message') event.data.usage.totalTokens = event.data.usage.inputTokens + event.data.usage.outputTokens
  tracker.ingest(events.map((event: unknown) => ({ event })))
  const turns = tracker.snapshot().turns as any[]
  assert.equal(turns.length, 1)
  assert.equal(turns[0].status, 'completed')
  assert.equal(turns[0].endSeq, 25)
  assert.equal(turns[0].text, 'Mobile round trip verified.')
  assert.equal(turns[0].branchAvailable, true)
  assert.equal(turns[0].tokenUsage.totalTokens, 44)
  assert.equal(turns[0].tokenUsage.uncachedInputTokens, 28)
  assert.equal(turns[0].tokenUsage.outputTokens, 16)
  assert.equal(turns[0].tokenUsage.reasoningTokens, 6)
  assert.equal(turns[0].tokenUsage.cacheReadTokens, undefined)
  tracker.append(events.at(-1))
  assert.equal((tracker.snapshot().turns as any[])[0].tokenUsage.totalTokens, 44)
})

test('partial history and incomplete provider usage never fabricate a token total', () => {
  const tracker = new PresentationTracker()
  tracker.ingest(source.filter((event: any) => event.type !== 'turn/start').map((event: unknown) => ({ event })))
  assert.equal((tracker.snapshot().turns as any[])[0].tokenUsage, undefined)
  tracker.ingest(source.map((event: unknown) => ({ event })))
  assert.equal((tracker.snapshot().turns as any[])[0].tokenUsage, undefined)
})
