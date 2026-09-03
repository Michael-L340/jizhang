import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
}

/**
 * 底部弹层。必须挂到 document.body：
 * iOS 上带 -webkit-overflow-scrolling 的滚动容器会把内部 position:fixed 限制在自己范围内，
 * 弹层会被底部导航条截断。
 */
export function Sheet({ open, onClose, title, children }: Props) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/35" />
      <div
        className="relative w-full max-w-[430px] bg-card rounded-t-2xl max-h-[86dvh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 pt-2 pb-1">
          <div className="mx-auto h-1 w-10 rounded-full bg-line" />
          {title ? <div className="px-4 pt-2 text-base font-semibold">{title}</div> : null}
        </div>
        <div className="overflow-y-auto overscroll-contain px-4 pb-4 safe-bottom">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
