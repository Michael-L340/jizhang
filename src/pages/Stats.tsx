import { lazy, Suspense, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { accountColor } from '../components/AccountIcon'
import { MonthPicker } from '../components/MonthPicker'
import { RANGE_LABEL, RangeSheet, type RangeValue } from '../components/RangeSheet'
import { Sheet } from '../components/Sheet'
import { adjustTotal, balanceSeries, bucketEnd, bucketKeys, byCategory, firstFlowDate, isVerifiedAdjust, monthTotals, OPENING_NOTE, openingAdjustIds, seriesByCategory, seriesTotals, withVerified, withoutVerified, type Unit } from '../lib/compute'
import { addDays, fmtDateRel, fmtDateZh, fmtMonthZh, monthOf, monthRange, shiftMonth, today } from '../lib/date'
import { fmtYuan } from '../lib/money'
import { categoryColor, childColors } from '../lib/palette'
import { usePersistedState } from '../lib/hooks'
import { useActiveAccounts, useStore } from '../lib/store'

const Chart = lazy(() => import('../components/Chart'))
const yuan = (v: number) => `¥${fmtYuan(Math.round(v * 100))}`
const axisMoney = (v: number) => (Math.abs(v) >= 10000 ? `${+(v / 10000).toFixed(1)}万` : String(v))

export function Stats() {
  const txs = useStore((s) => s.transactions)
  const cats = useStore((s) => s.categories)
  const accounts = useActiveAccounts()
  const editTx = useStore((s) => s.editTx)
  const nav = useNavigate()
  const [ym, setYm] = useState(monthOf(today()))
  const [kind, setKind] = usePersistedState<'expense' | 'income'>('jz_stats_pieKind', 'expense')
  const [drill, setDrill] = useState<string | null>(null)
  const [lineMode, setLineMode] = usePersistedState<'total' | 'category'>('jz_stats_lineMode', 'total')
  const [unit, setUnit] = usePersistedState<Unit>('jz_stats_unit', 'month')
  const [range, setRange] = usePersistedState<RangeValue>('jz_stats_range', { kind: 'year' })
  const [rangeOpen, setRangeOpen] = useState(false)
  const [trendKind, setTrendKind] = usePersistedState<'expense' | 'income'>('jz_stats_trendKind', 'expense')
  const [balMode, setBalMode] = usePersistedState<'total' | 'account'>('jz_stats_balMode', 'total')
  const [help, setHelp] = useState(false)
  const [adjOpen, setAdjOpen] = useState(false)
  const [adjBusy, setAdjBusy] = useState(false)

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
  // drill 存的是分类 id，换月后那个分类可能在新月份里根本没有记录，drillAgg 变 undefined
  // 而 drill 仍是 truthy：界面退回一级列表，却因为到处写着 !drill 而点不动。
  // 全页统一用这个派生值判断，drill 只作为原始状态存在。
  const drilled = Boolean(drillAgg)

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

  const earliest = useMemo(() => firstFlowDate(txs), [txs])

  /** 点图表某个点 → 跳到那个月（按日时再定位到那一天）的流水 */
  function gotoLedger(i: number) {
    const k = keys[i]
    if (!k) return
    nav(unit === 'day' ? `/ledger?ym=${monthOf(k)}&date=${k}` : `/ledger?ym=${k}`)
  }

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
  // 趋势必须先按真实区间裁一刀。bucketKeys 在「按月」时会把两端折成整月，
  // 而 seriesTotals 只按 monthOf(date) 匹配桶键、从不看端点：选 6月1日–6月10日，
  // 算出来的是整个 6 月。非自定义区间的端点本来就对齐月初月末，这一刀是空操作。
  const inRange = useMemo(() => txs.filter((t) => t.date >= tStart && t.date <= tEnd), [txs, tStart, tEnd])
  const trendTotal = useMemo(() => seriesTotals(inRange, keys, unit, trendKind), [inRange, keys, unit, trendKind])
  const trendByCat = useMemo(() => seriesByCategory(inRange, cats, keys, unit, trendKind), [inRange, cats, keys, unit, trendKind])
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
        color: [trendKind === 'expense' ? '#e5484d' : '#1f9d55'],
        legend: { show: false },
        grid: { ...base.grid, top: 16 },
        series: [
          {
            name: trendKind === 'expense' ? '支出' : '收入',
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
  }, [lineMode, keys, labels, trendTotal, trendByCat, fewPoints, unit, trendKind])

  const bal = useMemo(() => balanceSeries(txs, accounts, keys, unit), [txs, accounts, keys, unit])
  // 大数字其实是「最后一个桶结束时」的余额。切到 8 月它就是 8/31 收盘值，
  // 而账户页显示的是当前值，两个页面对不上会让人以为同步坏了。
  // 用 bucketEnd 而不是 tEnd：按月时最后一个桶到月末，两者可能差好几天。
  const balAsOf = keys.length ? bucketEnd(keys[keys.length - 1], unit) : tEnd
  const balOption = useMemo(() => {
    const full = (i: number) => (unit === 'day' ? fmtDateZh(keys[i], false) : `${+keys[i].slice(0, 4)}年${+keys[i].slice(5)}月`)
    const common = {
      tooltip: {
        trigger: 'axis',
        confine: true,
        formatter: (ps: { dataIndex: number; marker: string; seriesName: string; value: number }[]) =>
          !ps.length
            ? ''
            : [full(ps[0].dataIndex), ...ps.map((p) => `${p.marker}${p.seriesName}<span style="float:right;margin-left:16px;font-weight:600">${yuan(p.value)}</span>`)].join('<br/>'),
      },
      grid: { left: 4, right: 14, top: balMode === 'total' ? 16 : 34, bottom: 0, containLabel: true },
      xAxis: {
        type: 'category',
        data: labels,
        boundaryGap: fewPoints,
        axisTick: { show: false },
        axisLine: { lineStyle: { color: '#e6e8ec' } },
        axisLabel: { fontSize: 10, color: '#7a808c', interval: keys.length <= 14 ? 0 : Math.ceil(keys.length / 8) - 1 },
      },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: '#f0f1f4' } }, axisLabel: { fontSize: 10, color: '#7a808c', formatter: axisMoney } },
    }
    if (balMode === 'total') {
      return {
        ...common,
        color: ['#2f6fed'],
        legend: { show: false },
        series: [
          {
            name: '总余额',
            type: 'line',
            smooth: true,
            showSymbol: keys.length <= 40,
            symbolSize: 7,
            lineStyle: { width: 2.5 },
            areaStyle: { opacity: 0.1 },
            label: { show: fewPoints, position: 'top', fontSize: 10, color: '#7a808c', formatter: (p: { value: number }) => yuan(p.value) },
            data: bal.total.map((v) => v / 100),
          },
        ],
      }
    }
    return {
      ...common,
      color: accounts.map((a) => accountColor(a.name)),
      legend: { data: accounts.map((a) => a.name), top: 0, type: 'scroll', itemWidth: 14, itemHeight: 8, textStyle: { fontSize: 11 } },
      series: accounts.map((a) => ({
        name: a.name,
        type: 'line',
        smooth: true,
        showSymbol: keys.length <= 40,
        symbolSize: 6,
        lineStyle: { width: 2 },
        data: bal.byAccount[a.id].map((v) => v / 100),
      })),
    }
  }, [bal, accounts, keys, labels, fewPoints, unit, balMode])

  const adjMonth = useMemo(() => adjustTotal(txs, ym), [txs, ym])
  const adjAll = useMemo(() => adjustTotal(txs), [txs])
  // 「未记录差额」的明细：每一笔校准是算作漏记、还是本金/已核实
  const adjRows = useMemo(() => {
    const opening = openingAdjustIds(txs)
    return txs
      .filter((t) => t.type === 'adjust' && t.amount !== 0)
      .sort((a, b) => (a.date === b.date ? (a.created_at < b.created_at ? 1 : -1) : a.date < b.date ? 1 : -1))
      .map((t) => ({
        tx: t,
        opening: opening.has(t.id) || t.note === OPENING_NOTE,
        verified: isVerifiedAdjust(t),
      }))
  }, [txs])
  const countable = adjRows.filter((r) => !r.opening && !r.verified)
  const totalsByMonth = useMemo(() => monthTotals(txs), [txs])
  const roots = useMemo(() => cats.filter((c) => !c.parent_id && c.kind === 'expense' && !c.is_archived).sort((a, b) => a.sort - b.sort), [cats])

  return (
    <div className="px-4 pb-6">
      <MonthPicker
        value={ym}
        onChange={(v) => {
          setYm(v)
          setDrill(null)
        }}
        totals={totalsByMonth}
      />

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
          {drilled ? (
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
                <Chart option={pieOption} height={232} onClick={(p) => !drilled && setDrill(agg[p.dataIndex]?.id ?? null)} />
              </Suspense>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <div className="text-[11px] text-muted max-w-[46%] text-center leading-tight">
                  {drillAgg ? drillAgg.name : `${ym === monthOf(today()) ? '本月' : fmtMonthZh(ym)}${kind === 'expense' ? '支出' : '收入'}`}
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
                  onClick={() => !drilled && setDrill(r.id)}
                >
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: pieColors[i % pieColors.length] }} />
                  <span className="flex-1 min-w-0 truncate text-[15px]">{r.name}</span>
                  <span className="text-xs text-muted shrink-0">{r.count} 笔</span>
                  <span className="num text-xs text-muted w-9 text-right shrink-0">{pieTotal ? Math.round((r.amount / pieTotal) * 100) : 0}%</span>
                  <span className="num w-[88px] text-right shrink-0">{fmtYuan(r.amount)}</span>
                  {!drilled ? <span className="text-muted text-xs shrink-0">›</span> : <span className="w-2" />}
                </button>
              ))}
            </div>
            {!drilled ? <div className="text-[11px] text-muted text-center mt-2">点任意一项查看二级分类</div> : null}
          </>
        )}
      </div>

      {/* 趋势区：时间控件对下面两张图共同生效 */}
      <div className="flex items-center justify-between px-1 pb-2">
        <span className="text-sm font-semibold">趋势</span>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-full bg-card border border-line p-0.5">
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
          <button type="button" className="chip flex items-center gap-1" style={{ padding: '5px 10px' }} onClick={() => setRangeOpen(true)}>
            {range.kind === 'custom' ? `${fmtDateZh(tStart, false)}-${fmtDateZh(tEnd, false)}` : RANGE_LABEL[range.kind]}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="text-muted">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        </div>
      </div>

      <div className="card p-4 mb-3">
        <div className="flex items-start justify-between mb-2">
          <div>
            <div className="inline-flex rounded-full bg-bg p-0.5 mb-1">
              {(['expense', 'income'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`px-3 py-1 rounded-full text-xs ${trendKind === k ? 'bg-ink text-white' : 'text-muted'}`}
                  onClick={() => setTrendKind(k)}
                >
                  {k === 'expense' ? '支出' : '收入'}
                </button>
              ))}
            </div>
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

        {lineMode === 'category' && trendByCat.length === 0 ? (
          <div className="text-sm text-muted py-12 text-center">这段时间没有{trendKind === 'expense' ? '支出' : '收入'}</div>
        ) : (
          <Suspense fallback={<div style={{ height: 230 }} />}>
            <Chart option={trendOption} height={230} onAxisClick={gotoLedger} />
          </Suspense>
        )}
        <div className="text-[11px] text-muted mt-1">
          每个点是{unit === 'day' ? '当天' : '当月'}{trendKind === 'expense' ? '支出' : '收入'}总额{lineMode === 'category' ? '，按分类分开' : ''}，点一下可以看{unit === 'day' ? '当天' : '当月'}的流水。
          {unit === 'month' && monthOf(tEnd) === monthOf(today()) ? '本月还没结束，显示的是目前的总计。' : ''}
        </div>
      </div>

      <div className="card p-4 mb-3">
        <div className="flex items-start justify-between mb-2">
          <div>
            <div className="text-sm text-muted">
              账户余额{balAsOf >= today() ? '（当前）' : ` · 截至${unit === 'day' ? fmtDateZh(balAsOf, false) : fmtMonthZh(monthOf(balAsOf)) + '末'}`}
            </div>
            <div className="num text-lg font-semibold leading-tight">{fmtYuan(bal.total[bal.total.length - 1] ?? 0, { symbol: true })}</div>
          </div>
          <div className="inline-flex rounded-full bg-bg p-0.5">
            {(['total', 'account'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={`px-3 py-1 rounded-full text-xs ${balMode === m ? 'bg-ink text-white' : 'text-muted'}`}
                onClick={() => setBalMode(m)}
              >
                {m === 'total' ? '合计' : '分账户'}
              </button>
            ))}
          </div>
        </div>
        <Suspense fallback={<div style={{ height: 230 }} />}>
          <Chart option={balOption} height={230} onAxisClick={gotoLedger} />
        </Suspense>
        <div className="text-[11px] text-muted mt-1">每个点是{unit === 'day' ? '当天' : '当月'}结束时的余额，含区间之前累计的全部记录；点一下可以看当时的流水。</div>
      </div>

      <button type="button" className="card p-4 mb-3 text-sm w-full text-left" onClick={() => setAdjOpen(true)}>
        <div className="flex justify-between py-1">
          <span className="text-muted">本月未记录差额</span>
          <span className={`num ${adjMonth < 0 ? 'text-expense' : adjMonth > 0 ? 'text-income' : ''}`}>{fmtYuan(adjMonth, { sign: true })}</span>
        </div>
        <div className="flex justify-between py-1">
          <span className="text-muted">累计未记录差额</span>
          <span className={`num ${adjAll < 0 ? 'text-expense' : adjAll > 0 ? 'text-income' : ''}`}>{fmtYuan(adjAll, { sign: true })}</span>
        </div>
        <div className="text-xs text-muted mt-1 flex items-center justify-between gap-2">
          <span>来自余额校准，不含开户时录入的初始余额：负数说明有支出没记，正数说明有收入没记。</span>
          <span className="text-brand shrink-0">明细 ›</span>
        </div>
      </button>

      <RangeSheet open={rangeOpen} value={range} earliest={earliest} onChange={setRange} onClose={() => setRangeOpen(false)} />

      <Sheet open={adjOpen} onClose={() => setAdjOpen(false)} title="未记录差额明细">
        <div className="text-xs text-muted leading-relaxed mb-3">
          每次在账户页输入实际余额，差额都会记一条「余额校准」。开户时录的第一笔是本金，已经自动排除。
          剩下的默认算作「有账没记」；如果你核对过、确认那笔差额有正当来源（比如利息、手续费、别人转的钱），
          可以标成「已核实」，它就不再计入这个数字，但记录本身还在流水里，随时能取消。
        </div>
        {countable.length > 1 ? (
          <button
            type="button"
            disabled={adjBusy}
            className="w-full mb-3 py-2.5 rounded-xl bg-bg text-sm disabled:opacity-40"
            onClick={async () => {
              setAdjBusy(true)
              for (const r of countable) await editTx({ ...r.tx, note: withVerified(r.tx.note) })
              setAdjBusy(false)
            }}
          >
            {adjBusy ? '处理中…' : `把这 ${countable.length} 笔全部标为已核实`}
          </button>
        ) : null}
        <div className="flex flex-col">
          {adjRows.length === 0 ? <div className="text-sm text-muted py-8 text-center">还没有任何余额校准</div> : null}
          {adjRows.map(({ tx, opening, verified }) => (
            <div key={tx.id} className="flex items-center gap-3 py-2.5 border-b border-line last:border-0">
              <span className="flex-1 min-w-0">
                <span className="block text-[15px] num">
                  {fmtYuan(tx.amount, { sign: true })}
                  <span className="text-xs text-muted ml-2">{accounts.find((a) => a.id === tx.account_id)?.name ?? '未知账户'}</span>
                </span>
                <span className="block text-xs text-muted truncate">
                  {fmtDateRel(tx.date)}
                  {opening ? ' · 开户本金，不计入' : verified ? ' · 已核实，不计入' : ' · 算作有账没记'}
                </span>
              </span>
              {opening ? (
                <span className="text-xs text-muted shrink-0">自动排除</span>
              ) : (
                <button
                  type="button"
                  disabled={adjBusy}
                  className={`text-xs shrink-0 rounded-full px-3 py-1.5 disabled:opacity-40 ${verified ? 'bg-bg text-muted' : 'bg-brand-soft text-brand'}`}
                  onClick={async () => {
                    setAdjBusy(true)
                    await editTx({ ...tx, note: verified ? withoutVerified(tx.note) : withVerified(tx.note) })
                    setAdjBusy(false)
                  }}
                >
                  {verified ? '取消核实' : '标为已核实'}
                </button>
              )}
            </div>
          ))}
        </div>
      </Sheet>

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
