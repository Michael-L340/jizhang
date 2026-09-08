import { lazy, Suspense, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { accountColor } from '../components/AccountIcon'
import { MonthPicker } from '../components/MonthPicker'
import { RANGE_LABEL, RangeSheet, type RangeValue } from '../components/RangeSheet'
import { Sheet } from '../components/Sheet'
import { balanceSeries, bucketEnd, bucketKeys, byCategory, dailyAverage, firstFlowDate, monthTotals, seriesByCategory, seriesTotals, splitAccounts, UNCATEGORIZED_ID, type Unit } from '../lib/compute'
import { addDays, fmtDateZh, fmtMonthZh, monthOf, monthRange, shiftMonth, today } from '../lib/date'
import { fmtYuan } from '../lib/money'
import { axisLabels, gridTopFor, legendRows, pairedAxisMax, shortLabels } from '../lib/chart'
import { adjustTotals, shiftSeries, visibleTxs } from '../lib/facade'
import { CHILD_NONE } from '../lib/filter'
import { categoryColor, CHART, childColors } from '../lib/palette'
import { usePersistedState, useRecentState, useTabReset } from '../lib/hooks'
import { useActiveAccounts, useStore } from '../lib/store'

const Chart = lazy(() => import('../components/Chart'))
const yuan = (v: number) => `¥${fmtYuan(Math.round(v * 100))}`
/** 日均那条线的名字。提示框和图例都按它认人，别写成字面量散在各处 */
const AVG = '日均消费'
/** 垫在日均线底下的白色粗线，让它压过彩色柱子也看得清。不进图例、不进提示框 */
const HALO = '日均消费·垫底'
/** 现在点一下只出提示框，得告诉用户还能再点一下，否则会以为点坏了 */
const TAP = '<div style="margin-top:5px;font-size:11px;opacity:.6">再点一下看流水 ›</div>'
/**
 * y 轴那列数字要占掉的宽度，给 axisLabels 估「一格有多宽」用。
 * 左边是金额（最宽四位数 + 轴间距），右边只有堆叠档才有（日均那根轴）。
 */
const AXIS_GUTTER = { one: 44, two: 62 }
const axisMoney = (v: number) => (Math.abs(v) >= 10000 ? `${+(v / 10000).toFixed(1)}万` : String(v))

export function Stats() {
  const txs = useStore((s) => s.transactions)
  const cats = useStore((s) => s.categories)
  const mode = useStore((s) => s.mode)
  // 余额曲线只画资产账户：白条是欠款，用户不要它出现在曲线里，合计线也只算资产
  const allAccounts = useActiveAccounts()
  const accounts = useMemo(() => splitAccounts(allAccounts).assets, [allAccounts])
  const nav = useNavigate()
  // 月份和下钻是「这次在看什么」：切去流水核一笔再回来还在，隔几个小时再开就回本月
  const [ym, setYm] = useRecentState('jz_stats_ym', () => monthOf(today()))
  const [kind, setKind] = usePersistedState<'expense' | 'income'>('jz_stats_pieKind', 'expense')
  const [drill, setDrill] = useRecentState<string | null>('jz_stats_drill', null)
  const [lineMode, setLineMode] = usePersistedState<'total' | 'category' | 'stack'>('jz_stats_lineMode', 'total')
  const [unit, setUnit] = usePersistedState<Unit>('jz_stats_unit', 'month')
  const [range, setRange] = usePersistedState<RangeValue>('jz_stats_range', { kind: 'year' })
  const [rangeOpen, setRangeOpen] = useState(false)
  const [trendKind, setTrendKind] = usePersistedState<'expense' | 'income'>('jz_stats_trendKind', 'expense')
  const [balMode, setBalMode] = usePersistedState<'total' | 'account'>('jz_stats_balMode', 'total')
  const [help, setHelp] = useState(false)

  // 折线图图例改成换行显示（原来是 type:'scroll'，五个分类会变成「1/2」要翻页）。
  // ECharts 会自己换行，但不会告诉你换了几行，grid.top 得自己算：留少了线盖住图例，
  // 留多了上面一片空白。宽度按整页最宽 430 减去页面和卡片的左右内边距估。
  const chartW = Math.min(typeof window === 'undefined' ? 393 : window.innerWidth, 430) - 64

  // 再点一次「统计」只退出分类下钻，顺带滚回顶部。
  // 月份、收支、时间范围都是用户为了看某段趋势刚挑的，一起清掉反而烦人。
  useTabReset(() => setDrill(null))

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

  /**
   * 下钻之后点某个二级分类 → 跳到流水页，月份、收支、一级、二级都替用户筛好。
   * 「未细分」和「未分类」在饼图里是拼出来的桶 id，得翻译成流水页认识的写法。
   */
  function gotoDetail(id: string) {
    if (!drillAgg || !id) return
    const p = new URLSearchParams({ ym, type: kind })
    if (drillAgg.id === UNCATEGORIZED_ID) {
      p.set('cat', 'none')
    } else {
      p.set('cat', drillAgg.id)
      if (id !== drillAgg.id) p.set('sub', id === `${drillAgg.id}:none` ? CHILD_NONE : id)
    }
    nav(`/ledger?${p}`)
  }

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
  // 本月还没走完时，日均那条线的最后一段画成虚线——÷ 已过天数会让它冲高，
  // 得让人一眼看出「这个点还在动」，别拿它跟前面几个月直接比
  const openEnd = unit === 'month' && keys.length > 0 && keys[keys.length - 1] === monthOf(today())

  // x 轴标签：年份永远带着，装不下就逐级降密度（降级链在 lib/chart.ts 的 axisLabels）。
  // 堆叠档多一根右轴，可用宽度要多让出一列数字，所以两张图分开算。
  const trendAxis = useMemo(
    () => axisLabels(keys, unit, chartW - (lineMode === 'stack' ? AXIS_GUTTER.two : AXIS_GUTTER.one)),
    [keys, unit, chartW, lineMode],
  )
  const balAxis = useMemo(() => axisLabels(keys, unit, chartW - AXIS_GUTTER.one), [keys, unit, chartW])
  const avg = useMemo(() => dailyAverage(keys, unit, trendTotal), [keys, unit, trendTotal])

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
          return [head, ...(rows.length ? rows : ['无支出'])].join('<br/>') + TAP
        },
      },
      grid: { left: 4, right: 14, top: 34, bottom: 0, containLabel: true },
      xAxis: {
        type: 'category',
        data: trendAxis.text,
        // 柱子必须留边距，否则首尾两根会被画到轴外面只剩一半
        boundaryGap: lineMode === 'stack' ? true : fewPoints,
        axisTick: { show: false },
        axisLine: { lineStyle: { color: CHART.axis } },
        axisLabel: { fontSize: 10, color: CHART.label, interval: (i: number) => trendAxis.show[i] ?? false },
      },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: CHART.axis } }, axisLabel: { fontSize: 10, color: CHART.label, formatter: axisMoney } },
    }
    if (lineMode === 'total') {
      return {
        ...base,
        color: [trendKind === 'expense' ? CHART.expense : CHART.income],
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
            label: { show: fewPoints, position: 'top', fontSize: 10, color: CHART.label, formatter: (p: { value: number }) => yuan(p.value) },
            data: trendTotal.map((v) => v / 100),
          },
        ],
      }
    }
    // 图例和 x 轴用缩写（「非经常生活消费」→「非经常」），提示框里仍然是全名
    const names = trendByCat.map((c) => c.name)
    const withAvg = lineMode === 'stack' && avg.length > 0 ? [...names, AVG] : names
    const short = shortLabels(withAvg)
    const shortOf = new Map(withAvg.map((n, i) => [n, short[i]]))
    const legend = {
      data: withAvg,
      formatter: (n: string) => shortOf.get(n) ?? n,
      top: 0,
      width: chartW,
      itemWidth: 14,
      itemHeight: 8,
      itemGap: 10,
      textStyle: { fontSize: 11 },
    }
    const top = gridTopFor(legendRows(short, chartW))

    if (lineMode === 'stack') {
      // 双轴对齐：两根轴都取「好看步长 × 5 格」，网格线一一对上，线也就稳定地贴着柱顶跑。
      // lineMax 只看**完整**的桶——本月才过几天，日均是完整月的三五倍，
      // 拿它定量程会把前面十一个月全压进柱子肚子里（改之前就是这个样子）。
      const barMax = keys.reduce((m, _, i) => Math.max(m, trendByCat.reduce((t, c) => t + c.data[i], 0) / 100), 0)
      const isClosed = (i: number) => !(openEnd && i === avg.length - 1)
      const closed = avg.filter((_, i) => isClosed(i))
      const lineMax = closed.length ? Math.max(...closed) / 100 : 0
      const hasLine = lineMax > 0
      // 「标准桶天数」取完整桶的中位数。bucketEnd 按月给的是当月最后一天，日号就是天数。
      const dayCounts = keys.filter((_, i) => isClosed(i)).map((k) => +bucketEnd(k, unit).slice(8, 10)).sort((a, b) => a - b)
      const ax = pairedAxisMax(barMax, lineMax, dayCounts[dayCounts.length >> 1] ?? 30)
      const tick = (max: number) => ({ max, interval: max / 5 })
      return {
        ...base,
        // 颜色按 series 顺序发：五个分类、垫底白线、日均线
        color: [...names.map((n, i) => categoryColor(n, i)), CHART.gap, CHART.avg],
        grid: { ...base.grid, top: hasLine ? top : gridTopFor(legendRows(shortLabels(names), chartW)) },
        legend: hasLine ? legend : { ...legend, data: names },
        tooltip: {
          ...base.tooltip,
          axisPointer: { type: 'shadow' },
          formatter: (ps: { dataIndex: number; marker: string; seriesName: string; value: number }[]) => {
            if (!ps.length) return ''
            const bars = ps.filter((p) => p.seriesName !== AVG && p.seriesName !== HALO && p.value > 0).sort((a, b) => b.value - a.value)
            const sum = bars.reduce((t, p) => t + p.value, 0)
            if (!bars.length) return [full(ps[0].dataIndex), '无支出'].join('<br/>') + TAP
            const rows = bars.map(
              (p) =>
                `${p.marker}${p.seriesName}<span style="float:right;margin-left:16px;font-weight:600">${yuan(p.value)}</span><span style="float:right;margin-left:16px;opacity:.6">${Math.round((p.value / sum) * 100)}%</span>`,
            )
            const at = ps[0].dataIndex
            // 日均那条线在本月是断开的，所以这里从 avg 现取，不靠 ps 里有没有那个系列
            const days = keys[at] === monthOf(today()) ? +today().slice(8, 10) : +bucketEnd(keys[at], unit).slice(8, 10)
            const tail = [
              `<span style="opacity:.75">合计</span><span style="float:right;margin-left:16px;font-weight:600">${yuan(sum)}</span>`,
              ...(avg.length ? [`<span style="opacity:.75">日均 · ${days} 天</span><span style="float:right;margin-left:16px;font-weight:600">${yuan(avg[at] / 100)}</span>`] : []),
            ]
            return [full(at), ...rows, '<div style="border-top:1px solid rgba(255,255,255,.22);margin:5px 0"></div>', ...tail].join('<br/>') + TAP
          },
        },
        yAxis: hasLine
          ? [
              { ...base.yAxis, ...tick(ax.bar) },
              { type: 'value', ...tick(ax.line), splitLine: { show: false }, axisLabel: { fontSize: 10, color: CHART.label, formatter: axisMoney } },
            ]
          : base.yAxis,
        series: [
          ...trendByCat.map((c) => ({
            name: c.name,
            type: 'bar',
            stack: 'x',
            barMaxWidth: 26,
            // 段与段之间留一道白缝，五段叠在一起才分得开（和饼图同一个做法）
            itemStyle: { borderColor: CHART.gap, borderWidth: 1 },
            data: c.data.map((v) => v / 100),
          })),
          ...(hasLine
            ? [
                // 垫底的白线：真画一条粗的白线在下面，比 shadowBlur 干净，
                // 也比它稳（canvas 的阴影在某些机器上会糊成一团）
                {
                  name: HALO,
                  type: 'line',
                  yAxisIndex: 1,
                  smooth: false,
                  showSymbol: false,
                  silent: true,
                  lineStyle: { width: 5, color: CHART.gap },
                  z: 2,
                  data: avg.map((v, i) => (isClosed(i) ? v / 100 : null)),
                },
                {
                  name: AVG,
                  type: 'line',
                  yAxisIndex: 1,
                  // 柱子是硬边，配直线段比平滑曲线利落
                  smooth: false,
                  symbol: 'circle',
                  symbolSize: 5,
                  showSymbol: keys.length <= 40,
                  itemStyle: { color: CHART.avg, borderColor: CHART.gap, borderWidth: 1.5 },
                  lineStyle: { width: 1.8 },
                  z: 3,
                  // 本月还没走完，÷ 已过天数会冲到完整月的三五倍——不画进线里，
                  // 数字放在卡片上方那行小字和提示框里，一个都不少
                  data: avg.map((v, i) => (isClosed(i) ? v / 100 : null)),
                },
              ]
            : []),
        ],
      }
    }

    return {
      ...base,
      color: names.map((n, i) => categoryColor(n, i)),
      grid: { ...base.grid, top },
      legend,
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
  }, [lineMode, keys, trendAxis, trendTotal, trendByCat, avg, openEnd, fewPoints, unit, trendKind, chartW])

  // 里外页面：外模式先把被修饰账户的校准从流水里摘掉，再按「偏移量 + 该账户校准合计」平移。
  // 两件事必须配对，理由和算式写在 facade.ts 的 shiftSeries 上。
  // adjustTotals 要拿全量 txs 算——curveTxs 里校准已经没了。
  const curveTxs = useMemo(() => visibleTxs(txs, accounts, mode), [txs, accounts, mode])
  const adjusts = useMemo(() => adjustTotals(txs, accounts), [txs, accounts])
  const bal = useMemo(
    () => shiftSeries(balanceSeries(curveTxs, accounts, keys, unit), accounts, mode, adjusts),
    [curveTxs, accounts, keys, unit, mode, adjusts],
  )
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
            : [full(ps[0].dataIndex), ...ps.map((p) => `${p.marker}${p.seriesName}<span style="float:right;margin-left:16px;font-weight:600">${yuan(p.value)}</span>`)].join('<br/>') + TAP,
      },
      grid: { left: 4, right: 14, top: 16, bottom: 0, containLabel: true },
      xAxis: {
        type: 'category',
        data: balAxis.text,
        boundaryGap: fewPoints,
        axisTick: { show: false },
        axisLine: { lineStyle: { color: CHART.axis } },
        axisLabel: { fontSize: 10, color: CHART.label, interval: (i: number) => balAxis.show[i] ?? false },
      },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: CHART.axis } }, axisLabel: { fontSize: 10, color: CHART.label, formatter: axisMoney } },
    }
    if (balMode === 'total') {
      return {
        ...common,
        color: [CHART.balance],
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
            label: { show: fewPoints, position: 'top', fontSize: 10, color: CHART.label, formatter: (p: { value: number }) => yuan(p.value) },
            data: bal.total.map((v) => v / 100),
          },
        ],
      }
    }
    return {
      ...common,
      color: accounts.map((a) => accountColor(a.name)),
      grid: { ...common.grid, top: gridTopFor(legendRows(accounts.map((a) => a.name), chartW)) },
      legend: { data: accounts.map((a) => a.name), top: 0, width: chartW, itemWidth: 14, itemHeight: 8, itemGap: 10, textStyle: { fontSize: 11 } },
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
  }, [bal, accounts, keys, balAxis, fewPoints, unit, balMode])

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
            <button type="button" className="text-sm text-brand-ink px-1" onClick={() => setDrill(null)}>
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
                <Chart option={pieOption} height={232} onClick={(p) => (drilled ? gotoDetail(pieRows[p.dataIndex]?.id ?? '') : setDrill(agg[p.dataIndex]?.id ?? null))} />
              </Suspense>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <div className="text-[11px] text-muted max-w-[46%] text-center leading-tight">
                  {drillAgg ? drillAgg.name : `${ym === monthOf(today()) ? '本月' : fmtMonthZh(ym)}${kind === 'expense' ? '支出' : '收入'}`}
                </div>
                <div className="num text-[22px] font-bold leading-tight mt-0.5">{fmtYuan(pieTotal, { symbol: true })}</div>
              </div>
            </div>

            <div className="flex flex-col mt-1">
              {pieRows.map((r, i) => (
                <button
                  key={r.id}
                  type="button"
                  className="flex items-center gap-2.5 py-2 border-b border-line last:border-0 text-left"
                  onClick={() => (drilled ? gotoDetail(r.id) : setDrill(r.id))}
                >
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: pieColors[i % pieColors.length] }} />
                  <span className="flex-1 min-w-0 truncate text-[15px]">{r.name}</span>
                  {/* 笔数用户说不需要（分类管理页同理）。占比居中，让名字和金额各占一边 */}
                  <span className="num text-xs text-muted w-11 text-center shrink-0">{pieTotal ? Math.round((r.amount / pieTotal) * 100) : 0}%</span>
                  <span className="num w-[88px] text-right shrink-0">{fmtYuan(r.amount)}</span>
                  <span className="text-muted text-xs shrink-0">›</span>
                </button>
              ))}
            </div>
            {/* 下钻之后多一个出口：不挑二级，直接看这个大类的全部流水。
                放在二级列表末尾而不是做成一级列表里的第二个热区——「点一级 = 看二级」
                这条规则不该再叠第二层含义，行尾也挤不下第二个够大的点击区。 */}
            {drillAgg ? (
              <button
                type="button"
                className="w-full flex items-center gap-2 mt-1 pt-2.5 border-t border-line text-left text-[13px] text-muted"
                onClick={() => gotoDetail(drillAgg.id)}
              >
                <span className="flex-1 min-w-0 truncate">
                  不分二级，查看「{drillAgg.name}」全部 {drillAgg.count} 笔
                </span>
                <span className="shrink-0">›</span>
              </button>
            ) : null}
            <div className="text-[11px] text-muted text-center mt-2">{drilled ? '点某一项，看是哪几笔' : '点任意一项查看二级分类'}</div>
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
            {/* 本月那个点没画进线里（÷ 已过天数会冲到完整月的三五倍，量程一撑，前面十一个月全压扁），
                所以把数字摆在这儿。提示框里也有一份。 */}
            {lineMode === 'stack' && openEnd && avg.length ? (
              <div className="text-[11px] text-muted mt-0.5">
                本月日均 {fmtYuan(avg[avg.length - 1], { symbol: true })} · {+today().slice(8, 10)} 天
              </div>
            ) : null}
          </div>
          <div className="inline-flex rounded-full bg-bg p-0.5">
            {(['total', 'category', 'stack'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={`px-3 py-1 rounded-full text-xs ${lineMode === m ? 'bg-ink text-white' : 'text-muted'}`}
                onClick={() => setLineMode(m)}
              >
                {m === 'total' ? '合计' : m === 'category' ? '分类' : '堆叠'}
              </button>
            ))}
          </div>
        </div>

        {lineMode !== 'total' && trendByCat.length === 0 ? (
          <div className="text-sm text-muted py-12 text-center">这段时间没有{trendKind === 'expense' ? '支出' : '收入'}</div>
        ) : (
          <Suspense fallback={<div style={{ height: 230 }} />}>
            <Chart option={trendOption} height={230} onAxisClick={gotoLedger} />
          </Suspense>
        )}
        <div className="text-[11px] text-muted mt-1">
          {lineMode === 'stack'
            ? `每根柱是${unit === 'day' ? '当天' : '当月'}${trendKind === 'expense' ? '支出' : '收入'}总额，按一级分类分段`
            : `每个点是${unit === 'day' ? '当天' : '当月'}${trendKind === 'expense' ? '支出' : '收入'}总额${lineMode === 'category' ? '，按分类分开' : ''}`}
          {lineMode === 'stack' && avg.length ? '；线是日均（当月总额 ÷ 已过天数），走右轴，本月还没走完不画进线里' : ''}。点一下看明细，再点一下看
          {unit === 'day' ? '当天' : '当月'}的流水。
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
