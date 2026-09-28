// 进阶统计 ·「单笔多大」：范围内的支出按单笔金额分桶，柱子高 = 笔数；外加最大的五笔。
import { UNCATEGORIZED_NAME } from '../compute'
import { monthOf } from '../date'
import { fmtYuan } from '../money'
import { CHART } from '../palette'
import type { Category, Transaction } from '../../types'
import { rangeSpan } from './span'
import type { MoreChart, MoreInput, MoreTile } from './types'

/**
 * 分桶边界（分）。左闭右开：正好 20 元算「20–50」，19.99 算「<20」。
 * 最后一档没有上限。
 */
export const BUCKETS = [
  { label: '<20', max: 2000 },
  { label: '20–50', max: 5000 },
  { label: '50–100', max: 10000 },
  { label: '100–200', max: 20000 },
  { label: '200–500', max: 50000 },
  { label: '500+', max: Infinity },
] as const

export function bucketOf(cents: number): number {
  for (let i = 0; i < BUCKETS.length; i++) if (cents < BUCKETS[i].max) return i
  return BUCKETS.length - 1
}

export interface Histogram {
  /** 每档笔数 */
  count: number[]
  /** 每档金额合计（分） */
  cents: number[]
  /** 金额最大的五笔，大的在前；一样大按日期新的在前 */
  top: Transaction[]
}

export function histogramOf(txs: Transaction[], start: string, end: string): Histogram {
  const count = BUCKETS.map(() => 0)
  const cents = BUCKETS.map(() => 0)
  const spent: Transaction[] = []
  for (const t of txs) {
    if (t.type !== 'expense' || t.date < start || t.date > end) continue
    const b = bucketOf(t.amount)
    count[b] += 1
    cents[b] += t.amount
    spent.push(t)
  }
  const top = spent
    .sort((a, b) => b.amount - a.amount || (a.date === b.date ? (a.created_at < b.created_at ? 1 : -1) : a.date < b.date ? 1 : -1))
    .slice(0, 5)
  return { count, cents, top }
}

/** 一笔记在哪个分类上就叫哪个名字（记在二级上就是二级名）；查不到叫「未分类」，和饼图一个口径 */
function catName(t: Transaction, byId: Map<string, Category>): string {
  const c = t.category_id ? byId.get(t.category_id) : undefined
  return c ? c.name : UNCATEGORIZED_NAME
}

/**
 * 最大几笔那几格的标签：「9/1 房租」，有备注再带上「 · 备注」。
 * 只写分类的话，每月 1 号交一次房租，五格里三格一模一样的「房租 ¥3,500.00」，分不出是哪三个月。
 */
export function topLabel(t: Transaction, byId: Map<string, Category>): string {
  const note = t.note?.trim()
  return `${+t.date.slice(5, 7)}/${+t.date.slice(8, 10)} ${catName(t, byId)}${note ? ` · ${note}` : ''}`
}

/**
 * 格子里的金额：过万写「¥1.23万」。一行三格，375 宽的手机上一格只有 80 px 左右，
 * 「¥12,345.67」要被截成「¥12,34…」——截掉的正好是最要紧的那几位。
 */
export function topAmount(cents: number): string {
  return cents >= 1_000_000 ? `¥${(Math.round(cents / 10_000) / 100).toFixed(2)}万` : `¥${fmtYuan(cents)}`
}

export function histogram(input: MoreInput): MoreChart {
  const h = histogramOf(input.txs, input.start, input.end)
  const base = {
    key: 'histogram',
    title: '单笔多大',
    span: rangeSpan(input.start, input.end, input.today),
    note: '这段时间每一笔支出按金额（元）分档，柱子上是笔数；正好 20 元算「20–50」，以此类推。下面几格是最大的几笔，点一下看那天的流水。',
  }
  const n = h.count.reduce((s, v) => s + v, 0)
  if (n === 0) return { ...base, option: null, empty: '这段时间没有支出' }

  const byId = new Map(input.cats.map((c) => [c.id, c]))
  // cat=all：流水页收到 cat 才会重设筛选，不带的话上次留下的分类筛选会把这一笔筛掉
  const tiles: MoreTile[] = h.top.map((t) => ({ label: topLabel(t, byId), value: topAmount(t.amount), go: `ym=${monthOf(t.date)}&date=${t.date}&cat=all` }))

  return {
    ...base,
    tiles,
    option: {
      color: [CHART.expense],
      tooltip: {
        trigger: 'axis',
        confine: true,
        axisPointer: { type: 'shadow' },
        formatter: (ps: { dataIndex: number }[]) => {
          const i = ps[0]?.dataIndex ?? 0
          const head = `${BUCKETS[i].label} 元`
          return h.count[i] ? `${head}<br/>${h.count[i]} 笔 · 合计 ¥${fmtYuan(h.cents[i])}` : `${head}<br/>没有`
        },
      },
      grid: { left: 4, right: 8, top: 22, bottom: 0, containLabel: true },
      xAxis: {
        type: 'category',
        data: BUCKETS.map((b) => b.label),
        axisTick: { show: false },
        axisLine: { lineStyle: { color: CHART.axis } },
        axisLabel: { fontSize: 10, color: CHART.label, interval: 0 },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        splitLine: { lineStyle: { color: CHART.axis } },
        axisLabel: { fontSize: 10, color: CHART.label },
      },
      series: [
        {
          name: '笔数',
          type: 'bar',
          barMaxWidth: 28,
          itemStyle: { borderRadius: [4, 4, 0, 0] },
          label: {
            show: true,
            position: 'top',
            fontSize: 10,
            color: CHART.label,
            // 0 笔的柱子不标：贴着横轴写一排 0 只是噪音
            formatter: (p: { value: number }) => (p.value ? `${p.value} 笔` : ''),
          },
          data: [...h.count],
        },
      ],
    },
  }
}
