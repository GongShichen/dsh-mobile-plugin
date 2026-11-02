import { useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HLOwnerCall } from '../../client/HLContract.js'
import { HLPersonalPanel } from './HLPersonalPanel.js'
import { hlPersonalStyles } from './HLPersonalStyles.js'

/** Public slots launch the same panel in Desktop and Web. */
export function HLPersonalLauncher({ call, wide, openSession }: { call: HLOwnerCall; wide?: boolean; openSession: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  return <><style>{hlPersonalStyles}</style><button type="button" className="hl-p-launcher" title="私人助理" aria-label="私人助理" aria-haspopup="dialog" onClick={() => setOpen(true)}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" aria-hidden="true"><path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z" strokeLinejoin="round"/></svg>{wide && <span>私人助理</span>}</button>
    <Modal open={open} onClose={() => setOpen(false)} title="私人助理" closeLabel="关闭私人助理" className="hl-p-modal" contentClassName="hl-p-modal-body">{open && <HLPersonalPanel call={call} openSession={id => { setOpen(false); requestAnimationFrame(() => openSession(id)) }}/>}</Modal></>
}
