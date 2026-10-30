/** Type-only excerpt of the pinned official Modal API (ui-primitives/src/Modal.tsx).
 * Runtime comes exclusively from DSH's shared module table, never a bundled copy.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ComponentType, ReactNode } from 'react'
  export const Modal: ComponentType<{
    open: boolean; onClose: () => void; title: string; closeLabel: string
    description?: string; children?: ReactNode; footer?: ReactNode
    className?: string; contentClassName?: string
  }>
}
