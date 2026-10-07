// 用电记录页的几张图（ECharts option）。纯函数，颜色只走 palette.CHART。
import { fmtKwh, peakHours, peakWeekdays, thriftWeekday, WEEKDAY_NAMES, weekdayMean, type DayUsage, type HourSlot, type WeekdaySlot } from './meter'
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

/** 调色板里的色值加个透明度（渐变的浅端、柱子的影子），不用另写一个色值 */
const alpha = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`
}
/** 从上到下由深到浅的竖向渐变 */
const fade = (hex: string, bottom = 0.35) => ({ type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: hex }, { offset: 1, color: alpha(hex, bottom) }] })

/**
 * 一周里哪天最费电：7 根柱子，周一到周日，高度 = 这个星期几平均每天几度（weekdayProfile）。
 * 用户 2026-10-08 要「多花哨就多花哨」：柱子是渐变的、一根根弹起来（elasticOut，错开 70ms），每根顶上写度数，
 * 最费电的那一两根（peakWeekdays）换成焦糖色、带 🔥 和影子，最省电的那根（thriftWeekday）带 🌿，
 * 周六日的标签是焦糖色，再加一条七天平均的虚线。七天差不多时一根都不标。一个记满的整天都没有的星期几空着。
 */
export function weekdayOption(slots: WeekdaySlot[]) {
  const top = new Set(peakWeekdays(slots))
  const thrift = thriftWeekday(slots)
  const mean = weekdayMean(slots)
  const rich = {
    fire: { fontSize: 13, lineHeight: 16, align: 'center' },
    leaf: { fontSize: 12, lineHeight: 15, align: 'center' },
    // 数字垫一块白底：平均虚线正好从柱顶穿过时，字不会和虚线叠成一团
    hot: { fontSize: 11, fontWeight: 'bold', color: CHART.brandInk, lineHeight: 14, align: 'center', backgroundColor: CHART.gap, padding: [1, 3], borderRadius: 3 },
    v: { fontSize: 10, color: CHART.label, lineHeight: 13, align: 'center', backgroundColor: CHART.gap, padding: [1, 3], borderRadius: 3 },
  }
  return {
    animationDuration: 800,
    animationEasing: 'elasticOut' as const,
    grid: { left: 4, right: 8, top: 34, bottom: 0, containLabel: true },
    tooltip: {
      trigger: 'axis',
      confine: true,
      axisPointer: { type: 'shadow' },
      formatter: (ps: { dataIndex: number }[]) => {
        const x = slots[ps[0]?.dataIndex ?? 0]
        if (!x) return ''
        const name = WEEKDAY_NAMES[x.dow - 1]
        if (x.perDay === null) return `${name}<br/>还没有记满一整天的${name}`
        const tag = top.has(x.dow) ? ' 🔥 最费电' : x.dow === thrift ? ' 🌿 最省电' : ''
        const vs = mean === null || mean <= 0 ? '' : `<br/>比七天平均${x.perDay >= mean ? '多' : '少'} ${Math.round(Math.abs(x.perDay / mean - 1) * 100)}%`
        return `${name}${tag}<br/><b>平均每天 ${fmtKwh(x.perDay)} 度</b>${vs}<br/><span style="opacity:.7">按 ${x.days} 个${name}平均</span>`
      },
    },
    xAxis: {
      type: 'category',
      data: slots.map((x) => WEEKDAY_NAMES[x.dow - 1]),
      ...AXIS,
      axisLabel: {
        ...AXIS.axisLabel,
        interval: 0,
        formatter: (v: string) => (v === '周六' || v === '周日' ? `{wk|${v}}` : v),
        rich: { wk: { color: CHART.brandInk, fontWeight: 'bold', fontSize: 10 } },
      },
    },
    yAxis: {
      type: 'value',
      name: '度/天',
      nameTextStyle: { color: CHART.label, fontSize: 10, align: 'right' },
      axisLabel: { color: CHART.label, fontSize: 10 },
      splitLine: SPLIT,
      // 顶上要放 🔥 和度数，留两成空
      max: (v: { max: number }) => Math.ceil(Math.max(1, v.max * 1.22) * 10) / 10,
    },
    series: [
      {
        name: '平均每天用电',
        type: 'bar',
        barMaxWidth: 22,
        showBackground: true,
        backgroundStyle: { color: alpha(CHART.axis, 0.55), borderRadius: [6, 6, 6, 6] },
        animationDelay: (i: number) => i * 70,
        data: slots.map((x) => {
          const hot = top.has(x.dow)
          const leaf = x.dow === thrift
          const hex = hot ? CHART.brandInk : CHART.balance
          const num = x.perDay === null ? '' : fmtKwh(x.perDay)
          return {
            value: x.perDay === null ? null : Math.round(x.perDay) / 100,
            itemStyle: {
              color: fade(hex),
              borderRadius: [6, 6, 2, 2],
              ...(hot ? { shadowBlur: 8, shadowColor: alpha(hex, 0.35), shadowOffsetY: 3 } : {}),
            },
            label: {
              show: x.perDay !== null,
              position: 'top',
              distance: 3,
              formatter: hot ? `{fire|🔥}\n{hot|${num}}` : leaf ? `{leaf|🌿}\n{v|${num}}` : `{v|${num}}`,
              rich,
            },
          }
        }),
        ...(mean === null
          ? {}
          : {
              markLine: {
                silent: true,
                symbol: 'none',
                animation: false,
                data: [{ yAxis: Math.round(mean) / 100 }],
                lineStyle: { type: 'dashed', color: CHART.brandInk, width: 1, opacity: 0.7 },
                label: { show: false },
              },
            }),
      },
    ],
  }
}
