import { useState } from 'react'
import { Sheet } from './Sheet'
import { fmtMonthZh, monthOf, today } from '../lib/date'

interface Props {
  value: string // YYYY-MM
  onChange: (ym: string) => void
  /** 有数据的月份，会加一个圆点标记 */
  monthsWithData?: Set<string>
}

/** 顶部月份切换条：左右箭头 + 点标题打开年月选择 */
export function MonthPicker({ value, onChange, monthsWithData }: Props) {
  const [open, setOpen] = useState(false)
  const [year, setYear] = useState(Number(value.slice(0, 4)))
  const nowYm = monthOf(today())
  const curYear = Number(nowYm.slice(0, 4))

  function shift(n: number) {
    const [y, m] = value.split('-').map(Number)
    const t = y * 12 + (m - 1) + n
    onChange(`${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`)
  }

  return (
    <>
      <div className="flex items-center justify-between pt-3 pb-2">
        <button type="button" className="w-11 h-11 text-xl text-muted" onClick={() => shift(-1)} aria-label="上个月">
          ‹
        </button>
        <button
          type="button"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full active:bg-card"
          onClick={() => {
            setYear(Number(value.slice(0, 4)))
            setOpen(true)
          }}
        >
          <span className="text-lg font-bold">{fmtMonthZh(value)}</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="text-muted">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        <button
          type="button"
          className={`w-11 h-11 text-xl ${value >= nowYm ? 'text-line' : 'text-muted'}`}
          disabled={value >= nowYm}
          onClick={() => shift(1)}
          aria-label="下个月"
        >
          ›
        </button>
      </div>

      <Sheet open={open} onClose={() => setOpen(false)} title="选择月份">
        <div className="flex items-center justify-between mb-3">
          <button type="button" className="w-10 h-10 text-lg text-muted" onClick={() => setYear(year - 1)}>
            ‹
          </button>
          <span className="text-base font-semibold">{year} 年</span>
          <button type="button" className={`w-10 h-10 text-lg ${year >= curYear ? 'text-line' : 'text-muted'}`} disabled={year >= curYear} onClick={() => setYear(year + 1)}>
            ›
          </button>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {Array.from({ length: 12 }, (_, i) => {
            const ym = `${year}-${String(i + 1).padStart(2, '0')}`
            const future = ym > nowYm
            const on = ym === value
            const hasData = monthsWithData?.has(ym)
            return (
              <button
                key={ym}
                type="button"
                disabled={future}
                className={`relative py-2.5 rounded-xl text-sm ${on ? 'bg-brand text-white' : future ? 'text-line' : 'bg-bg'}`}
                onClick={() => {
                  onChange(ym)
                  setOpen(false)
                }}
              >
                {i + 1} 月
                {hasData && !on ? <span className="absolute left-1/2 -translate-x-1/2 bottom-1 w-1 h-1 rounded-full bg-brand" /> : null}
              </button>
            )
          })}
        </div>
        <button
          type="button"
          className="w-full mt-3 py-2.5 rounded-xl bg-bg text-sm"
          onClick={() => {
            onChange(nowYm)
            setOpen(false)
          }}
        >
          回到本月
        </button>
      </Sheet>
    </>
  )
}
