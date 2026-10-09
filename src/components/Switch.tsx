// 开 / 关 用的滑块。全 App 的开关只有三种样子（2026-10-09 定）：二选一用胶囊分段，开关用这个，带设置的功能收进圆按钮。
interface Props {
  on: boolean
  onChange: (on: boolean) => void
  label?: string
  disabled?: boolean
}

export function Switch({ on, onChange, label, disabled }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`w-11 h-6 rounded-full shrink-0 flex items-center px-0.5 transition-colors ${on ? 'bg-brand-ink justify-end' : 'bg-line justify-start'} ${disabled ? 'opacity-50' : ''}`}
    >
      <span className="w-5 h-5 rounded-full bg-card shadow-sm" />
    </button>
  )
}
