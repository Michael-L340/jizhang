/// <reference types="node" />
// 用电记录页的几张图：真画一遍（SSR），不报错、该空的空、颜色不写死。
import { readFileSync } from 'node:fs'
import * as echarts from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import { DataZoomInsideComponent, DataZoomSliderComponent, GridComponent, TooltipComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import { describe, expect, it, vi } from 'vitest'
import type { MeterReading } from '../types'
import { bucketAverage, dailyUsage, hourProfile, parseReading, peakHours, rateSteps, summarize, usageBuckets, weekdayProfile } from './meter'
import { bucketOption, dailyOption, hourOption, rateMarks, rateOption, rateYAxis, weekdayOption } from './meterChart'
import { CHART } from './palette'

echarts.use([BarChart, LineChart, GridComponent, TooltipComponent, DataZoomSliderComponent, DataZoomInsideComponent, SVGRenderer])

const R = (bj: string, value: string): MeterReading => {
  const iso = new Date(`${bj.replace(' ', 'T')}:00+08:00`).toISOString()
  return { id: bj, read_at: iso, centi_kwh: parseReading(value)!, created_at: iso }
}
// 9/30 晚上开始记，10/1–10/3 一天三次
const RS = [
  R('2026-09-30 21:00', '3000.0'),
  R('2026-10-01 08:00', '3004.0'),
  R('2026-10-01 19:00', '3007.5'),
  R('2026-10-01 23:30', '3011.0'),
  R('2026-10-02 08:00', '3014.0'),
  R('2026-10-02 20:00', '3018.0'),
  R('2026-10-03 07:40', '3022.6'),
  R('2026-10-03 18:05', '3027.0'),
]
const NOW = new Date('2026-10-03T21:40:00+08:00')

function render(option: object): string {
  const errors: string[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')))
  const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')))
  const c = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 311, height: 180 })
  try {
    c.setOption({ animation: false, ...option })
    return c.renderToSVGString()
  } finally {
    c.dispose()
    spy.mockRestore()
    warn.mockRestore()
    if (errors.length) expect.fail(errors.join('\n'))
  }
}

describe('用电记录的图', () => {
  it('每天用了多少度：第一次读数之前的天是空的（不是 0）；最近 14 天日均那条虚线在；画得出来', () => {
    // 变异：没被读数盖住的天也画 0 → 9/25 那根是 0 不是 null，红
    const days = dailyUsage(RS, '2026-09-25', '2026-10-03')
    const o = dailyOption(days, summarize(RS, NOW).avg) as { series: { name: string; data: ({ value: number | null } | number)[] }[] }
    const bars = o.series[0].data as { value: number | null }[]
    expect(bars[0].value).toBeNull()
    expect(bars.at(-1)!.value).toBeGreaterThan(0)
    expect(o.series.map((s) => s.name)).toEqual(['用电', '近14天日均'])
    expect((dailyOption(days, 800, 2) as { series: { name: string }[] }).series[1].name).toBe('近2天日均')
    expect(render(o)).toContain('<svg')
  })

  it('什么时候最费电：最近 3 天的台阶画得出来（时间轴、每天零点一条刻度）', () => {
    const since = NOW.getTime() - 3 * 86400_000
    const svg = render(rateOption(rateSteps(RS, since), since, NOW.getTime()))
    expect(svg).toContain('<svg')
    for (const d of ['10.1', '10.2', '10.3']) expect(svg).toContain(`>${d}<`)
  })

  it('什么时候最费电：横轴是有记录以来，打开只看最后几天，底下有拖动条（用户 2026-10-16 选「乙」）', () => {
    // 变异：dataZoom 的 startValue 写成 since（打开就是全部）→ 红；xAxis 锁死 min = viewFrom（拖不回更早）→ 红
    const first = NOW.getTime() - 20 * 86400_000
    const view = NOW.getTime() - 3 * 86400_000
    const o = rateOption(rateSteps(RS, first), first, NOW.getTime(), view) as { xAxis: { min: number; max: number }; dataZoom: { type: string; startValue?: number; endValue?: number }[] }
    expect(o.xAxis.min).toBe(first)
    expect(o.dataZoom[0]).toMatchObject({ type: 'slider', startValue: view, endValue: NOW.getTime() })
    expect(o.dataZoom[1].type).toBe('inside')
    // 选的天数比记录还长：从第一次读数开始，不留一截空白
    const short = rateOption([], first, NOW.getTime(), first - 30 * 86400_000) as { dataZoom: { startValue: number }[] }
    expect(short.dataZoom[0].startValue).toBe(first)
    expect(render(o)).toContain('<svg')
  })

  it('日期刻度：看得越宽隔得越开，都在北京时间零点；拖着平移时刻度不跳', () => {
    // 变异：隔几天按看的起点数（不按 1970 年起第几天取余）→ 平移一天后刻度整体错开，红
    const D = 86400_000
    const min = Date.parse('2026-08-01T00:00:00+08:00')
    const max = Date.parse('2026-10-16T12:00:00+08:00')
    const gap = (m: number[]) => (m[1] - m[0]) / D
    expect(gap(rateMarks(min, max, max - 3 * D, max))).toBe(1)
    expect(gap(rateMarks(min, max, max - 7 * D, max))).toBe(2)
    expect(gap(rateMarks(min, max, max - 30 * D, max))).toBe(7)
    expect(gap(rateMarks(min, max, min, max))).toBe(14)
    for (const t of rateMarks(min, max, max - 30 * D, max)) expect(new Date(t + 8 * 3600_000).getUTCHours()).toBe(0)
    expect(rateMarks(min, max, max - 31 * D, max - D)).toEqual(rateMarks(min, max, max - 30 * D, max))
  })

  it('一天里几点最费电：24 根柱子画得出来，明显最高的几根深色、其余浅色', () => {
    // 变异：所有柱子一个深浅 → 红（这本示例账晚上明显高，peakHours 挑得出三根）
    const slots = hourProfile(RS, NOW.getTime() - 30 * 86400_000, NOW.getTime())
    const o = hourOption(slots) as { series: { data: { value: number | null; itemStyle: { opacity: number } }[] }[] }
    const d = o.series[0].data
    expect(d).toHaveLength(24)
    // 至少三根深色；和第三根一样高的并列一起深色（硬切成三根是误导）
    expect(d.filter((x) => x.itemStyle.opacity === 1).length).toBeGreaterThanOrEqual(3)
    expect(d.map((x, h) => (x.itemStyle.opacity === 1 ? h : -1)).filter((h) => h >= 0)).toEqual(peakHours(slots))
    const max = Math.max(...d.map((x) => x.value ?? 0))
    expect(d.find((x) => x.value === max)!.itemStyle.opacity).toBe(1)
    expect(render(o)).toContain('<svg')
  })

  it('源码不写死颜色（用电页、图）', () => {
    for (const f of ['./meterChart.ts', '../pages/Power.tsx']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8')
      expect(src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], f).toEqual([])
    }
  })
})

describe('一周里哪天最费电', () => {
  /** 9/14（周一）起每天零点记一次到 10/8，周六 12 度、别的天 8 度 */
  const RW: MeterReading[] = []
  for (let t = Date.parse('2026-09-14T00:00:00+08:00'), v = 100000, i = 0; t <= Date.parse('2026-10-08T00:00:00+08:00'); t += 86400_000, i++) {
    const ymd = new Date(t + 8 * 3600_000).toISOString().slice(0, 10)
    RW.push(R(`${ymd} 00:00`, (v / 100).toFixed(2)))
    v += i % 7 === 5 ? 1200 : 800
  }

  type Opt = { xAxis: { data: string[] }; series: { data: { value: number | null; itemStyle: { opacity: number } }[] }[] }

  it('7 根柱子周一到周日都标出来，周六那根深色、其余浅色（和「几点最费电」一个画法，不带 emoji / 渐变）；画得出来', () => {
    // 变异：所有柱子一个深浅 → 红；周几标签不全（interval 没设 0）→ 画出来缺「周二」，红
    const o = weekdayOption(weekdayProfile(RW, '2026-10-08')) as Opt
    expect(o.xAxis.data).toEqual(['周一', '周二', '周三', '周四', '周五', '周六', '周日'])
    const d = o.series[0].data
    expect(d).toHaveLength(7)
    expect(d.map((x) => x.value)).toEqual([8, 8, 8, 8, 8, 12, 8])
    expect(d.map((x) => x.itemStyle.opacity)).toEqual([0.45, 0.45, 0.45, 0.45, 0.45, 1, 0.45])
    const svg = render(o)
    expect(svg).toContain('<svg')
    for (const w of ['周一', '周二', '周三', '周四', '周五', '周六', '周日']) expect(svg).toContain(`>${w}<`)
    expect(svg).not.toMatch(/🔥|🌿|linearGradient/)
  })

  it('一个记满的整天都没有的星期几空着（不是 0）', () => {
    // 变异：没数画 0 → 红
    const o = weekdayOption(weekdayProfile(RW.slice(0, 3), '2026-10-08')) as Opt
    expect(o.series[0].data.map((x) => x.value)).toEqual([8, 8, null, null, null, null, null])
    expect(render(o)).toContain('<svg')
  })

  it('用电页卡片的顺序是用户定的（2026-10-08）：每天用了多少度 → 一周里哪天最费电 → 什么时候最费电 → 一天里几点最费电 → 最近的读数', () => {
    const src = readFileSync(new URL('../pages/Power.tsx', import.meta.url), 'utf8')
    const titles = ['每天用了多少度', '一周里哪天最费电', '什么时候最费电', '一天里几点最费电', '最近的读数']
    const idx = titles.map((t) => src.indexOf(`<span className="font-semibold">${t}</span>`))
    for (let i = 0; i < titles.length; i++) if (idx[i] < 0) expect.fail(`找不到「${titles[i]}」这张卡`)
    for (let i = 1; i < titles.length; i++) if (idx[i] < idx[i - 1]) expect.fail(`「${titles[i]}」排在「${titles[i - 1]}」前面了`)
  })
})

describe('提示框的措辞和找段', () => {
  it('每天用了多少度：盖了 23.7 小时写「只算了 23 小时」不写 24；不到 1 小时写「不到 1 小时」', () => {
    // 变异：改回 Math.round → 「只算了 24 小时（还没盖满）」自相矛盾，红
    const days = dailyUsage([R('2026-10-01 00:20', '3000.0'), R('2026-10-02 00:10', '3010.0')], '2026-10-01', '2026-10-02')
    const o = dailyOption(days, null) as { tooltip: { formatter: (ps: { dataIndex: number }[]) => string } }
    expect(o.tooltip.formatter([{ dataIndex: 0 }])).toContain('只算了 23 小时')
    expect(o.tooltip.formatter([{ dataIndex: 1 }])).toContain('只算了不到 1 小时')
  })

  it('每天用了多少度：提示框第一行带周几，和首页「今日开支 · 10月25日 周日」同一个写法（用户 2026-10-25）', () => {
    // 变异：head 改回只写「10月12日」→ 红
    const days = dailyUsage([R('2026-10-10 20:00', '3000.0'), R('2026-10-12 20:00', '3008.0')], '2026-10-09', '2026-10-12')
    const o = dailyOption(days, null) as { tooltip: { formatter: (ps: { dataIndex: number }[]) => string } }
    const tip = (date: string) => o.tooltip.formatter([{ dataIndex: days.findIndex((d) => d.date === date) }])
    expect(tip('2026-10-11')).toMatch(/^10月11日 周日<br\/>/)
    expect(tip('2026-10-12')).toMatch(/^10月12日 周一<br\/>/)
    // 一点读数都没有的那天也带
    expect(tip('2026-10-09')).toBe('10月9日 周五<br/>这天没有读数')
  })

  it('什么时候最费电：同一个数 15 秒内存了两次，台阶照样连着画（不插断点）；读数倒退跳过的那段才断开（用户 2026-10-25）', () => {
    // 变异：rateSteps 改回各画各的 → 这里多出一个 null，台阶少一条竖线，红
    const twice = [R('2026-10-25 15:48', '3261.54'), R('2026-10-25 17:54', '3262.22'), R('2026-10-25 17:55', '3262.22'), R('2026-10-25 20:47', '3262.96')]
    twice[1].read_at = '2026-10-25T09:54:54.580Z'
    twice[2].read_at = '2026-10-25T09:55:09.915Z'
    type Pts = { series: { data: [number, number | null][] }[] }
    const pts = (rs: MeterReading[]) => (rateOption(rateSteps(rs, 0), 0, Date.parse('2026-10-26T00:00:00+08:00')) as Pts).series[0].data
    expect(pts(twice).some((p) => p[1] === null)).toBe(false)
    const swapped = [R('2026-10-05 08:00', '3000.0'), R('2026-10-05 20:00', '3006.0'), R('2026-10-06 08:00', '12.0'), R('2026-10-06 20:00', '18.0')]
    expect(pts(swapped).filter((p) => p[1] === null)).toHaveLength(1)
  })

  it('什么时候最费电：接着的两段，第二段起点往右挪 1 毫秒，提示框在第二段左半边找到的是第二段；写的是整段的起点和总量', () => {
    // 变异：不挪 → 两段共用一个 x，find 先命中上一段，红
    const rs = [R('2026-10-05 20:00', '3000.0'), R('2026-10-06 08:00', '3006.0'), R('2026-10-06 20:00', '3012.0')]
    const since = Date.parse('2026-10-06T00:00:00+08:00')
    const steps = rateSteps(rs, since)
    const o = rateOption(steps, since, Date.parse('2026-10-07T00:00:00+08:00')) as { series: { data: [number, number | null][] }[]; tooltip: { formatter: (ps: { value: [number, number | null] }[]) => string } }
    const pts = o.series[0].data
    expect(pts[2][0]).toBe(steps[1].from + 1)
    const tip = o.tooltip.formatter([{ value: pts[2] }])
    expect(tip).toContain('10/6 08:00 – 10/6 20:00')
    expect(tip).toContain('一共 6.0 度')
    // 第一段被 since 截了起点，提示框仍写真正的起点 10/5 20:00、一共 6.0 度
    expect(o.tooltip.formatter([{ value: pts[0] }])).toContain('10/5 20:00 – 10/6 08:00')
    expect(o.tooltip.formatter([{ value: pts[0] }])).toContain('一共 6.0 度')
  })
})

describe('什么时候最费电：放大、拖动之后，跨在可见范围边上的那段也画（2026-10-25）', () => {
  // 10/22 晚上一段尖峰（每小时 0.73，在窗口外）；10/24 12:00–19:00 每小时 0.24（跨在窗口左边上）；10/24 19:00 – 10/25 17:00 每小时 0.32
  const rs = [R('2026-10-22 18:00', '3000.00'), R('2026-10-22 22:00', '3002.92'), R('2026-10-24 12:00', '3004.00'), R('2026-10-24 19:00', '3005.68'), R('2026-10-25 17:00', '3012.72')]
  const first = Date.parse(rs[0].read_at)
  const view = Date.parse('2026-10-24T15:00:00+08:00')
  const until = Date.parse('2026-10-25T18:00:00+08:00')
  const steps = rateSteps(rs, first)

  it('纵轴只看窗口里看得见的那几段：0.32 → 0–0.35 每格 0.05；看全部时尖峰 0.73 → 0–0.8 每格 0.1；窗口里没有段 → 交回 ECharts', () => {
    // 变异：rateYAxis 不看窗口、拿全部的最大值 → 放大后纵轴还是 0.8，红
    expect(rateYAxis(steps, view, until)).toEqual({ min: 0, max: 0.35, interval: 0.05 })
    expect(rateYAxis(steps, first, until)).toEqual({ min: 0, max: 0.8, interval: 0.1 })
    expect(rateYAxis(steps, first - 86400_000, first)).toEqual({ min: 0, max: null, interval: null })
  })

  it('缩放条不扔窗口外的点：跨在左边上的那段从画布外面画进来（默认的 filter 会把它整段扔掉，左边空一块）', () => {
    // 变异：去掉 filterMode: 'none' → 线从窗口里第一个点（10/24 19:00）才开始，红
    const o = rateOption(steps, first, until, view) as { dataZoom: { filterMode?: string }[]; yAxis: { max: number | null } }
    expect(o.dataZoom.map((z) => z.filterMode)).toEqual(['none', 'none'])
    expect(o.yAxis.max).toBe(0.35)
    const svg = render(o)
    const line = [...svg.matchAll(/<path d="([^"]+)"[^>]*stroke="([^"]+)"[^>]*stroke-width="2"/g)].find((m) => m[2].toLowerCase() === CHART.balance)
    expect(line).toBeDefined()
    const x0 = Number(line![1].match(/-?\d+(\.\d+)?/)![0])
    expect(x0).toBeLessThan(0)
  })

  it('拖动、两指缩放时页面把纵轴也换掉（onRateZoom 带上 rateYAxis）', () => {
    // 变异：onRateZoom 只换日期刻度 → 放大后纵轴还停在打开时那一段的高度，红
    const src = readFileSync(new URL('../pages/Power.tsx', import.meta.url), 'utf8')
    expect(src).toContain('yAxis: rateYAxis(steps, a, b)')
  })
})

describe('每天用了多少度：备注和周 / 月（2026-10-16）', () => {
  const rs = Array.from({ length: 12 }, (_, i) => R(`2026-10-${String(4 + i).padStart(2, '0')} 20:00`, (3000 + 4 * i).toFixed(1)))
  type Opt = { tooltip: { formatter: (ps: { dataIndex: number }[]) => string }; series: { label?: { formatter: (p: { dataIndex: number }) => string } }[] }

  it('日：写了备注的那天提示框里有备注、柱顶一个点；备注里的尖括号不当 HTML', () => {
    // 变异：提示框不过 esc → 「<b>」原样进去，红
    const days = dailyUsage(rs, '2026-10-05', '2026-10-09')
    const notes = new Map([['2026-10-07', '没开空调<b>']])
    const o = dailyOption(days, 400, 7, notes) as unknown as Opt
    const i = days.findIndex((d) => d.date === '2026-10-07')
    expect(o.tooltip.formatter([{ dataIndex: i }])).toContain('备注：没开空调&lt;b&gt;')
    expect(o.tooltip.formatter([{ dataIndex: i }])).toContain('再点一下改备注')
    expect(o.tooltip.formatter([{ dataIndex: 0 }])).toContain('再点一下写备注')
    expect(o.series[0].label!.formatter({ dataIndex: i })).toBe('●')
    expect(o.series[0].label!.formatter({ dataIndex: 0 })).toBe('')
    expect(render(o)).toContain('<svg')
  })

  it('周：一根一周，提示框写起止、合计、日均，列出这周的备注；没记满的浅色', () => {
    // 变异：提示框不列这周的备注 → 红
    const bs = usageBuckets(rs, 'week', '2026-10-16')
    const o = bucketOption(bs, 'week', bucketAverage(bs), new Map([['2026-10-07', '没开空调']])) as unknown as Opt & { series: { data: { itemStyle: { opacity: number } }[] }[] }
    const tip = o.tooltip.formatter([{ dataIndex: 1 }])
    expect(tip).toContain('10.5–10.11')
    expect(tip).toContain('28.0 度')
    expect(tip).toContain('日均 4.0 度')
    expect(tip).toContain('10.7 没开空调')
    expect(o.series[0].label!.formatter({ dataIndex: 1 })).toBe('●')
    expect(o.series[0].data.map((d) => d.itemStyle.opacity)).toEqual([0.4, 1, 0.4])
    expect(render(o)).toContain('<svg')
  })

  it('月：横轴写「10月」，提示框写「2026年10月」', () => {
    const bs = usageBuckets(rs, 'month', '2026-10-16')
    const o = bucketOption(bs, 'month', bucketAverage(bs)) as unknown as Opt & { xAxis: { data: string[] } }
    expect(o.xAxis.data).toEqual(['10月'])
    expect(o.tooltip.formatter([{ dataIndex: 0 }])).toContain('2026年10月')
    expect(render(o)).toContain('<svg')
  })
})

