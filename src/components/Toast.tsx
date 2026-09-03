import { useStore } from '../lib/store'

export function Toast() {
  const toast = useStore((s) => s.toast)
  const hide = useStore((s) => s.hideToast)
  if (!toast) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex justify-center px-4">
      <div className="pointer-events-auto flex items-center gap-3 rounded-full bg-ink text-white px-4 py-2.5 text-sm shadow-lg max-w-full">
        <span className="truncate">{toast.msg}</span>
        {toast.undo ? (
          <button
            type="button"
            className="shrink-0 font-semibold text-yellow-300"
            onClick={() => {
              toast.undo?.()
              hide()
            }}
          >
            撤销
          </button>
        ) : null}
      </div>
    </div>
  )
}
