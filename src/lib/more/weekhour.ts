// 进阶统计 ·「什么时候最爱花钱」：星期几 × 时段 的支出热力图。
//
// 时刻只能从 created_at（录入时刻，UTC 的 ISO 串）来——流水本身只有日期没有时刻。
// 所以只收「当天记的」那些：created_at 换成北京时间后的日期 = 这笔的 date。
// 9 月 1 日的账 9 月 5 日才补记，录入时刻是 9/5 某个钟点，拿来当「9/1 几点花的」是瞎说。
import { fmtYuan } from '../money'
import { CHART } from '../palette'
import type { Transaction } from '../../types'
import { rangeSpan } from './span'
import type { MoreChart, MoreInput } from './types'

/** 横轴：周一在最左，周日在最右（中国人的一周从周一开始） */
export const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'] as const

/**
 * 纵轴四个时段。小时是北京时间的整点小时（10 点 59 分还算「早」）。
 * 「夜」是其余所有钟点：22 点到次日 5 点，**也包括下午 15、16 点**——这是定下来的四档口径，
 * 下午那两个钟点不单开一格。
 */
export const SLOTS = [
  { name: '早', hours: '6–10 点' },
  { name: '中', hours: '11–14 点' },
  { name: '晚', hours: '17–21 点' },
  { name: '夜', hours: '其余时间' },
] as const

export function slotOf(hour: number): number {
  if (hour >= 6 && hour <= 10) return 0
  if (hour >= 11 && hour <= 14) return 1
  if (hour >= 17 && hour <= 21) return 2
  return 3
}

const pad = (n: number) => String(n).padStart(2, '0')
/** 北京时间比 UTC 快 8 小时，1991 年以后没有夏令时，所以直接加 8 小时是精确的 */
const BJ_OFFSET_MS = 8 * 3600_000

/**
 * ISO 时刻 → 北京时间的日期和小时。解析不出来（空串、坏数据）返回 null。
 *
 * 没直接用 date.ts 的 fmtIsoTimeZh：它每调一次新建一个 Intl.DateTimeFormat，一年几千笔在手机上要慢一截。
 * 这里加 8 小时再取 UTC 分量，和 date.ts 的 today() / fmtIsoTimeZh 逐点对账过（weekhour.test.ts 的随机不变量），
 * 和跑测试的机器在哪个时区无关。
 */
export function bjDateHour(iso: string): { date: string; hour: number } | null {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return null
  const d = new Date(ms + BJ_OFFSET_MS)
  return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, hour: d.getUTCHours() }
}

/** YYYY-MM-DD → 0 = 周一 … 6 = 周日 */
export function weekdayIdx(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number)
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
}

export interface WeekHourGrid {
  /** cents[星期][时段]，分 */
  cents: number[][]
  /** count[星期][时段]，笔数 */
  count: number[][]
  /** 进了格子的支出合计（分） */
  total: number
  /** 范围内的支出里，因为是补记（录入日 ≠ 记账日）而没进格子的合计（分） */
  skipped: number
}

/** 范围内的支出按「星期几 × 时段」分格。只收当天记的；transfer / adjust / 收入一律不看 */
export function weekHourGrid(txs: Transaction[], start: string, end: string): WeekHourGrid {
  const cents = WEEKDAYS.map(() => SLOTS.map(() => 0))
  const count = WEEKDAYS.map(() => SLOTS.map(() => 0))
  let total = 0
  let skipped = 0
  for (const t of txs) {
    if (t.type !== 'expense' || t.date < start || t.date > end) continue
    const at = bjDateHour(t.created_at)
    if (!at || at.date !== t.date) {
      skipped += t.amount
      continue
    }
    const w = weekdayIdx(t.date)
    const s = slotOf(at.hour)
    cents[w][s] += t.amount
    count[w][s] += 1
    total += t.amount
  }
  return { cents, count, total, skipped }
}

export function weekhour(input: MoreInput): MoreChart {
  const g = weekHourGrid(input.txs, input.start, input.end)
  const base = {
    key: 'weekhour',
    title: '什么时候最爱花钱',
    span: rangeSpan(input.start, input.end, input.today),
    note: '只算当天记的支出（补记的看不出几点花的），按北京时间：早 6–10 点、中 11–14 点、晚 17–21 点，其余钟点算夜。',
    height: 240,
  }
  const hasAny = g.count.some((row) => row.some((n) => n > 0))
  if (!hasAny) return { ...base, option: null, empty: '这段时间没有当天记的支出' }

  // 格子值用「元」喂给 visualMap（刻度和提示都按元读），精确的分留在闭包里给提示框用
  const data: [number, number, number][] = []
  let maxYuan = 0
  for (let w = 0; w < WEEKDAYS.length; w++) {
    for (let s = 0; s < SLOTS.length; s++) {
      const v = g.cents[w][s] / 100
      if (v > maxYuan) maxYuan = v
      data.push([w, s, v])
    }
  }
  const axis = {
    type: 'category',
    splitArea: { show: false },
    axisTick: { show: false },
    axisLine: { show: false },
    axisLabel: { fontSize: 11, color: CHART.label },
  }

  return {
    ...base,
    option: {
      tooltip: {
        confine: true,
        formatter: (p: { value: [number, number, number] }) => {
          const [w, s] = p.value
          const n = g.count[w][s]
          const head = `周${WEEKDAYS[w]} ${SLOTS[s].name}（${SLOTS[s].hours}）`
          return n ? `${head}<br/>¥${fmtYuan(g.cents[w][s])} · ${n} 笔` : `${head}<br/>没花钱`
        },
      },
      grid: { left: 4, right: 8, top: 6, bottom: 44, containLabel: true },
      xAxis: { ...axis, data: [...WEEKDAYS] },
      // inverse：「早」在最上面，从上往下读就是一天的顺序
      yAxis: { ...axis, data: SLOTS.map((s) => s.name), inverse: true },
      visualMap: {
        type: 'continuous',
        min: 0,
        // 全是 0 元的格子也得有个量程，否则 visualMap 除以零
        max: Math.max(maxYuan, 0.01),
        calculable: false,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
        itemWidth: 10,
        itemHeight: 140,
        text: ['多', '少'],
        textStyle: { fontSize: 10, color: CHART.label },
        inRange: { color: [CHART.axis, CHART.expense] },
      },
      series: [
        {
          type: 'heatmap',
          data,
          label: { show: false },
          itemStyle: { borderColor: CHART.gap, borderWidth: 2, borderRadius: 4 },
          emphasis: { itemStyle: { borderColor: CHART.label } },
        },
      ],
    },
  }
}
