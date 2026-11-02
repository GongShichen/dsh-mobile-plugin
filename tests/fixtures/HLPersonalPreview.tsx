/** The production panel, mounted only by the opt-in isolated QA Host. */
import { createRoot } from 'react-dom/client'
import { HLPersonalPanel } from '../../src/personal/client/HLPersonalPanel.js'
import type { HLOwnerCall } from '../../src/client/HLContract.js'

const call: HLOwnerCall = async <T,>(method: string, payload: unknown = {}): Promise<T> => {
  const endpoint = `personalAccess/${method}`
  const response = await fetch(`/api/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: endpoint, payload }) })
  const result = (await response.json()).result
  if (!result?.ok) throw new Error(result?.error?.message || 'Host request failed')
  return result.value as T
}
createRoot(document.getElementById('root')!).render(<HLPersonalPanel call={call} openSession={id => {
  document.getElementById('opened')!.textContent = id
}}/>)
