import { useState } from 'react'
import { Sheet } from './Sheet'
import { fmtMonthZh, monthOf, today } from '../lib/date'
import { fmtYuan } from '../lib/money'

interface Props {
  value: string // YYYY-MM
  onChange: (ym: string) => void
  /** 每月收支合计（分），用于在格子里显示金额 */
  totals?: Map<string, { expense: number; income: number }>
}

function shortAmount(cents: number): string {
  if (cents === 0) return ''
  const yuan = cents / 100
  if (yuan >= 10000) return `${(yuan / 10000).toFixed(1)}万`
  if (yuan >= 1000) return `${Math.round(yuan)}`
  return fmtYuan(cents).replace(/\.00$/, '')
}

/** 顶部月份切换：左右箭头 + 点标题展开年月选择（格子里带当月支出） */
export function MonthPicker({ value, onChange, totals }: Props) {
  const [open, setOpen] = useState(false)
  const [year, setYear] = useState(Number(value.slice(0, 4)))
  const nowYm = monthOf(today())
  const curYear = Number(nowYm.slice(0, 4))
  const minYear = curYear - 20

  function shift(n: number) {
    const [y, m] = value.split('-').map(Number)
    const t = y * 12 + (m - 1) + n
    onChange(`${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`)
  }

  const yearTotal = Array.from({ length: 12 }).reduce<number>((s, _, i) => s + (totals?.get(`${year}-${String(i + 1).padStart(2, '0')}`)?.expense ?? 0), 0)

  return (
    <>
      <div className="flex items-center justify-between py-2">
        <button type="button" className="w-11 h-11 flex items-center justify-center text-muted active:text-ink" onClick={() => shift(-1)} aria-label="上个月">
          <Chevron dir="left" />
        </button>
        <button
          type="button"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full active:bg-card"
          onClick={() => {
            setYear(Number(value.slice(0, 4)))
            setOpen(true)
          }}
        >
          <span className="text-[17px] font-bold">{fmtMonthZh(value)}</span>
          <Chevron dir="down" className="text-muted" />
        </button>
        <button
          type="button"
          className={`w-11 h-11 flex items-center justify-center ${value >= nowYm ? 'text-line' : 'text-muted active:text-ink'}`}
          disabled={value >= nowYm}
          onClick={() => shift(1)}
          aria-label="下个月"
        >
          <Chevron dir="right" />
        </button>
      </div>

      <Sheet open={open} onClose={() => setOpen(false)}>
        <div className="flex items-center justify-center gap-6 mb-1">
          <button
            type="button"
            className={`w-9 h-9 flex items-center justify-center rounded-full ${year <= minYear ? 'text-line' : 'text-muted active:bg-bg'}`}
            disabled={year <= minYear}
            onClick={() => setYear(year - 1)}
            aria-label="上一年"
          >
            <Chevron dir="left" />
          </button>
          <span className="num text-lg font-bold w-[76px] text-center">{year}</span>
          <button
            type="button"
            className={`w-9 h-9 flex items-center justify-center rounded-full ${year >= curYear ? 'text-line' : 'text-muted active:bg-bg'}`}
            disabled={year >= curYear}
            onClick={() => setYear(year + 1)}
            aria-label="下一年"
          >
            <Chevron dir="right" />
          </button>
        </div>
        <div className="text-center text-xs text-muted mb-3 h-4">{yearTotal > 0 ? `全年支出 ${fmtYuan(yearTotal, { symbol: true })}` : ''}</div>

        <div className="grid grid-cols-3 gap-2">
          {Array.from({ length: 12 }, (_, i) => {
            const ym = `${year}-${String(i + 1).padStart(2, '0')}`
            const future = ym > nowYm
            const on = ym === value
            const amt = totals?.get(ym)?.expense ?? 0
            return (
              <button
                key={ym}
                type="button"
                disabled={future}
                className={`flex flex-col items-center justify-center gap-0.5 h-[58px] rounded-2xl transition-colors ${
                  on ? 'bg-brand text-on-brand' : future ? 'text-line' : amt > 0 ? 'bg-brand-soft text-ink' : 'bg-bg text-ink'
                }`}
                onClick={() => {
                  onChange(ym)
                  setOpen(false)
                }}
              >
                <span className={`text-[15px] ${on || amt > 0 ? 'font-semibold' : ''}`}>{i + 1} 月</span>
                <span className={`num text-[11px] leading-none ${on ? 'text-on-brand/70' : 'text-muted'}`}>{amt > 0 ? shortAmount(amt) : future ? '' : '·'}</span>
              </button>
            )
          })}
        </div>

        <div className="flex gap-2 mt-4">
          <button type="button" className="flex-1 py-2.5 rounded-xl bg-bg text-sm" onClick={() => setOpen(false)}>
            取消
          </button>
          <button
            type="button"
            className="flex-1 py-2.5 rounded-xl bg-ink text-white text-sm"
            onClick={() => {
              onChange(nowYm)
              setOpen(false)
            }}
          >
            回到本月
          </button>
        </div>
      </Sheet>
    </>
  )
}

function Chevron({ dir, className = '' }: { dir: 'left' | 'right' | 'down'; className?: string }) {
  const d = dir === 'left' ? 'M15 5l-7 7 7 7' : dir === 'right' ? 'M9 5l7 7-7 7' : 'M6 9l6 6 6-6'
  return (
    <svg width={dir === 'down' ? 14 : 18} height={dir === 'down' ? 14 : 18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d={d} />
    </svg>
  )
}
