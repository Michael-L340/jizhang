interface Props {
  onInput: (key: string) => void
  onSave: () => void
  saveLabel?: string
  disabled?: boolean
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '00']

/**
 * 自绘数字键盘：不用系统键盘，避免 iOS 布局被顶起；保存键在右下拇指区。
 *
 * 底部内边距不能用 .safe-bottom：那是一条无 layer 的普通规则，会把 p-2 的
 * padding-bottom 整个覆盖成 0，在没有安全区的设备（电脑、老 iPhone）上键盘紧贴屏幕底边。
 *
 * 整体高度 = 8(上) + 4×56(键) + 3×8(间隙) + 8(下) + 安全区 = 264px + 安全区。
 * Toast 的抬升距离按这个数算，改键高或间隙时记得同步 components/Toast.tsx。
 */
export function Keypad({ onInput, onSave, saveLabel = '保存', disabled }: Props) {
  return (
    <div className="grid grid-cols-4 gap-2 p-2 pb-[calc(env(safe-area-inset-bottom)+8px)] bg-bg">
      <div className="col-span-3 grid grid-cols-3 gap-2">
        {KEYS.map((k) => (
          <button key={k} type="button" className="key num" onClick={() => onInput(k)}>
            {k}
          </button>
        ))}
      </div>
      <div className="grid grid-rows-4 gap-2">
        <button type="button" className="key" aria-label="退格" onClick={() => onInput('⌫')}>
          <svg className="mx-auto" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 6H9l-6 6 6 6h12a1 1 0 001-1V7a1 1 0 00-1-1zM14 9l-4 6M10 9l4 6" />
          </svg>
        </button>
        <button
          type="button"
          className="row-span-3 rounded-xl bg-brand text-on-brand text-lg font-semibold disabled:opacity-40"
          disabled={disabled}
          onClick={onSave}
        >
          {saveLabel}
        </button>
      </div>
    </div>
  )
}
