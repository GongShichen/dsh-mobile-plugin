/** Test-only LLM adapter: drives the real loop, tool pipeline and approval service without network I/O. */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export interface DeterministicHost {
  llm: { registerAdapter(providers: string[], adapter: unknown): unknown }
  tools: { register(tool: unknown): unknown }
  approval: { request(request: { agent: object; toolName: string; callId: string; reason: string; signal: AbortSignal }): Promise<string> }
}

export async function installDeterministicProvider(host: DeterministicHost, runtimeRoot: string): Promise<void> {
  const llm = await import(pathToFileURL(join(runtimeRoot, 'node_modules/@deepseek-ai/dsh-llm/lib/index.js')).href)
  const tools = await import(pathToFileURL(join(runtimeRoot, 'node_modules/@deepseek-ai/dsh-tools/lib/index.js')).href)
  class FixtureAdapter extends llm.LlmAdapter {
    private calls = 0
    async listModels(provider: string) { return [{ provider, id: 'mobile-fixture', name: 'Deterministic mobile fixture' }] }
    async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
    async *stream(options: { purpose?: string; signal?: AbortSignal }): AsyncIterable<unknown> {
      if (options.purpose !== undefined) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'Mobile fixture' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Mobile fixture' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      this.calls++
      const reasoning = this.calls === 1 ? 'Checking the mobile approval and tool flow.' : 'The approved tool returned verified data.'
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 0, text: reasoning }
      await delay(20, undefined, { signal: options.signal })
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }
      if (this.calls === 1) {
        const args = JSON.stringify({ value: 'verified' })
        yield { type: 'block-start', index: 1, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 1, id: 'mobile-smoke-tool-1', name: 'mobile_smoke_echo', argumentsDelta: args }
        await delay(20, undefined, { signal: options.signal })
        yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'mobile-smoke-tool-1', name: 'mobile_smoke_echo', arguments: args } }
        yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 7, reasoningTokens: 3 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        const pieces = ['Mobile ', 'round trip ', 'verified.']
        yield { type: 'block-start', index: 1, blockType: 'text' }
        for (const text of pieces) { yield { type: 'text-delta', index: 1, text }; await delay(20, undefined, { signal: options.signal }) }
        yield { type: 'block-end', index: 1, block: { type: 'text', text: pieces.join('') } }
        yield { type: 'usage', usage: { inputTokens: 17, outputTokens: 9, reasoningTokens: 3 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  host.llm.registerAdapter(['mobile-fixture'], new FixtureAdapter())
  host.tools.register(tools.defineTool({
    name: 'mobile_smoke_echo', description: 'Return a deterministic string after explicit smoke-test approval.',
    parameters: { value: { type: 'string', required: true, description: 'Fixture value.' } },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    async execute(args: { value: string }, exec: { agent?: object; callId: string; signal: AbortSignal }) {
      if (exec.agent === undefined) throw new Error('Fixture tool requires the real Agent')
      const outcome = await host.approval.request({ agent: exec.agent, toolName: 'mobile_smoke_echo', callId: exec.callId,
        reason: 'Verify mobile approval routing for the harmless fixture tool.', signal: exec.signal })
      if (outcome !== 'allowed-once') throw new Error(`Fixture approval failed: ${outcome}`)
      await delay(20, undefined, { signal: exec.signal })
      return `Tool result: ${args.value}`
    },
  }))
}
