interface Props {
  onInput: (key: string) => void
  onSave: () => void
  saveLabel?: string
  disabled?: boolean
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '00']

/** 自绘数字键盘：不用系统键盘，避免 iOS 布局被顶起；保存键在右下拇指区 */
export function Keypad({ onInput, onSave, saveLabel = '保存', disabled }: Props) {
  return (
    <div className="grid grid-cols-4 gap-2 p-2 safe-bottom bg-bg">
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
          className="row-span-3 rounded-xl bg-brand text-white text-lg font-semibold disabled:opacity-40"
          disabled={disabled}
          onClick={onSave}
        >
          {saveLabel}
        </button>
      </div>
    </div>
  )
}
