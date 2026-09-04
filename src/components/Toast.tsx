import { useStore } from '../lib/store'

export function Toast() {
  const toast = useStore((s) => s.toast)
  const hide = useStore((s) => s.hideToast)
  if (!toast) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex justify-center px-4">
      <div className="pointer-events-auto flex items-center gap-2 rounded-2xl bg-ink text-white pl-4 pr-1.5 py-2 text-sm shadow-xl max-w-full">
        <span className="truncate">{toast.msg}</span>
        {toast.undo ? (
          <button
            type="button"
            className="shrink-0 rounded-xl bg-white/15 px-3 py-1.5 font-semibold text-yellow-300 active:bg-white/25"
            onClick={() => {
              const fn = toast.undo
              hide() // 先收起，让撤销结果的提示能顺利顶上来
              fn?.()
            }}
          >
            撤销
          </button>
        ) : (
          <span className="w-1.5" />
        )}
      </div>
    </div>
  )
}
