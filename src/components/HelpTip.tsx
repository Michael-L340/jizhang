// 卡片右上角的小「?」。卡片里不放说明文字（2026-10-09 定的），要解释就收进这里，点了才出来。
import { useState, type ReactNode } from 'react'
import { Sheet } from './Sheet'

interface Props {
  title: string
  children: ReactNode
}

export function HelpTip({ title, children }: Props) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        aria-label="说明"
        onClick={() => setOpen(true)}
        className="w-5 h-5 rounded-full border border-line text-[11px] text-muted leading-none inline-flex items-center justify-center shrink-0"
      >
        ?
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title={title}>
        <div className="text-sm text-ink leading-relaxed pt-1 pb-2 space-y-2">{children}</div>
      </Sheet>
    </>
  )
}
