import { useState } from 'react'
import { Sheet } from './Sheet'
import { fmtMonthZh, monthOf, today, yearGridStart, YEAR_GRID } from '../lib/date'
import { ALL_MONTHS } from '../lib/ledger'
import { fmtYuan } from '../lib/money'

interface Props {
  /** YYYY-MM；开了 allowAll 时还可以是 ALL_MONTHS（全部月份） */
  value: string
  onChange: (ym: string) => void
  /** 流水页用：标题可以是「全部流水」，弹层底下多一个「全部月份」 */
  allowAll?: boolean
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
export function MonthPicker({ value, onChange, totals, allowAll }: Props) {
  const nowYm = monthOf(today())
  const all = value === ALL_MONTHS
  // 看全部的时候，弹层打开先落在本月那一年
  const base = all ? nowYm : value
  const [open, setOpen] = useState(false)
  const [year, setYear] = useState(Number(base.slice(0, 4)))
  // 弹层里两层：月（默认）→ 点年份标题上到年。用户 2026-09-19 要的「再往上一级翻年」
  const [level, setLevel] = useState<'month' | 'year'>('month')
  const [yBase, setYBase] = useState(yearGridStart(Number(base.slice(0, 4))))
  const curYear = Number(nowYm.slice(0, 4))
  const minYear = curYear - 20

  function shift(n: number) {
    const [y, m] = value.split('-').map(Number)
    const t = y * 12 + (m - 1) + n
    onChange(`${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`)
  }

  const totalOfYear = (y: number) => Array.from({ length: 12 }).reduce<number>((s, _, i) => s + (totals?.get(`${y}-${String(i + 1).padStart(2, '0')}`)?.expense ?? 0), 0)
  const yearTotal = totalOfYear(year)
  const inYear = level === 'month'

  return (
    <>
      <div className="flex items-center justify-between py-2">
        {/* 看全部时没有「上个月 / 下个月」，箭头的位置留着，标题不左右跳 */}
        <button type="button" className={`w-11 h-11 flex items-center justify-center text-muted active:text-ink ${all ? 'invisible' : ''}`} disabled={all} onClick={() => shift(-1)} aria-label="上个月">
          <Chevron dir="left" />
        </button>
        <button
          type="button"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full active:bg-card"
          onClick={() => {
            setYear(Number(base.slice(0, 4)))
            setLevel('month')
            setOpen(true)
          }}
        >
          <span className="text-[17px] font-bold">{all ? '全部流水' : fmtMonthZh(value)}</span>
          <Chevron dir="down" className="text-muted" />
        </button>
        <button
          type="button"
          className={`w-11 h-11 flex items-center justify-center ${all ? 'invisible' : value >= nowYm ? 'text-line' : 'text-muted active:text-ink'}`}
          disabled={all || value >= nowYm}
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
            className={`w-9 h-9 flex items-center justify-center rounded-full ${(inYear ? year <= minYear : yBase <= minYear) ? 'text-line' : 'text-muted active:bg-bg'}`}
            disabled={inYear ? year <= minYear : yBase <= minYear}
            onClick={() => (inYear ? setYear(year - 1) : setYBase(yBase - YEAR_GRID))}
            aria-label={inYear ? '上一年' : '往前 12 年'}
          >
            <Chevron dir="left" />
          </button>
          {inYear ? (
            // 年份能点：上到年的格子。小箭头只是提示能点
            <button
              type="button"
              className="num text-lg font-bold min-w-[76px] text-center px-2 rounded-lg active:bg-bg flex items-center justify-center gap-1"
              onClick={() => {
                setYBase(yearGridStart(year))
                setLevel('year')
              }}
              aria-label="选年份"
            >
              {year}
              <span className="text-[10px] text-brand-ink font-semibold">⌃</span>
            </button>
          ) : (
            <span className="num text-lg font-bold min-w-[120px] text-center">{`${yBase} – ${yBase + YEAR_GRID - 1}`}</span>
          )}
          <button
            type="button"
            className={`w-9 h-9 flex items-center justify-center rounded-full ${(inYear ? year >= curYear : yBase + YEAR_GRID - 1 >= curYear) ? 'text-line' : 'text-muted active:bg-bg'}`}
            disabled={inYear ? year >= curYear : yBase + YEAR_GRID - 1 >= curYear}
            onClick={() => (inYear ? setYear(year + 1) : setYBase(yBase + YEAR_GRID))}
            aria-label={inYear ? '下一年' : '往后 12 年'}
          >
            <Chevron dir="right" />
          </button>
        </div>
        <div className="text-center text-xs text-muted mb-3 h-4">{inYear ? (yearTotal > 0 ? `全年支出 ${fmtYuan(yearTotal, { symbol: true })}` : '') : '点某一年，回到那一年的月份'}</div>

        {!inYear ? (
          <div className="grid grid-cols-3 gap-2">
            {Array.from({ length: YEAR_GRID }, (_, i) => {
              const y = yBase + i
              const future = y > curYear
              const on = y === Number(value.slice(0, 4))
              const amt = totalOfYear(y)
              return (
                <button
                  key={y}
                  type="button"
                  disabled={future}
                  className={`flex flex-col items-center justify-center gap-0.5 h-[58px] rounded-2xl transition-colors ${
                    on ? 'bg-brand text-on-brand' : future ? 'text-line' : amt > 0 ? 'bg-brand-soft text-ink' : 'bg-bg text-ink'
                  }`}
                  onClick={() => {
                    setYear(y)
                    setLevel('month')
                  }}
                >
                  <span className={`num text-[15px] ${on || amt > 0 ? 'font-semibold' : ''}`}>{y}</span>
                  <span className={`num text-[11px] leading-none ${on ? 'text-on-brand/70' : 'text-muted'}`}>{amt > 0 ? shortAmount(amt) : future ? '' : '·'}</span>
                </button>
              )
            })}
          </div>
        ) : (
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
        )}

        {allowAll ? (
          // 流水页：平时看全部，选一个月只是临时看看，所以「全部月份」是主按钮
          <div className="flex gap-2 mt-4">
            <button
              type="button"
              className="flex-1 py-2.5 rounded-xl bg-bg text-sm"
              onClick={() => {
                onChange(nowYm)
                setOpen(false)
              }}
            >
              只看本月
            </button>
            <button
              type="button"
              className={`flex-1 py-2.5 rounded-xl text-sm ${all ? 'bg-brand text-on-brand' : 'bg-ink text-white'}`}
              onClick={() => {
                onChange(ALL_MONTHS)
                setOpen(false)
              }}
            >
              全部月份
            </button>
          </div>
        ) : (
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
        )}
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
