// 用电记录页的两张图（ECharts option）。纯函数，颜色只走 palette.CHART。
import { fmtKwh, peakHours, type DayUsage, type HourSlot } from './meter'
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

/**
 * 一天里几点最费电：24 根柱子，0 点到 23 点各一根，高度 = 这个钟点平均每小时几度（hourProfile）。
 * 明显最高的几根（peakHours，最多三根）用深色，其余浅一点；都差不多高时一根都不标。没被读数盖到的钟点空着。
 */
export function hourOption(slots: HourSlot[]) {
  const top = new Set(peakHours(slots))
  return {
    animationDuration: 500,
    grid: { left: 4, right: 8, top: 22, bottom: 0, containLabel: true },
    tooltip: {
      trigger: 'axis',
      confine: true,
      axisPointer: { type: 'shadow' },
      formatter: (ps: { dataIndex: number }[]) => {
        const x = slots[ps[0]?.dataIndex ?? 0]
        if (!x) return ''
        const head = `${x.hour}:00–${x.hour + 1}:00`
        if (x.perHour === null) return `${head}<br/>还没有读数盖到这个钟点`
        return `${head}<br/><b>平均每小时 ${(x.perHour / 100).toFixed(2)} 度</b><br/><span style="opacity:.7">按 ${x.days.toFixed(1)} 天的读数平均</span>`
      },
    },
    xAxis: { type: 'category', data: slots.map((x) => String(x.hour)), ...AXIS, axisLabel: { ...AXIS.axisLabel, interval: (i: number) => i % 3 === 0 } },
    yAxis: { type: 'value', name: '度/时', nameTextStyle: { color: CHART.label, fontSize: 10, align: 'right' }, axisLabel: { color: CHART.label, fontSize: 10 }, splitLine: SPLIT },
    series: [
      {
        name: '平均每小时用电',
        type: 'bar',
        barMaxWidth: 10,
        data: slots.map((x) => ({
          value: x.perHour === null ? null : Math.round(x.perHour) / 100,
          itemStyle: { color: CHART.balance, opacity: top.has(x.hour) ? 1 : 0.45, borderRadius: [3, 3, 0, 0] },
        })),
      },
    ],
  }
}
