// 用电记录页的两张图（ECharts option）。纯函数，颜色只走 palette.CHART。
import { fmtKwh, type DayUsage } from './meter'
import { CHART } from './palette'

const AXIS = { axisLine: { lineStyle: { color: CHART.axis } }, axisTick: { show: false }, axisLabel: { color: CHART.label, fontSize: 10 } }
const SPLIT = { lineStyle: { color: CHART.axis } }

/** 「9.5」：x 轴上的日期，和统计页一样不写年份以外的零 */
const md = (ymd: string) => `${Number(ymd.slice(5, 7))}.${Number(ymd.slice(8, 10))}`

/**
 * 每天用了多少度（柱子）+ 近 7 天日均（虚线）。
 * 一点没被读数盖住的天画成空（第一次记之前），只盖住一部分的天（今天、刚开始记的那天）画浅色：数是对的，只是这天还没算全。
 */
export function dailyOption(days: DayUsage[], avg7: number | null) {
  const n = days.length
  const every = Math.max(1, Math.ceil(n / 6))
  return {
    animationDuration: 500,
    grid: { left: 4, right: 8, top: 22, bottom: 0, containLabel: true },
    tooltip: {
      trigger: 'axis',
      confine: true,
      axisPointer: { type: 'shadow' },
      formatter: (ps: { dataIndex: number }[]) => {
        const d = days[ps[0]?.dataIndex ?? 0]
        if (!d) return ''
        const head = `${Number(d.date.slice(5, 7))}月${Number(d.date.slice(8, 10))}日`
        if (d.coveredHours === 0) return `${head}<br/>这天没有读数`
        const part = d.coveredHours < 24 - 1e-9 ? `<br/><span style="opacity:.7">只算了 ${Math.round(d.coveredHours)} 小时（读数还没盖满这一天）</span>` : ''
        const avg = avg7 === null ? '' : `<br/><span style="opacity:.7">近 7 天日均 ${fmtKwh(avg7)} 度</span>`
        return `${head}<br/><b>${fmtKwh(d.used)} 度</b>${part}${avg}`
      },
    },
    xAxis: { type: 'category', data: days.map((d) => md(d.date)), ...AXIS, axisLabel: { ...AXIS.axisLabel, interval: (i: number) => (n - 1 - i) % every === 0 } },
    yAxis: { type: 'value', name: '度', nameTextStyle: { color: CHART.label, fontSize: 10, align: 'right' }, axisLabel: { color: CHART.label, fontSize: 10 }, splitLine: SPLIT },
    series: [
      {
        name: '用电',
        type: 'bar',
        barMaxWidth: 14,
        data: days.map((d) => ({
          value: d.coveredHours === 0 ? null : Math.round(d.used) / 100,
          itemStyle: { color: CHART.balance, opacity: d.coveredHours < 24 - 1e-9 ? 0.4 : 1, borderRadius: [3, 3, 0, 0] },
        })),
      },
      ...(avg7 === null
        ? []
        : [
            {
              name: '近7天日均',
              type: 'line',
              data: days.map(() => Math.round(avg7) / 100),
              showSymbol: false,
              silent: true,
              // 不在线头写字：手机上它总压在最右边那几根柱子上。日均是多少，顶上大数字底下写着、提示框里也有
              lineStyle: { color: CHART.brandInk, type: 'dashed', width: 1.5 },
            },
          ]),
    ],
  }
}

/** 北京时间「10/3 21:40」 */
const bjTime = (ms: number) => {
  const d = new Date(ms + 8 * 3600_000)
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

/**
 * 什么时候最费电：每一段读数的平均速度画成台阶（这段时间里每小时几度）。
 * 两段之间断开（中间有一段读数倒退被跳过了）就断开画，不连成一条斜线。
 */
export function rateOption(steps: { from: number; to: number; perHour: number }[], since: number, until: number) {
  const pts: ([number, number] | [number, null])[] = []
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    if (i > 0 && steps[i - 1].to !== s.from) pts.push([s.from, null])
    pts.push([s.from, s.perHour], [s.to, s.perHour])
  }
  const dayMarks: number[] = []
  // 每天零点（北京时间）一条竖的分隔线：用 x 轴的刻度来画
  for (let t = Math.ceil((since + 8 * 3600_000) / 86400_000) * 86400_000 - 8 * 3600_000; t <= until; t += 86400_000) dayMarks.push(t)
  return {
    animationDuration: 500,
    grid: { left: 4, right: 10, top: 22, bottom: 0, containLabel: true },
    tooltip: {
      trigger: 'axis',
      confine: true,
      formatter: (ps: { value: [number, number | null] }[]) => {
        const t = ps[0]?.value?.[0]
        if (t === undefined) return ''
        const s = steps.find((x) => x.from <= t && t <= x.to)
        if (!s) return `${bjTime(t)}<br/>这段没有读数`
        return `${bjTime(s.from)} – ${bjTime(s.to)}<br/><b>每小时 ${s.perHour.toFixed(2)} 度</b><br/><span style="opacity:.7">这段一共 ${((s.perHour * (s.to - s.from)) / 3600_000).toFixed(1)} 度</span>`
      },
    },
    xAxis: {
      type: 'time',
      min: since,
      max: until,
      ...AXIS,
      splitLine: { show: true, ...SPLIT },
      axisLabel: {
        ...AXIS.axisLabel,
        customValues: dayMarks,
        formatter: (v: number) => {
          const d = new Date(v + 8 * 3600_000)
          return `${d.getUTCMonth() + 1}.${d.getUTCDate()}`
        },
      },
      axisTick: { show: false, customValues: dayMarks },
    },
    yAxis: { type: 'value', name: '度/时', nameTextStyle: { color: CHART.label, fontSize: 10, align: 'right' }, axisLabel: { color: CHART.label, fontSize: 10 }, splitLine: SPLIT },
    series: [
      {
        name: '每小时用电',
        type: 'line',
        data: pts,
        showSymbol: false,
        connectNulls: false,
        lineStyle: { color: CHART.balance, width: 2 },
        itemStyle: { color: CHART.balance },
        areaStyle: { color: CHART.balance, opacity: 0.12 },
      },
    ],
  }
}
