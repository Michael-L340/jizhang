import { lazy, Suspense, useMemo, useState } from 'react'
import { accountColor } from '../components/AccountIcon'
import { adjustTotal, balanceHistory, byCategory, dailyCumulative, monthSummary, monthlySeries } from '../lib/compute'
import { daysInMonth, fmtMonthZh, monthOf, shiftMonth, today } from '../lib/date'
import { fmtYuan } from '../lib/money'
import { useActiveAccounts, useStore } from '../lib/store'

const Chart = lazy(() => import('../components/Chart'))

const COLORS = ['#2f6fed', '#f5a524', '#1f9d55', '#e5484d', '#7c5cff', '#0ea5e9', '#f97316', '#14b8a6', '#a855f7']
const yuan = (v: number) => `¥${fmtYuan(Math.round(v * 100))}`

export function Stats() {
  const txs = useStore((s) => s.transactions)
  const cats = useStore((s) => s.categories)
  const accounts = useActiveAccounts()
  const [ym, setYm] = useState(monthOf(today()))
  const [kind, setKind] = useState<'expense' | 'income'>('expense')
  const [drill, setDrill] = useState<string | null>(null)

  const sum = useMemo(() => monthSummary(txs, ym), [txs, ym])
  const agg = useMemo(() => byCategory(txs, cats, ym, kind), [txs, cats, ym, kind])
  const drillAgg = drill ? agg.find((a) => a.id === drill) : undefined
  const pieRows = drillAgg ? drillAgg.children.length ? drillAgg.children : [{ id: drillAgg.id, name: drillAgg.name, amount: drillAgg.amount, count: drillAgg.count }] : agg
  const pieTotal = pieRows.reduce((s, r) => s + r.amount, 0)

  const pieOption = useMemo(
    () => ({
      color: COLORS,
      tooltip: { trigger: 'item', valueFormatter: yuan },
      series: [
        {
          type: 'pie',
          radius: ['45%', '75%'],
          label: { formatter: '{b}\n{d}%', fontSize: 11 },
          data: pieRows.map((r) => ({ name: r.name, value: r.amount / 100 })),
        },
      ],
    }),
    [pieRows],
  )

  const series12 = useMemo(() => monthlySeries(txs, ym, 12), [txs, ym])
  const barOption = useMemo(
    () => ({
      color: ['#e5484d', '#1f9d55'],
      tooltip: { trigger: 'axis', valueFormatter: yuan },
      legend: { data: ['支出', '收入'], top: 0 },
      grid: { left: 8, right: 8, top: 30, bottom: 0, containLabel: true },
      xAxis: { type: 'category', data: series12.map((r) => r.ym.slice(5).replace(/^0/, '') + '月'), axisTick: { show: false } },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: '#eee' } }, axisLabel: { formatter: (v: number) => (v >= 10000 ? `${v / 10000}万` : String(v)) } },
      series: [
        { name: '支出', type: 'bar', data: series12.map((r) => r.expense / 100), barMaxWidth: 14 },
        { name: '收入', type: 'bar', data: series12.map((r) => r.income / 100), barMaxWidth: 14 },
      ],
    }),
    [series12],
  )

  const cum = useMemo(() => dailyCumulative(txs, ym), [txs, ym])
  const prevYm = shiftMonth(ym, -1)
  const cumPrev = useMemo(() => dailyCumulative(txs, prevYm, `${prevYm}-31`), [txs, prevYm])
  const lineOption = useMemo(
    () => ({
      color: ['#e5484d', '#c9ccd3'],
      tooltip: { trigger: 'axis', valueFormatter: yuan },
      legend: { data: [fmtMonthZh(ym), fmtMonthZh(prevYm)], top: 0 },
      grid: { left: 8, right: 12, top: 30, bottom: 0, containLabel: true },
      xAxis: { type: 'category', data: Array.from({ length: Math.max(daysInMonth(ym), daysInMonth(prevYm)) }, (_, i) => String(i + 1)), boundaryGap: false },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: '#eee' } } },
      series: [
        { name: fmtMonthZh(ym), type: 'line', smooth: true, showSymbol: false, data: cum.map((v) => (v === null ? null : v / 100)), areaStyle: { opacity: 0.08 } },
        { name: fmtMonthZh(prevYm), type: 'line', smooth: true, showSymbol: false, lineStyle: { type: 'dashed' }, data: cumPrev.map((v) => (v === null ? null : v / 100)) },
      ],
    }),
    [cum, cumPrev, ym, prevYm],
  )

  const hist = useMemo(() => balanceHistory(txs, accounts, 90), [txs, accounts])
  const balOption = useMemo(
    () => ({
      color: ['#16181d', ...accounts.map((a) => accountColor(a.name))],
      tooltip: { trigger: 'axis', valueFormatter: yuan },
      legend: { data: ['合计', ...accounts.map((a) => a.name)], top: 0, type: 'scroll' },
      grid: { left: 8, right: 12, top: 30, bottom: 0, containLabel: true },
      xAxis: { type: 'category', data: hist.dates.map((d) => d.slice(5).replace('-', '/')), boundaryGap: false },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: '#eee' } }, axisLabel: { formatter: (v: number) => (Math.abs(v) >= 10000 ? `${v / 10000}万` : String(v)) } },
      series: [
        { name: '合计', type: 'line', showSymbol: false, data: hist.total.map((v) => v / 100), lineStyle: { width: 2.5 } },
        ...accounts.map((a) => ({ name: a.name, type: 'line', showSymbol: false, data: hist.series[a.id].map((v) => v / 100), lineStyle: { width: 1.2 } })),
      ],
    }),
    [hist, accounts],
  )

  const adjMonth = adjustTotal(txs, ym)
  const adjAll = adjustTotal(txs)

  return (
    <div className="px-4 pb-6">
      <div className="flex items-center justify-between pt-3 pb-2">
        <button type="button" className="w-10 h-10 text-xl" onClick={() => setYm(shiftMonth(ym, -1))} aria-label="上个月">
          ‹
        </button>
        <button type="button" className="text-lg font-bold" onClick={() => setYm(monthOf(today()))}>
          {fmtMonthZh(ym)}
        </button>
        <button type="button" className="w-10 h-10 text-xl" onClick={() => setYm(shiftMonth(ym, 1))} aria-label="下个月">
          ›
        </button>
      </div>

      <div className="card p-4 mb-3">
        <div className="flex items-center justify-between mb-2">
          <div className="inline-flex rounded-full bg-bg p-0.5">
            {(['expense', 'income'] as const).map((k) => (
              <button
                key={k}
                type="button"
                className={`px-3 py-1 rounded-full text-sm ${kind === k ? 'bg-ink text-white' : 'text-muted'}`}
                onClick={() => {
                  setKind(k)
                  setDrill(null)
                }}
              >
                {k === 'expense' ? '支出' : '收入'}
              </button>
            ))}
          </div>
          {drill ? (
            <button type="button" className="text-sm text-brand" onClick={() => setDrill(null)}>
              ‹ 返回大类
            </button>
          ) : (
            <span className="text-xs text-muted">点扇区看二级</span>
          )}
        </div>
        <div className="text-sm text-muted">
          {drillAgg ? drillAgg.name : kind === 'expense' ? '本月支出' : '本月收入'}
          <span className="num ml-2 text-ink font-semibold">{fmtYuan(pieTotal, { symbol: true })}</span>
        </div>
        {pieRows.length === 0 ? (
          <div className="text-sm text-muted py-10 text-center">本月没有数据</div>
        ) : (
          <>
            <Suspense fallback={<div style={{ height: 260 }} />}>
              <Chart option={pieOption} height={260} onClick={(p) => !drill && kind === 'expense' && setDrill(agg[p.dataIndex]?.id ?? null)} />
            </Suspense>
            <div className="flex flex-col gap-2 mt-1">
              {pieRows.map((r, i) => (
                <button
                  key={r.id}
                  type="button"
                  className="flex items-center gap-2 text-sm text-left"
                  onClick={() => !drill && kind === 'expense' && setDrill(r.id)}
                >
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: COLORS[i % COLORS.length] }} />
                  <span className="flex-1 truncate">{r.name}</span>
                  <span className="text-xs text-muted">{r.count} 笔</span>
                  <span className="num text-xs text-muted w-10 text-right">{pieTotal ? Math.round((r.amount / pieTotal) * 100) : 0}%</span>
                  <span className="num w-24 text-right">{fmtYuan(r.amount)}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="card p-4 mb-3">
        <div className="text-sm text-muted mb-1">近 12 个月收支</div>
        <Suspense fallback={<div style={{ height: 220 }} />}>
          <Chart option={barOption} height={220} />
        </Suspense>
      </div>

      <div className="card p-4 mb-3">
        <div className="text-sm text-muted mb-1">
          每日累计支出 <span className="num text-ink font-semibold ml-1">{fmtYuan(sum.expense, { symbol: true })}</span>
        </div>
        <Suspense fallback={<div style={{ height: 220 }} />}>
          <Chart option={lineOption} height={220} />
        </Suspense>
      </div>

      <div className="card p-4 mb-3">
        <div className="text-sm text-muted mb-1">近 90 天账户余额</div>
        <Suspense fallback={<div style={{ height: 220 }} />}>
          <Chart option={balOption} height={220} />
        </Suspense>
      </div>

      <div className="card p-4 mb-3 text-sm">
        <div className="flex justify-between py-1">
          <span className="text-muted">本月未记录差额</span>
          <span className={`num ${adjMonth < 0 ? 'text-expense' : adjMonth > 0 ? 'text-income' : ''}`}>{fmtYuan(adjMonth, { sign: true })}</span>
        </div>
        <div className="flex justify-between py-1">
          <span className="text-muted">累计未记录差额</span>
          <span className={`num ${adjAll < 0 ? 'text-expense' : adjAll > 0 ? 'text-income' : ''}`}>{fmtYuan(adjAll, { sign: true })}</span>
        </div>
        <div className="text-xs text-muted mt-1">来自余额校准：负数说明有支出没记，正数说明有收入没记。</div>
      </div>
    </div>
  )
}
