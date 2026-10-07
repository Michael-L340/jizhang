/// <reference types="node" />
// 用电记录页的几张图：真画一遍（SSR），不报错、该空的空、颜色不写死。
import { readFileSync } from 'node:fs'
import * as echarts from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import { describe, expect, it, vi } from 'vitest'
import type { MeterReading } from '../types'
import { dailyUsage, hourProfile, parseReading, rateSteps, summarize, weekdayProfile } from './meter'
import { dailyOption, hourOption, rateOption, weekdayOption } from './meterChart'

echarts.use([BarChart, LineChart, GridComponent, TooltipComponent, SVGRenderer])

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
  it('每天用了多少度：第一次读数之前的天是空的（不是 0）；最近 7 天日均那条虚线在；画得出来', () => {
    // 变异：没被读数盖住的天也画 0 → 9/25 那根是 0 不是 null，红
    const days = dailyUsage(RS, '2026-09-25', '2026-10-03')
    const o = dailyOption(days, summarize(RS, NOW).avg7) as { series: { name: string; data: ({ value: number | null } | number)[] }[] }
    const bars = o.series[0].data as { value: number | null }[]
    expect(bars[0].value).toBeNull()
    expect(bars.at(-1)!.value).toBeGreaterThan(0)
    expect(o.series.map((s) => s.name)).toEqual(['用电', '近7天日均'])
    expect(render(o)).toContain('<svg')
  })

  it('什么时候最费电：最近 3 天的台阶画得出来（时间轴、每天零点一条刻度）', () => {
    const since = NOW.getTime() - 3 * 86400_000
    const svg = render(rateOption(rateSteps(RS, since), since, NOW.getTime()))
    expect(svg).toContain('<svg')
    for (const d of ['10.1', '10.2', '10.3']) expect(svg).toContain(`>${d}<`)
  })

  it('一天里几点最费电：24 根柱子画得出来，明显最高的几根深色、其余浅色', () => {
    // 变异：所有柱子一个深浅 → 红（这本示例账晚上明显高，peakHours 挑得出三根）
    const slots = hourProfile(RS, NOW.getTime() - 30 * 86400_000, NOW.getTime())
    const o = hourOption(slots) as { series: { data: { value: number | null; itemStyle: { opacity: number } }[] }[] }
    const d = o.series[0].data
    expect(d).toHaveLength(24)
    expect(d.filter((x) => x.itemStyle.opacity === 1)).toHaveLength(3)
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
