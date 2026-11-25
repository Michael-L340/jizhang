import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fmtDateZh, monthOf, shiftMonth } from '../lib/date'
import { usePersistedState } from '../lib/hooks'
import { calYears, dayCells, daysInMonth, drillOf, monthCells, weekLead, yearCells, type CalCell, type CalLevel } from '../lib/homeCal'
import { fmtShortYuan, fmtYuan } from '../lib/money'
import type { Transaction } from '../types'

const LEVELS: readonly (readonly [CalLevel, string])[] = [
  ['day', '日'],
  ['month', '月'],
  ['year', '年'],
]
const WEEK = ['一', '二', '三', '四', '五', '六', '日']

/**
 * 首页最下面的「日历」卡（2026-11-25，代替「最近流水」，用户看效果图定的）。
 * 日 / 月 / 年三档；格子里收入（+，绿）在上、支出（-，红）在下，两行一起上下居中，只有一行时也居中；不画底色深浅。
 * 点一格：底下一行写这一格的收支和笔数；同一格再点一下往下钻：年 → 那年的各月 → 那月的每天 → 流水页那一天
 * （和统计页图表「点一下看、再点一下跳」同一个规矩）。txs 必须是当前模式那本账（首页的 otxs）。
 */
export function CalendarCard({ txs, todayYmd }: { txs: readonly Transaction[]; todayYmd: string }) {
  const nav = useNavigate()
  const [levelRaw, setLevel] = usePersistedState<CalLevel>('jz_home_calLevel', 'day')
  const level: CalLevel = levelRaw === 'month' || levelRaw === 'year' ? levelRaw : 'day'
  const nowYm = monthOf(todayYmd)
  const nowYear = todayYmd.slice(0, 4)
  // 日档看哪个月、月档看哪一年（往下钻或者点箭头会变；冷启动永远是本月 / 今年）
  const [ym, setYm] = useState(nowYm)
  const [year, setYear] = useState(nowYear)
  const [sel, setSel] = useState<string | null>(null)

  const cells = useMemo(() => (level === 'day' ? dayCells(txs, ym) : level === 'month' ? monthCells(txs, year) : yearCells(txs)), [txs, level, ym, year])
  const years = useMemo(() => calYears(txs, todayYmd), [txs, todayYmd])

  const pickLevel = (l: CalLevel) => {
    setLevel(l)
    setSel(null)
  }
  const go = (key: string) => {
    const d = drillOf(level, key)
    if ('ledger' in d) return nav(d.ledger)
    if (d.level === 'month') setYear(d.anchor)
    else setYm(d.anchor)
    setLevel(d.level)
    setSel(null)
  }
  const tap = (key: string) => (sel === key ? go(key) : setSel(key))

  const title = level === 'day' ? `${Number(ym.slice(0, 4))}年${Number(ym.slice(5, 7))}月` : level === 'month' ? `${year}年` : '全部年份'
  const canPrev = level === 'day' ? ym > `${years[0]}-01` : level === 'month' ? year > years[0] : false
  const canNext = level === 'day' ? ym < nowYm : level === 'month' ? year < nowYear : false
  const shift = (n: number) => {
    if (level === 'day') setYm(shiftMonth(ym, n))
    else setYear(String(Number(year) + n))
    setSel(null)
  }

  return (
    <div className="card p-4 mb-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted">日历</span>
        <div className="inline-flex rounded-full bg-bg p-0.5">
          {LEVELS.map(([l, t]) => (
            <button key={l} type="button" className={`px-3 py-1 rounded-full text-xs ${level === l ? 'bg-ink text-white' : 'text-muted'}`} onClick={() => pickLevel(l)}>
              {t}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between mt-1 mb-2">
        <button type="button" aria-label="往前" className={`w-8 h-8 -ml-2 flex items-center justify-center ${canPrev ? 'text-muted' : 'invisible'}`} disabled={!canPrev} onClick={() => shift(-1)}>
          <Chevron d="M15 6l-6 6 6 6" />
        </button>
        <span className="text-xs text-muted num">{title}</span>
        <button type="button" aria-label="往后" className={`w-8 h-8 -mr-2 flex items-center justify-center ${canNext ? 'text-muted' : 'invisible'}`} disabled={!canNext} onClick={() => shift(1)}>
          <Chevron d="M9 6l6 6-6 6" />
        </button>
      </div>

      {level === 'day' ? (
        <>
          <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-muted mb-1">
            {WEEK.map((w) => (
              <span key={w}>{w}</span>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: weekLead(ym) }, (_, i) => (
              <span key={`lead${i}`} />
            ))}
            {Array.from({ length: daysInMonth(ym) }, (_, i) => {
              const key = `${ym}-${String(i + 1).padStart(2, '0')}`
              return (
                <Cell key={key} label={String(i + 1)} cell={cells.get(key)} now={key === todayYmd} future={key > todayYmd} on={sel === key} className="aspect-[1/1.3] rounded-xl" onTap={() => tap(key)} />
              )
            })}
          </div>
        </>
      ) : level === 'month' ? (
        <div className="grid grid-cols-4 gap-1.5">
          {Array.from({ length: 12 }, (_, i) => {
            const key = `${year}-${String(i + 1).padStart(2, '0')}`
            return <Cell key={key} label={`${i + 1}月`} cell={cells.get(key)} now={key === nowYm} future={key > nowYm} on={sel === key} className="h-[66px] rounded-2xl" onTap={() => tap(key)} />
          })}
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-1.5">
          {years.map((y) => (
            <Cell key={y} label={y} cell={cells.get(y)} now={y === nowYear} future={false} on={sel === y} className="h-[70px] rounded-2xl" onTap={() => tap(y)} />
          ))}
        </div>
      )}

      {sel ? <Detail level={level} sel={sel} cell={cells.get(sel)} onGo={() => go(sel)} /> : null}
    </div>
  )
}

function Cell(props: { label: string; cell: CalCell | undefined; now: boolean; future: boolean; on: boolean; className: string; onTap: () => void }) {
  const { label, cell, now, future, on, className, onTap } = props
  const base = `bg-bg flex flex-col items-center justify-center ${className}`
  if (future) {
    return (
      <span className={base}>
        <span className="num text-[14px] text-muted">{label}</span>
      </span>
    )
  }
  return (
    <button type="button" className={`${base} ${on ? 'ring-2 ring-brand' : ''}`} onClick={onTap}>
      <span className={`num text-[14px] leading-tight ${now ? 'font-bold text-brand-ink' : 'font-semibold'}`}>{label}</span>
      {cell && cell.income > 0 ? <span className="num text-[10px] leading-tight text-income">+{fmtShortYuan(cell.income)}</span> : null}
      {cell && cell.expense > 0 ? <span className="num text-[10px] leading-tight text-expense">-{fmtShortYuan(cell.expense)}</span> : null}
    </button>
  )
}

function Detail({ level, sel, cell, onGo }: { level: CalLevel; sel: string; cell: CalCell | undefined; onGo: () => void }) {
  const label = level === 'day' ? fmtDateZh(sel) : level === 'month' ? `${Number(sel.slice(0, 4))}年${Number(sel.slice(5, 7))}月` : `${sel}年`
  const more = level === 'day' ? '看流水 ›' : level === 'month' ? '看每天 ›' : '看各月 ›'
  return (
    <div className="mt-3 pt-3 border-t border-line flex items-baseline justify-between gap-2 text-xs">
      <span className="min-w-0">
        <span className="font-medium">{label}</span>
        <span className="num text-muted">
          {cell && cell.income ? (
            <>
              {' · 收入 '}
              <span className="text-income">{fmtYuan(cell.income, { sign: true })}</span>
            </>
          ) : null}
          {' · 支出 '}
          <span className="text-expense">{fmtYuan(-(cell?.expense ?? 0))}</span>
          {cell?.count ? ` · ${cell.count}笔` : ''}
        </span>
      </span>
      <button type="button" className="shrink-0 text-brand-ink" onClick={onGo}>
        {more}
      </button>
    </div>
  )
}

function Chevron({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )
}
