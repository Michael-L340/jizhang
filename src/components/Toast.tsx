import { useLocation } from 'react-router-dom'
import { useStore } from '../lib/store'

// 记账页底部是自绘数字键盘，高度 = 8(上内边距) + 4×56(键) + 3×8(间隙) + 8 + 安全区 = 264px + 安全区。
// 提示条停在默认的 bottom-24（96px）时，整条正好压在键盘上，右端的「撤销」按钮落在
// 右下角那个「保存」键里面：想接着记第二笔，按保存实际按到撤销，第一笔被删、第二笔没存。
// 所以记账页要把提示条抬到键盘上方；两个类名必须写成完整字面量，Tailwind 只扫字面量。
const BOTTOM_ON_KEYPAD = 'bottom-[calc(env(safe-area-inset-bottom)+276px)]'
const BOTTOM_DEFAULT = 'bottom-24'

export function Toast() {
  const toast = useStore((s) => s.toast)
  const hide = useStore((s) => s.hideToast)
  const onKeypad = useLocation().pathname === '/add'
  if (!toast) return null
  return (
    <div className={`pointer-events-none fixed inset-x-0 z-[60] flex justify-center px-4 ${onKeypad ? BOTTOM_ON_KEYPAD : BOTTOM_DEFAULT}`}>
      {/* pointer-events-auto 只给「撤销」按钮，不给整条药丸：
          药丸本身没有点击行为，却会把它盖住的按钮全部吃掉 */}
      <div className="flex items-center gap-2 rounded-2xl bg-ink text-white pl-4 pr-1.5 py-2 text-sm shadow-xl max-w-full">
        <span className="truncate">{toast.msg}</span>
        {toast.undo ? (
          <button
            type="button"
            className="pointer-events-auto shrink-0 rounded-xl bg-white/15 px-3 py-1.5 font-semibold text-yellow-300 active:bg-white/25"
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
