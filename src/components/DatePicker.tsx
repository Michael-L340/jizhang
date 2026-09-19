import { useEffect, useState } from 'react'
import { Sheet } from './Sheet'
import { addDays, clampYm, daysInMonth, fmtMonthZh, monthOf, shiftMonth, today, yearGridStart, YEAR_GRID } from '../lib/date'

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

type Level = 'day' | 'month' | 'year'

/**
 * 自绘日历。系统日期控件在 iOS 上不遵守 max，会让人选到未来。
 *
 * 三层：日 → 月 → 年，**点标题往上一级**（用户 2026-09-19：「像很多日历选择一样」）。
 * 补 2023 年的账要翻 40 多下箭头，有了月和年两层是四下。
 * 每次打开都从日那层开始，停在当前选中日期所在的月；关掉不记层级。
 */
export function DatePicker({ open, value, onPick, onClose, max }: Props) {
  const limit = max ?? today()
  const limitYm = monthOf(limit)
  const limitYear = Number(limitYm.slice(0, 4))
  const [ym, setYm] = useState(monthOf(value))
  const [level, setLevel] = useState<Level>('day')
  const [year, setYear] = useState(Number(monthOf(value).slice(0, 4)))
  const [yBase, setYBase] = useState(yearGridStart(Number(monthOf(value).slice(0, 4))))

  useEffect(() => {
    if (open) {
      setYm(monthOf(value))
      setLevel('day')
    }
  }, [open, value])

  const days = daysInMonth(ym)
  const blanks = leadingBlanks(ym)
  const todayStr = today()

  // 三层各自的「标题 / 能不能往后翻 / 往前往后」
  const title = level === 'day' ? fmtMonthZh(ym) : level === 'month' ? `${year}年` : `${yBase} – ${yBase + YEAR_GRID - 1}`
  const canNext = level === 'day' ? ym < limitYm : level === 'month' ? year < limitYear : yBase + YEAR_GRID - 1 < limitYear
  const go = (n: number) => {
    if (level === 'day') setYm(shiftMonth(ym, n))
    else if (level === 'month') setYear(year + n)
    else setYBase(yBase + n * YEAR_GRID)
  }
  const up = () => {
    if (level === 'day') {
      setYear(Number(ym.slice(0, 4)))
      setLevel('month')
    } else if (level === 'month') {
      setYBase(yearGridStart(year))
      setLevel('year')
    }
  }

  return (
    <Sheet open={open} onClose={onClose}>
      <div className="flex items-center justify-center gap-6 mb-3">
        <Arrow dir="left" onClick={() => go(-1)} />
        <button
          type="button"
          className={`num text-base font-bold min-w-[120px] text-center px-2 py-1 rounded-lg active:bg-bg ${level === 'year' ? '' : 'flex items-center justify-center gap-1'}`}
          onClick={up}
          disabled={level === 'year'}
          aria-label={level === 'day' ? '选月份' : level === 'month' ? '选年份' : undefined}
        >
          {title}
          {/* 小箭头只是提示「能点」，年那层已经到顶，不显示 */}
          {level !== 'year' ? <span className="text-[10px] text-brand-ink font-semibold">⌃</span> : null}
        </button>
        <Arrow dir="right" disabled={!canNext} onClick={() => canNext && go(1)} />
      </div>

      {level === 'day' ? (
        <>
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
        </>
      ) : level === 'month' ? (
        <div className="grid grid-cols-3 gap-2">
          {Array.from({ length: 12 }, (_, i) => {
            const m = `${year}-${String(i + 1).padStart(2, '0')}`
            const disabled = m > limitYm
            const on = m === monthOf(value)
            const isNow = m === limitYm
            return (
              <button
                key={m}
                type="button"
                disabled={disabled}
                className={`h-[52px] rounded-2xl text-[15px] ${on ? 'bg-brand text-on-brand font-semibold' : disabled ? 'text-line' : isNow ? 'bg-bg text-brand-ink font-semibold' : 'bg-bg text-ink'}`}
                onClick={() => {
                  // 点某月回到日那层；那月要是全在未来（不会发生，按钮已禁用），也兜一下
                  setYm(clampYm(m, limitYm))
                  setLevel('day')
                }}
              >
                {i + 1} 月
              </button>
            )
          })}
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {Array.from({ length: YEAR_GRID }, (_, i) => {
            const y = yBase + i
            const disabled = y > limitYear
            const on = y === Number(monthOf(value).slice(0, 4))
            const isNow = y === limitYear
            return (
              <button
                key={y}
                type="button"
                disabled={disabled}
                className={`num h-[52px] rounded-2xl text-[15px] ${on ? 'bg-brand text-on-brand font-semibold' : disabled ? 'text-line' : isNow ? 'bg-bg text-brand-ink font-semibold' : 'bg-bg text-ink'}`}
                onClick={() => {
                  setYear(y)
                  setLevel('month')
                }}
              >
                {y}
              </button>
            )
          })}
        </div>
      )}

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
      aria-label={dir === 'left' ? '往前' : '往后'}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d={dir === 'left' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} />
      </svg>
    </button>
  )
}
