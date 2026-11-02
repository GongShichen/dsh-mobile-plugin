import test from 'node:test'
import assert from 'node:assert/strict'
import { hlExecutionTarget } from '../src/personal/core/HLExecutionTargetResolver.ts'
import { HL_PERSONAL_WEB_METHODS } from '../src/personal/transport/HLPersonalAPI.ts'
import type { HLExecutionTarget } from '../src/personal/core/HLPersonalTypes.ts'

test('Personal execution targets retain real references and reject arbitrary host dispatch', () => {
  const targets: HLExecutionTarget[] = [{ kind: 'internal' },
    { kind: 'workspace-new', workspaceId: 'project', agentPreset: 'standard', modelSelection: { provider: 'test', model: 'model', reasoningEffort: 'high' } },
    { kind: 'session-continue', workspaceId: 'project', sessionId: 'original' }]
  for (const target of targets) assert.deepEqual(hlExecutionTarget(Object.freeze(target)), target)
  assert.throws(() => hlExecutionTarget({ kind: 'invoke', namespace: 'shell', method: 'execute' }))
  assert.equal(new Set(HL_PERSONAL_WEB_METHODS).size, HL_PERSONAL_WEB_METHODS.length)
  assert.ok(HL_PERSONAL_WEB_METHODS.includes('createTask'))
  assert.ok(HL_PERSONAL_WEB_METHODS.includes('reconcileRoutine'))
  assert.ok(!HL_PERSONAL_WEB_METHODS.some(method => String(method) === 'invoke'))
})
