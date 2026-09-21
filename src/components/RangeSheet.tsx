import { useState } from 'react'
import { DatePicker } from './DatePicker'
import { Sheet } from './Sheet'
import { fmtDateZh, today } from '../lib/date'

export type RangeKind = 'month' | 'ytd' | 'quarter' | 'half' | 'year' | 'all' | 'custom'

export interface RangeValue {
  kind: RangeKind
  /** kind='custom' 时有效 */
  start?: string
  end?: string
}

/** 「本月 / 本年」和「近 N 个月」一样，都以顶部选中的月份为「现在」（用户 2026-09-21 加的两项） */
export const RANGE_LABEL: Record<RangeKind, string> = {
  month: '本月',
  ytd: '本年',
  quarter: '近三个月',
  half: '近半年',
  year: '近一年',
  all: '全部记录',
  custom: '自定义',
}

interface Props {
  open: boolean
  value: RangeValue
  earliest: string
  onChange: (v: RangeValue) => void
  onClose: () => void
}

export function RangeSheet({ open, value, earliest, onChange, onClose }: Props) {
  const [start, setStart] = useState(value.start ?? earliest)
  const [end, setEnd] = useState(value.end ?? today())
  const [pick, setPick] = useState<'start' | 'end' | null>(null)

  const options: RangeKind[] = ['month', 'ytd', 'quarter', 'half', 'year', 'all']

  return (
    <>
      <Sheet open={open} onClose={onClose} title="时间范围">
        {/* 两列格子。曾是竖列，加到六项后整块 560px 高，小屏要顶到状态栏；两列三行和原来四行差不多高（用户 2026-09-21 选的乙） */}
        <div className="grid grid-cols-2 gap-2 mt-3">
          {options.map((k) => {
            const on = value.kind === k
            return (
              <button
                key={k}
                type="button"
                className={`h-[52px] rounded-2xl text-[15px] ${on ? 'bg-brand text-on-brand font-semibold' : 'bg-bg text-ink'}`}
                onClick={() => {
                  onChange({ kind: k })
                  onClose()
                }}
              >
                {RANGE_LABEL[k]}
              </button>
            )
          })}
        </div>

        <div className="mt-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-muted">自定义区间</span>
            {value.kind === 'custom' ? <Check /> : null}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="chip flex-1 text-center" onClick={() => setPick('start')}>
              {fmtDateZh(start, false)}
            </button>
            <span className="text-muted">至</span>
            <button type="button" className="chip flex-1 text-center" onClick={() => setPick('end')}>
              {fmtDateZh(end, false)}
            </button>
          </div>
          <button
            type="button"
            className="w-full mt-3 py-2.5 rounded-xl bg-brand text-on-brand text-sm font-medium"
            onClick={() => {
              const a = start <= end ? start : end
              const b = start <= end ? end : start
              onChange({ kind: 'custom', start: a, end: b })
              onClose()
            }}
          >
            使用这个区间
          </button>
        </div>
      </Sheet>

      <DatePicker
        open={pick === 'start'}
        value={start}
        max={end}
        onPick={setStart}
        onClose={() => setPick(null)}
      />
      <DatePicker open={pick === 'end'} value={end} max={today()} onPick={setEnd} onClose={() => setPick(null)} />
    </>
  )
}

function Check() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="text-brand-ink">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  )
}
