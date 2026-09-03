import type { ReactNode } from 'react'

interface Props {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
}

/** 底部弹层 */
export function Sheet({ open, onClose, title, children }: Props) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30" />
      <div className="relative w-full max-w-[430px] bg-card rounded-t-2xl safe-bottom max-h-[85dvh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-line" />
        {title ? <div className="px-4 pt-3 pb-1 text-base font-semibold">{title}</div> : null}
        <div className="p-4">{children}</div>
      </div>
    </div>
  )
}
