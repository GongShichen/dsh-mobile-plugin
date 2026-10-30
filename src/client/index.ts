import { createElement } from 'react'
import { MobileAccessPage, MobileAccessLauncher } from './MobileAccess.js'
import { createOwnerCall } from './contract.js'

// Structural host types keep this third-party package independent of upstream build artifacts.
interface ClientContext {
  connection: { rpc: Parameters<typeof createOwnerCall>[0] }
  slots: {
    inject(name: string, callback: () => unknown): unknown
    register(options: { name: string; id: string; order?: number; label?: string }, component: (props: { wide?: boolean }) => unknown): unknown
  }
}
export const inject = ['slots', 'connection']

/** Official Slot API; the same client factory runs inside Desktop and Web. */
export function apply(ctx: ClientContext): void {
  const call = createOwnerCall(ctx.connection.rpc)
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'dsh-mobile-access', order: 20,
  }, props => createElement(MobileAccessLauncher, { call, wide: props.wide })))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'dsh-mobile-access', label: '移动访问', order: 80,
  }, () => createElement(MobileAccessPage, { call })))
}
