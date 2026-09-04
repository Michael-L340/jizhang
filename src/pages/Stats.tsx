import { lazy, Suspense, useMemo, useState } from 'react'
import { accountColor } from '../components/AccountIcon'
import { MonthPicker } from '../components/MonthPicker'
import { RANGE_LABEL, RangeSheet, type RangeValue } from '../components/RangeSheet'
import { Sheet } from '../components/Sheet'
import { adjustTotal, balanceHistory, bucketKeys, byCategory, firstFlowDate, monthTotals, monthlySeries, seriesByCategory, seriesTotals, type Unit } from '../lib/compute'
import { addDays, fmtDateZh, monthOf, monthRange, shiftMonth, today } from '../lib/date'
import { fmtYuan } from '../lib/money'
import { categoryColor, childColors } from '../lib/palette'
import { useActiveAccounts, useStore } from '../lib/store'

const Chart = lazy(() => import('../components/Chart'))
const yuan = (v: number) => `¥${fmtYuan(Math.round(v * 100))}`
const axisMoney = (v: number) => (Math.abs(v) >= 10000 ? `${+(v / 10000).toFixed(1)}万` : String(v))

export function Stats() {
  const txs = useStore((s) => s.transactions)
  const cats = useStore((s) => s.categories)
  const accounts = useActiveAccounts()
  const [ym, setYm] = useState(monthOf(today()))
  const [kind, setKind] = useState<'expense' | 'income'>('expense')
  const [drill, setDrill] = useState<string | null>(null)
  const [lineMode, setLineMode] = useState<'total' | 'category'>('total')
  const [unit, setUnit] = useState<Unit>('month')
  const [range, setRange] = useState<RangeValue>({ kind: 'year' })
  const [rangeOpen, setRangeOpen] = useState(false)
  const [help, setHelp] = useState(false)

  const agg = useMemo(() => byCategory(txs, cats, ym, kind), [txs, cats, ym, kind])
  const rootColors = useMemo(() => agg.map((a, i) => categoryColor(a.name, i)), [agg])

  const drillIdx = drill ? agg.findIndex((a) => a.id === drill) : -1
  const drillAgg = drillIdx >= 0 ? agg[drillIdx] : undefined
  const pieRows = drillAgg
    ? drillAgg.children.length
      ? drillAgg.children
      : [{ id: drillAgg.id, name: drillAgg.name, amount: drillAgg.amount, count: drillAgg.count }]
    : agg
  const pieColors = drillAgg ? childColors(rootColors[drillIdx], pieRows.length) : rootColors
  const pieTotal = pieRows.reduce((s, r) => s + r.amount, 0)

  const pieOption = useMemo(
    () => ({
      color: pieColors,
      tooltip: { trigger: 'item', valueFormatter: yuan, confine: true },
      series: [
        {
          type: 'pie',
          radius: ['62%', '88%'],
          center: ['50%', '50%'],
          avoidLabelOverlap: false,
          label: { show: false },
          labelLine: { show: false },
          itemStyle: { borderColor: '#fff', borderWidth: 2, borderRadius: 3 },
          data: pieRows.map((r) => ({ name: r.name, value: r.amount / 100 })),
        },
      ],
    }),
    [pieRows, pieColors],
  )

  const series12 = useMemo(() => monthlySeries(txs, ym, 12), [txs, ym])
  const barOption = useMemo(
    () => ({
      color: ['#e5484d', '#1f9d55'],
      tooltip: { trigger: 'axis', valueFormatter: yuan, confine: true },
      legend: { data: ['支出', '收入'], top: 0, itemWidth: 10, itemHeight: 10, textStyle: { fontSize: 11 } },
      grid: { left: 4, right: 8, top: 32, bottom: 0, containLabel: true },
      xAxis: {
        type: 'category',
        data: series12.map((r) => `${+r.ym.slice(5)}月`),
        axisTick: { show: false },
        axisLine: { lineStyle: { color: '#e6e8ec' } },
        axisLabel: { fontSize: 10, color: '#7a808c', interval: 0 },
      },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: '#f0f1f4' } }, axisLabel: { fontSize: 10, color: '#7a808c', formatter: axisMoney } },
      series: [
        { name: '支出', type: 'bar', data: series12.map((r) => r.expense / 100), barMaxWidth: 11, itemStyle: { borderRadius: [3, 3, 0, 0] } },
        { name: '收入', type: 'bar', data: series12.map((r) => r.income / 100), barMaxWidth: 11, itemStyle: { borderRadius: [3, 3, 0, 0] } },
      ],
    }),
    [series12],
  )

  const earliest = useMemo(() => firstFlowDate(txs), [txs])

  // 趋势区间：终点跟随顶部选中的月份（当月则到今天），起点由范围选项决定
  const { start: tStart, end: tEnd } = useMemo(() => {
    if (range.kind === 'custom' && range.start && range.end) return { start: range.start, end: range.end }
    const monthEnd = monthRange(ym).end
    const t = today()
    const end = monthEnd > t ? t : monthEnd
    if (range.kind === 'all') return { start: earliest < end ? earliest : end, end }
    const back = range.kind === 'quarter' ? 3 : range.kind === 'half' ? 6 : 12
    const start = addDays(monthRange(shiftMonth(monthOf(end), -(back - 1))).start, 0)
    return { start, end }
  }, [range, ym, earliest])

  const keys = useMemo(() => bucketKeys(tStart, tEnd, unit), [tStart, tEnd, unit])
  const trendTotal = useMemo(() => seriesTotals(txs, keys, unit, 'expense'), [txs, keys, unit])
  const trendByCat = useMemo(() => seriesByCategory(txs, cats, keys, unit, 'expense'), [txs, cats, keys, unit])
  const trendSum = useMemo(() => trendTotal.reduce((a, b) => a + b, 0), [trendTotal])
  const fewPoints = keys.length <= 3
  const crossYear = keys.length > 0 && keys[0].slice(0, 4) !== keys[keys.length - 1].slice(0, 4)

  const labels = useMemo(
    () =>
      keys.map((k) =>
        unit === 'day'
          ? `${+k.slice(5, 7)}/${+k.slice(8, 10)}`
          : crossYear
            ? `${k.slice(2, 4)}.${+k.slice(5)}`
            : `${+k.slice(5)}月`,
      ),
    [keys, unit, crossYear],
  )

  const trendOption = useMemo(() => {
    const full = (i: number) => (unit === 'day' ? fmtDateZh(keys[i], false) : `${+keys[i].slice(0, 4)}年${+keys[i].slice(5)}月`)
    const base = {
      tooltip: {
        trigger: 'axis',
        confine: true,
        order: 'valueDesc',
        formatter: (ps: { dataIndex: number; marker: string; seriesName: string; value: number }[]) => {
          if (!ps.length) return ''
          const head = full(ps[0].dataIndex)
          const rows = ps
            .filter((p) => p.value > 0)
            .map((p) => `${p.marker}${p.seriesName}<span style="float:right;margin-left:16px;font-weight:600">${yuan(p.value)}</span>`)
          return [head, ...(rows.length ? rows : ['无支出'])].join('<br/>')
        },
      },
      grid: { left: 4, right: 14, top: 34, bottom: 0, containLabel: true },
      xAxis: {
        type: 'category',
        data: labels,
        boundaryGap: fewPoints,
        axisTick: { show: false },
        axisLine: { lineStyle: { color: '#e6e8ec' } },
        axisLabel: {
          fontSize: 10,
          color: '#7a808c',
          interval: keys.length <= 14 ? 0 : Math.ceil(keys.length / 8) - 1,
        },
      },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: '#f0f1f4' } }, axisLabel: { fontSize: 10, color: '#7a808c', formatter: axisMoney } },
    }
    if (lineMode === 'total') {
      return {
        ...base,
        color: ['#2f6fed'],
        legend: { show: false },
        grid: { ...base.grid, top: 16 },
        series: [
          {
            name: '支出',
            type: 'line',
            smooth: true,
            showSymbol: keys.length <= 40,
            symbolSize: 7,
            lineStyle: { width: 2.5 },
            areaStyle: { opacity: 0.1 },
            label: { show: fewPoints, position: 'top', fontSize: 10, color: '#7a808c', formatter: (p: { value: number }) => yuan(p.value) },
            data: trendTotal.map((v) => v / 100),
          },
        ],
      }
    }
    return {
      ...base,
      color: trendByCat.map((c, i) => categoryColor(c.name, i)),
      legend: { data: trendByCat.map((c) => c.name), top: 0, type: 'scroll', itemWidth: 14, itemHeight: 8, textStyle: { fontSize: 11 } },
      series: trendByCat.map((c) => ({
        name: c.name,
        type: 'line',
        smooth: true,
        showSymbol: keys.length <= 40,
        symbolSize: 6,
        lineStyle: { width: 2 },
        data: c.data.map((v) => v / 100),
      })),
    }
  }, [lineMode, keys, labels, trendTotal, trendByCat, fewPoints, unit])

  const hist = useMemo(() => balanceHistory(txs, accounts, 90), [txs, accounts])
  const balOption = useMemo(
    () => ({
      color: ['#16181d', ...accounts.map((a) => accountColor(a.name))],
      tooltip: { trigger: 'axis', valueFormatter: yuan, confine: true },
      legend: { data: ['合计', ...accounts.map((a) => a.name)], top: 0, type: 'scroll', itemWidth: 14, itemHeight: 8, textStyle: { fontSize: 11 } },
      grid: { left: 4, right: 12, top: 34, bottom: 0, containLabel: true },
      xAxis: {
        type: 'category',
        data: hist.dates.map((d) => d.slice(5).replace('-', '/')),
        boundaryGap: false,
        axisTick: { show: false },
        axisLine: { lineStyle: { color: '#e6e8ec' } },
        axisLabel: { fontSize: 10, color: '#7a808c', interval: 14 },
      },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: '#f0f1f4' } }, axisLabel: { fontSize: 10, color: '#7a808c', formatter: axisMoney } },
      series: [
        { name: '合计', type: 'line', showSymbol: false, data: hist.total.map((v) => v / 100), lineStyle: { width: 2.5 } },
        ...accounts.map((a) => ({ name: a.name, type: 'line', showSymbol: false, data: hist.series[a.id].map((v) => v / 100), lineStyle: { width: 1.2 } })),
      ],
    }),
    [hist, accounts],
  )

  const adjMonth = adjustTotal(txs, ym)
  const adjAll = adjustTotal(txs)
  const totalsByMonth = useMemo(() => monthTotals(txs), [txs])
  const roots = useMemo(() => cats.filter((c) => !c.parent_id && c.kind === 'expense' && !c.is_archived).sort((a, b) => a.sort - b.sort), [cats])

  return (
    <div className="px-4 pb-6">
      <MonthPicker value={ym} onChange={setYm} totals={totalsByMonth} />

      {/* 分类占比 */}
      <div className="card p-4 mb-3">
        <div className="flex items-center justify-between">
          <div className="inline-flex rounded-full bg-bg p-0.5">
            {(['expense', 'income'] as const).map((k) => (
              <button
                key={k}
                type="button"
                className={`px-3.5 py-1.5 rounded-full text-sm ${kind === k ? 'bg-ink text-white' : 'text-muted'}`}
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
            <button type="button" className="text-sm text-brand px-1" onClick={() => setDrill(null)}>
              ‹ 返回
            </button>
          ) : (
            <button type="button" className="text-xs text-muted border border-line rounded-full px-2.5 py-1" onClick={() => setHelp(true)}>
              分类说明
            </button>
          )}
        </div>

        {pieRows.length === 0 ? (
          <div className="text-sm text-muted py-12 text-center">本月没有数据</div>
        ) : (
          <>
            <div className="relative mt-1">
              <Suspense fallback={<div style={{ height: 232 }} />}>
                <Chart option={pieOption} height={232} onClick={(p) => !drill && setDrill(agg[p.dataIndex]?.id ?? null)} />
              </Suspense>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <div className="text-[11px] text-muted max-w-[46%] text-center leading-tight">
                  {drillAgg ? drillAgg.name : kind === 'expense' ? '本月支出' : '本月收入'}
                </div>
                <div className="num text-[22px] font-bold leading-tight mt-0.5">{fmtYuan(pieTotal, { symbol: true })}</div>
                <div className="text-[11px] text-muted mt-0.5">{pieRows.reduce((s, r) => s + r.count, 0)} 笔</div>
              </div>
            </div>

            <div className="flex flex-col mt-1">
              {pieRows.map((r, i) => (
                <button
                  key={r.id}
                  type="button"
                  className="flex items-center gap-2.5 py-2 border-b border-line last:border-0 text-left"
                  onClick={() => !drill && setDrill(r.id)}
                >
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: pieColors[i % pieColors.length] }} />
                  <span className="flex-1 min-w-0 truncate text-[15px]">{r.name}</span>
                  <span className="text-xs text-muted shrink-0">{r.count} 笔</span>
                  <span className="num text-xs text-muted w-9 text-right shrink-0">{pieTotal ? Math.round((r.amount / pieTotal) * 100) : 0}%</span>
                  <span className="num w-[88px] text-right shrink-0">{fmtYuan(r.amount)}</span>
                  {!drill ? <span className="text-muted text-xs shrink-0">›</span> : <span className="w-2" />}
                </button>
              ))}
            </div>
            {!drill ? <div className="text-[11px] text-muted text-center mt-2">点任意一项查看二级分类</div> : null}
          </>
        )}
      </div>

      {/* 支出趋势 */}
      <div className="card p-4 mb-3">
        <div className="flex items-start justify-between mb-2">
          <div>
            <div className="text-sm text-muted">支出趋势</div>
            <div className="num text-lg font-semibold leading-tight">{fmtYuan(trendSum, { symbol: true })}</div>
          </div>
          <div className="inline-flex rounded-full bg-bg p-0.5">
            {(['total', 'category'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={`px-3 py-1 rounded-full text-xs ${lineMode === m ? 'bg-ink text-white' : 'text-muted'}`}
                onClick={() => setLineMode(m)}
              >
                {m === 'total' ? '合计' : '分类'}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 mb-2">
          <div className="inline-flex rounded-full bg-bg p-0.5">
            {(['day', 'month'] as const).map((u) => (
              <button
                key={u}
                type="button"
                className={`px-3 py-1 rounded-full text-xs ${unit === u ? 'bg-ink text-white' : 'text-muted'}`}
                onClick={() => setUnit(u)}
              >
                {u === 'day' ? '按日' : '按月'}
              </button>
            ))}
          </div>
          <button type="button" className="chip flex items-center gap-1" style={{ padding: '5px 12px' }} onClick={() => setRangeOpen(true)}>
            {range.kind === 'custom' ? `${fmtDateZh(tStart, false)} - ${fmtDateZh(tEnd, false)}` : RANGE_LABEL[range.kind]}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="text-muted">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        </div>

        {lineMode === 'category' && trendByCat.length === 0 ? (
          <div className="text-sm text-muted py-12 text-center">这段时间没有支出</div>
        ) : (
          <Suspense fallback={<div style={{ height: 230 }} />}>
            <Chart option={trendOption} height={230} />
          </Suspense>
        )}
        <div className="text-[11px] text-muted mt-1">
          每个点是{unit === 'day' ? '当天' : '当月'}支出总额{lineMode === 'category' ? '，按用途分开' : ''}。
          {unit === 'month' && monthOf(tEnd) === monthOf(today()) ? '本月还没结束，显示的是目前的总计。' : ''}
        </div>
      </div>

      <div className="card p-4 mb-3">
        <div className="text-sm text-muted mb-1">近 12 个月收支</div>
        <Suspense fallback={<div style={{ height: 220 }} />}>
          <Chart option={barOption} height={220} />
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

      <RangeSheet open={rangeOpen} value={range} earliest={earliest} onChange={setRange} onClose={() => setRangeOpen(false)} />

      <Sheet open={help} onClose={() => setHelp(false)} title="五大类的含义">
        <div className="flex flex-col gap-3">
          {roots.map((c, i) => (
            <div key={c.id} className="flex gap-3">
              <span className="w-2.5 h-2.5 rounded-full mt-1.5 shrink-0" style={{ background: categoryColor(c.name, i) }} />
              <div className="min-w-0">
                <div className="font-medium">
                  {c.icon} {c.name}
                </div>
                <div className="text-sm text-muted">{c.note || '（未填写说明，可在设置页补充）'}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="text-xs text-muted mt-4">说明可以在「账户 → 设置 → 支出用途」里修改。</div>
      </Sheet>
    </div>
  )
}
