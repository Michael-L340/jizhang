// 用电记录页的几张图（ECharts option）。纯函数，颜色只走 palette.CHART。
import { AVG_DAYS, fmtKwh, peakHours, peakWeekdays, WEEKDAY_NAMES, type DayUsage, type HourSlot, type UsageBucket, type WeekdaySlot } from './meter'
import { esc } from './more/html'
import { CHART } from './palette'

const AXIS = { axisLine: { lineStyle: { color: CHART.axis } }, axisTick: { show: false }, axisLabel: { color: CHART.label, fontSize: 10 } }
const SPLIT = { lineStyle: { color: CHART.axis } }

/** 「9.5」：x 轴上的日期，和统计页一样不写年份以外的零 */
const md = (ymd: string) => `${Number(ymd.slice(5, 7))}.${Number(ymd.slice(8, 10))}`

/**
 * 每天用了多少度（柱子）+ 近 AVG_DAYS 天日均（虚线）。
 * 一点没被读数盖住的天画成空（第一次记之前），只盖住一部分的天（今天、刚开始记的那天）画浅色：数是对的，只是这天还没算全。
 */
export function dailyOption(days: DayUsage[], avg: number | null, avgDays = AVG_DAYS, notes: ReadonlyMap<string, string> = new Map()) {
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
        // 23.7 小时不能写成「只算了 24 小时（还没盖满）」，不到 1 小时也别写「0 小时」
        const hrs = Math.floor(d.coveredHours)
        const part = d.coveredHours < 24 - 1e-9 ? `<br/><span style="opacity:.7">只算了${hrs < 1 ? '不到 1 ' : ` ${hrs} `}小时（读数还没盖满这一天）</span>` : ''
        const line = avg === null ? '' : `<br/><span style="opacity:.7">近 ${avgDays} 天日均 ${fmtKwh(avg)} 度</span>`
        const note = notes.get(d.date)
        // 备注是用户自己写的字，进提示框（HTML）前一律 esc
        const tail = note ? `<br/>备注：${esc(note)}<br/>${HINT('再点一下改备注')}` : `<br/>${HINT('再点一下写备注')}`
        return `${head}<br/><b>${fmtKwh(d.used)} 度</b>${part}${line}${tail}`
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
        // 写了备注的那天柱顶一个小点
        label: { show: true, position: 'top', distance: 2, fontSize: 8, color: CHART.brandInk, formatter: (p: { dataIndex: number }) => (notes.has(days[p.dataIndex]?.date ?? '') ? '●' : '') },
      },
      ...(avg === null
        ? []
        : [
            {
              name: `近${avgDays}天日均`,
              type: 'line',
              data: days.map(() => Math.round(avg) / 100),
              showSymbol: false,
              silent: true,
              // 不在线头写字：手机上它总压在最右边那几根柱子上。日均是多少，顶上大数字底下写着、提示框里也有
              lineStyle: { color: CHART.brandInk, type: 'dashed', width: 1.5 },
            },
          ]),
    ],
  }
}

/** 提示框最底下那行灰色小字 */
const HINT = (s: string) => `<span style="opacity:.55;font-size:11px">${s}</span>`

/**
 * 每天用了多少度的「周」「月」两档：一根柱子 = 一周（周一到周日）/ 一个月，没记满的浅色；
 * 虚线是记满了的那几段的平均（周均 / 月均）。提示框列出这段时间里的备注（备注只在「日」里写）。
 */
export function bucketOption(bs: UsageBucket[], unit: 'week' | 'month', avg: number | null, notes: ReadonlyMap<string, string> = new Map()) {
  const label = (b: UsageBucket) => (unit === 'week' ? md(b.from) : `${Number(b.from.slice(5, 7))}月`)
  const title = (b: UsageBucket) => (unit === 'week' ? `${md(b.from)}–${md(b.to)}` : `${Number(b.from.slice(0, 4))}年${Number(b.from.slice(5, 7))}月`)
  const avgName = unit === 'week' ? '周均' : '月均'
  return {
    animationDuration: 500,
    grid: { left: 4, right: 8, top: 22, bottom: 0, containLabel: true },
    tooltip: {
      trigger: 'axis',
      confine: true,
      axisPointer: { type: 'shadow' },
      formatter: (ps: { dataIndex: number }[]) => {
        const b = bs[ps[0]?.dataIndex ?? 0]
        if (!b) return ''
        if (b.coveredHours === 0) return `${title(b)}<br/>这段没有读数`
        const perDay = b.used / (b.coveredHours / 24)
        const part = b.coveredHours < b.spanHours - 1e-6 ? `<br/><span style="opacity:.7">还没记满</span>` : ''
        const ns = b.days.filter((d) => notes.has(d)).map((d) => `<br/>${md(d)} ${esc(notes.get(d) ?? '')}`)
        const avgLine = avg === null ? '' : `<br/><span style="opacity:.7">${avgName} ${fmtKwh(avg)} 度</span>`
        return `${title(b)}<br/><b>${fmtKwh(b.used)} 度</b><br/><span style="opacity:.7">日均 ${fmtKwh(perDay)} 度</span>${part}${avgLine}${ns.join('')}`
      },
    },
    xAxis: { type: 'category', data: bs.map(label), ...AXIS, axisLabel: { ...AXIS.axisLabel, hideOverlap: true } },
    yAxis: { type: 'value', name: '度', nameTextStyle: { color: CHART.label, fontSize: 10, align: 'right' }, axisLabel: { color: CHART.label, fontSize: 10 }, splitLine: SPLIT },
    series: [
      {
        name: '用电',
        type: 'bar',
        barMaxWidth: 28,
        data: bs.map((b) => ({
          value: b.coveredHours === 0 ? null : Math.round(b.used) / 100,
          itemStyle: { color: CHART.balance, opacity: b.coveredHours < b.spanHours - 1e-6 ? 0.4 : 1, borderRadius: [3, 3, 0, 0] },
        })),
        label: { show: true, position: 'top', distance: 2, fontSize: 8, color: CHART.brandInk, formatter: (p: { dataIndex: number }) => (bs[p.dataIndex]?.days.some((d) => notes.has(d)) ? '●' : '') },
      },
      ...(avg === null
        ? []
        : [
            {
              name: avgName,
              type: 'line',
              data: bs.map(() => Math.round(avg) / 100),
              showSymbol: false,
              silent: true,
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
 *
 * 横轴是有记录以来的全部（since = 第一次读数），一打开只看最后 view 那一段；
 * 底下一根拖动条，两头拖着看任意一段（用户 2026-10-16 选的「乙」，「区间为什么不能是有记录以来」）。
 * 拖完日期刻度的疏密由页面在 datazoom 事件里换（rateMarks），这里给的是打开时那一段的。
 */
export function rateOption(steps: { from: number; to: number; start: number; perHour: number }[], since: number, until: number, viewFrom: number = since) {
  const pts: ([number, number] | [number, null])[] = []
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    const joined = i > 0 && steps[i - 1].to === s.from
    if (i > 0 && !joined) pts.push([s.from, null])
    // 和上一段接着的起点往右挪 1 毫秒：提示框按最近的点找段，点在一段左半边时最近的点才是这段的起点，不是上一段的终点
    pts.push([joined ? s.from + 1 : s.from, s.perHour], [s.to, s.perHour])
  }
  const dayMarks = rateMarks(since, until, Math.max(since, viewFrom), until)
  return {
    animationDuration: 500,
    grid: { left: 4, right: 10, top: 22, bottom: 40, containLabel: true },
    tooltip: {
      trigger: 'axis',
      confine: true,
      formatter: (ps: { value: [number, number | null] }[]) => {
        const t = ps[0]?.value?.[0]
        if (t === undefined) return ''
        const s = steps.find((x) => x.from <= t && t <= x.to)
        if (!s) return `${bjTime(t)}<br/>这段没有读数`
        // 写这段真正的起点（start）；「一共」也按整段算
        return `${bjTime(s.start)} – ${bjTime(s.to)}<br/><b>每小时 ${s.perHour.toFixed(2)} 度</b><br/><span style="opacity:.7">这段一共 ${((s.perHour * (s.to - s.start)) / 3600_000).toFixed(1)} 度</span>`
      },
    },
    xAxis: {
      type: 'time',
      min: since,
      max: until,
      ...AXIS,
      splitLine: { show: true, ...SPLIT },
      axisLabel: { ...AXIS.axisLabel, customValues: dayMarks, formatter: bjDay },
      axisTick: { show: false, customValues: dayMarks },
    },
    dataZoom: [
      {
        type: 'slider',
        xAxisIndex: 0,
        startValue: Math.max(since, viewFrom),
        endValue: until,
        height: 20,
        bottom: 6,
        brushSelect: false,
        // 两头的日期写在把手旁边；中间那根「整段平移」的把手手机上太容易误碰，不要
        moveHandleSize: 0,
        labelFormatter: (v: number) => bjDay(v),
        textStyle: { color: CHART.label, fontSize: 10 },
        borderColor: CHART.axis,
        fillerColor: 'rgba(47,111,237,0.10)',
        handleStyle: { color: CHART.balance, borderColor: CHART.balance },
        dataBackground: { lineStyle: { color: CHART.label, opacity: 0.4 }, areaStyle: { color: CHART.label, opacity: 0.08 } },
        selectedDataBackground: { lineStyle: { color: CHART.balance, opacity: 0.6 }, areaStyle: { color: CHART.balance, opacity: 0.12 } },
      },
      // 图上两指缩放、拖着平移
      { type: 'inside', xAxisIndex: 0 },
    ],
    // 单位在卡片副标题上（「每小时几度」）；轴名写在左上角时刻度数字窄的话会被画布切掉一截
    yAxis: { type: 'value', axisLabel: { color: CHART.label, fontSize: 10 }, splitLine: SPLIT },
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

const DAY = 86400_000
const BJ = 8 * 3600_000

/** 「什么时候最费电」标题旁的三档：打开时看最近几天 */
export const RATE_SPANS = [3, 7, 30] as const
export type RateSpan = (typeof RATE_SPANS)[number]

/** 北京时间的「10.6」 */
function bjDay(v: number): string {
  const d = new Date(v + BJ)
  return `${d.getUTCMonth() + 1}.${d.getUTCDate()}`
}

/**
 * 「什么时候最费电」横轴上的日期刻度（北京时间零点，每个刻度一条竖线）。
 * 看得越宽隔得越开：3 天每天一个，一周隔一天，再宽隔三天、一周、两周、一个月左右。
 * 隔几天按「从 1970 年起第几天」取余，不按看的起点数：拖着平移时刻度不跟着跳。
 * 刻度铺满 min..max 整条轴（拖动时那段之外的也在，只是画不到）。
 */
export function rateMarks(min: number, max: number, viewFrom: number, viewTo: number): number[] {
  const days = (viewTo - viewFrom) / DAY
  const every = days <= 4 ? 1 : days <= 8 ? 2 : days <= 16 ? 3 : days <= 40 ? 7 : days <= 100 ? 14 : 30
  const out: number[] = []
  for (let t = Math.ceil((min + BJ) / DAY) * DAY - BJ; t <= max; t += DAY) if (Math.round((t + BJ) / DAY) % every === 0) out.push(t)
  return out
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
        return `${head}<br/><b>平均每小时 ${(x.perHour / 100).toFixed(2)} 度</b><br/><span style="opacity:.7">按${x.days < 0.1 ? '不到 0.1' : ` ${x.days.toFixed(1)} `}天的读数平均</span>`
      },
    },
    xAxis: { type: 'category', data: slots.map((x) => String(x.hour)), ...AXIS, axisLabel: { ...AXIS.axisLabel, interval: (i: number) => i % 3 === 0 } },
    // 单位在卡片副标题上（「每小时几度」）；轴名写在左上角时刻度数字窄的话会被画布切掉一截
    yAxis: { type: 'value', axisLabel: { color: CHART.label, fontSize: 10 }, splitLine: SPLIT },
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

/**
 * 一周里哪天最费电：7 根柱子，周一到周日，高度 = 这个星期几平均每天几度（weekdayProfile）。
 * 画法和「一天里几点最费电」一样：明显最高的那一两根（peakWeekdays）深色，其余浅一点；七天差不多时一根都不标。
 * 一个记满的整天都没有的星期几空着。用户 2026-10-08 先要「多花哨就多花哨」又改口「其他花哨也不用了」，别加 emoji、渐变、动画。
 */
export function weekdayOption(slots: WeekdaySlot[]) {
  const top = new Set(peakWeekdays(slots))
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
        const name = WEEKDAY_NAMES[x.dow - 1]
        if (x.perDay === null) return `${name}<br/>还没有记满一整天的${name}`
        return `${name}<br/><b>平均每天 ${fmtKwh(x.perDay)} 度</b><br/><span style="opacity:.7">按 ${x.days} 个${name}平均</span>`
      },
    },
    xAxis: { type: 'category', data: slots.map((x) => WEEKDAY_NAMES[x.dow - 1]), ...AXIS, axisLabel: { ...AXIS.axisLabel, interval: 0 } },
    yAxis: { type: 'value', axisLabel: { color: CHART.label, fontSize: 10 }, splitLine: SPLIT },
    series: [
      {
        name: '平均每天用电',
        type: 'bar',
        barMaxWidth: 18,
        data: slots.map((x) => ({
          value: x.perDay === null ? null : Math.round(x.perDay) / 100,
          itemStyle: { color: CHART.balance, opacity: top.has(x.dow) ? 1 : 0.45, borderRadius: [3, 3, 0, 0] },
        })),
      },
    ],
  }
}
