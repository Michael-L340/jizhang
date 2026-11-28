import { useCallback, useState } from 'react'
import { AssistantSheet } from './AssistantSheet'

/**
 * 「助手」小胶囊 + 它的弹层。每一页标题附近放一个（用户 2026-11-28：「看看每一页都有」）。
 * 对话本身在 lib/assistant/session.ts 里（模块级），所以在哪一页点开都是同一段，换页接着聊。
 * iconOnly：标题右边已经有别的按钮、放不下两个字的地方（用电页「记一次」旁边）。
 */
export function AssistantButton({ iconOnly = false }: { iconOnly?: boolean }) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  return (
    <>
      <button type="button" aria-label="助手" className="chip flex items-center gap-1" style={iconOnly ? { padding: '6px 9px' } : { padding: '5px 10px', fontSize: 13 }} onClick={() => setOpen(true)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-brand-ink">
          <path d="M4 5h16v11H9l-5 4z" />
          <path d="M8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01" />
        </svg>
        {iconOnly ? null : '助手'}
      </button>
      <AssistantSheet open={open} onClose={close} />
    </>
  )
}

/** 第一行右边已经有东西的页：助手单独一行、靠右 */
export function AssistantRow({ className = '' }: { className?: string }) {
  return (
    <div className={`flex justify-end ${className}`}>
      <AssistantButton />
    </div>
  )
}
