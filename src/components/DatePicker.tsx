import { useEffect, useState } from 'react'
import { Sheet } from './Sheet'
import { addDays, daysInMonth, fmtMonthZh, monthOf, shiftMonth, today } from '../lib/date'

interface Props {
  open: boolean
  value: string // YYYY-MM-DD
  onPick: (ymd: string) => void
  onClose: () => void
  /** 允许的最晚日期，默认今天 */
  max?: string
}

const WEEK = ['一', '二', '三', '四', '五', '六', '日']

/** 周一为第一列时，某月 1 号前面要空几格 */
function leadingBlanks(ym: string): number {
  const [y, m] = ym.split('-').map(Number)
  const dow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay() // 0=周日
  return (dow + 6) % 7
}

/** 自绘日历。系统日期控件在 iOS 上不遵守 max，会让人选到未来。 */
export function DatePicker({ open, value, onPick, onClose, max }: Props) {
  const limit = max ?? today()
  const [ym, setYm] = useState(monthOf(value))

  useEffect(() => {
    if (open) setYm(monthOf(value))
  }, [open, value])

  const days = daysInMonth(ym)
  const blanks = leadingBlanks(ym)
  const canNext = ym < monthOf(limit)
  const todayStr = today()

  return (
    <Sheet open={open} onClose={onClose}>
      <div className="flex items-center justify-center gap-6 mb-3">
        <Arrow dir="left" onClick={() => setYm(shiftMonth(ym, -1))} />
        <span className="text-base font-bold w-[110px] text-center">{fmtMonthZh(ym)}</span>
        <Arrow dir="right" disabled={!canNext} onClick={() => canNext && setYm(shiftMonth(ym, 1))} />
      </div>

      <div className="grid grid-cols-7 mb-1">
        {WEEK.map((w) => (
          <div key={w} className="text-center text-[11px] text-muted py-1">
            {w}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-y-1">
        {Array.from({ length: blanks }, (_, i) => (
          <span key={`b${i}`} />
        ))}
        {Array.from({ length: days }, (_, i) => {
          const d = `${ym}-${String(i + 1).padStart(2, '0')}`
          const disabled = d > limit
          const on = d === value
          const isToday = d === todayStr
          return (
            <button
              key={d}
              type="button"
              disabled={disabled}
              onClick={() => {
                onPick(d)
                onClose()
              }}
              className="flex items-center justify-center py-1"
            >
              <span
                className={`num w-9 h-9 flex items-center justify-center rounded-full text-[15px] ${
                  on ? 'bg-brand text-on-brand font-semibold' : disabled ? 'text-line' : isToday ? 'text-brand-ink font-semibold' : 'text-ink'
                }`}
              >
                {i + 1}
              </span>
            </button>
          )
        })}
      </div>

      <div className="flex gap-2 mt-4">
        <button
          type="button"
          className={`flex-1 py-2.5 rounded-xl text-sm ${value === todayStr ? 'bg-brand text-on-brand' : 'bg-bg'}`}
          onClick={() => {
            onPick(todayStr)
            onClose()
          }}
        >
          今天
        </button>
        <button
          type="button"
          className={`flex-1 py-2.5 rounded-xl text-sm ${value === addDays(todayStr, -1) ? 'bg-brand text-on-brand' : 'bg-bg'}`}
          onClick={() => {
            onPick(addDays(todayStr, -1))
            onClose()
          }}
        >
          昨天
        </button>
        <button type="button" className="flex-1 py-2.5 rounded-xl bg-ink text-white text-sm" onClick={onClose}>
          关闭
        </button>
      </div>
    </Sheet>
  )
}

function Arrow({ dir, disabled, onClick }: { dir: 'left' | 'right'; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`w-9 h-9 flex items-center justify-center rounded-full ${disabled ? 'text-line' : 'text-muted active:bg-bg'}`}
      aria-label={dir === 'left' ? '上个月' : '下个月'}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d={dir === 'left' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} />
      </svg>
    </button>
  )
}
