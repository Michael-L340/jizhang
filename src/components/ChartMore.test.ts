// 进阶分析页的十张图，用 ECharts 的 SSR 在 node 里真画一遍。
//
// 守两件肉眼和纯函数测试都看不出来的事：
//   一、模块注册漏了：ECharts 只在控制台喊一句「xx is used but not imported」，生产环境连这句都没有，
//       那张卡就是一块空白。这里拿的正是 Chart.tsx + ChartMore.tsx 注册的那一套，漏一个就红。
//   二、setOption 直接抛错：储蓄率图原来用分段 visualMap，SSR 一跑就是 TypeError（2026-09-28），
//       纯函数的测试只看 option 长什么样，发现不了。
import * as echarts from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './ChartMore' // 副作用：注册 Chart.tsx 那套 + 进阶分析那几个模块
import { textWidth } from '../lib/chart'
import { monthOf } from '../lib/date'
import { calendar, MONTH_LABEL_FONT } from '../lib/more/calendar'
import { MORE_KEYS } from '../lib/more/layout'
import { MORE_CHARTS } from '../lib/more/registry'
import { sampleInput } from '../lib/more/sample'
import { LAST_LABEL_W, SANKEY_FONT, sankeyChart } from '../lib/more/sankey'
import type { MoreInput } from '../lib/more/types'
import type { Account, Category, Transaction } from '../types'

echarts.use([SVGRenderer])

/** 393 宽的手机：整页 393 − 页面和卡片的内边距 64 */
const W = 329

function render(option: object, height: number, width = W): { svg: string; errors: string[] } {
  const errors: string[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')))
  const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')))
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height })
  try {
    chart.setOption(option as echarts.EChartsCoreOption, true)
    return { svg: chart.renderToSVGString(), errors }
  } finally {
    chart.dispose()
    spy.mockRestore()
    warn.mockRestore()
  }
}

afterEach(() => vi.restoreAllMocks())

const cases: [string, MoreInput][] = [
  ['一年的账、今天 9/28、停在 9 月、近一年', sampleInput()],
  ['翻回去年 12 月、本年', sampleInput({ ym: '2025-12', start: '2025-01-01', end: '2025-12-31' })],
  ['只看本月', sampleInput({ start: '2026-09-01' })],
]

describe('十张图都画得出来：不报「没注册」、不抛错、画出来的不是一张白纸', () => {
  for (const [name, inp] of cases) {
    for (const k of MORE_KEYS) {
      it(`${name} · ${k}`, () => {
        // 变异：ChartMore.tsx 里去掉 SankeyChart → sankey 报「Series sankey is used but not imported」，红
        // 变异：去掉 VisualMapContinuousComponent → calendar、weekhour 红；去掉 CalendarComponent → calendar 红
        // 变异：去掉 MarkPointComponent → ECharts 一声不吭，只是「今天」那个点没了 → 下面单查那两个字，race 红
        //（去掉 RadarComponent 不会红：RadarChart 装的时候自己会把它装上，见 echarts/lib/chart/radar/install.js）
        const c = MORE_CHARTS[k].build(inp, { chartWidth: W, axisWidth: W - 44 })
        if (!c.option || c.empty) return // 只有数字的卡 / 空状态：没有图可画
        const { svg, errors } = render(c.option, c.height ?? 220)
        expect(errors, errors.join('\n')).toEqual([])
        // 什么都没画的 SVG 只有两百多字节（实测 233）；最简单的一张图也有好几千
        expect(svg.length).toBeGreaterThan(3000)
        // 图上不许印出内部 id。桑基图不写 label.formatter 时默认标签就是节点 id（「a:boc」「p:life」）
        // 变异：去掉 sankey.ts 的 formatter: '{b}' → 红
        expect(svg.match(/>[aps]:[^<]*</g) ?? []).toEqual([])
        if (k === 'sankey') expect(svg).toContain('>中国银行<')
        // 看的是这个月：累计线上要标出「今天」（markPoint；没注册时不报错，只是悄悄不画）
        if (k === 'race' && monthOf(inp.today) === inp.ym) expect(svg).toContain('>今天<')
      })
    }
  }
})

/** SVG 里的一段字：内容、锚点、位置（x 属性或 transform 的平移，两种写法都认） */
function texts(svg: string): { text: string; x: number; y: number; size: number; anchor: string }[] {
  return [...svg.matchAll(/<text([^>]*)>([^<]*)<\/text>/g)].map((m) => {
    const a = m[1]
    const tr = a.match(/translate\(([-\d.]+) ([-\d.]+)\)/)
    const num = (k: string) => Number(a.match(new RegExp(` ${k}="([-\\d.]+)"`))?.[1] ?? 0)
    return {
      text: m[2],
      x: (tr ? +tr[1] : 0) + num('x'),
      y: (tr ? +tr[2] : 0) + num('y'),
      size: Number(a.match(/font-size:([\d.]+)px/)?.[1] ?? 12),
      anchor: a.match(/text-anchor="(\w+)"/)?.[1] ?? 'start',
    }
  })
}

// 375 / 430 宽的手机：整页减去页面和卡片的内边距 64
const PHONES = [311, 366]

describe('消费日历的月份标签（真画出来量）', () => {
  for (const w of PHONES)
    for (const ym of ['2026-09', '2026-02'])
      it(`${w + 64} 宽、停在 ${ym}：每个标签都带年份，相邻两个不叠（原来 375 宽下是「25.1011月」），选中的月份标着`, () => {
        // 变异：calendar.ts 的 monthLabels 去掉降密度（永远全标）→ 相邻标签叠在一起，红
        // 变异：formatter 退回「其余写 M月」→ 出现不带年份的标签，红
        const c = calendar(sampleInput({ ym }), w)
        const { svg } = render(c.option!, c.height!, w)
        const labels = texts(svg).filter((t) => t.size === MONTH_LABEL_FONT && !/^[一三五]$/.test(t.text))
        expect(labels.length).toBeGreaterThanOrEqual(4)
        for (const l of labels) expect(l.text).toMatch(/^\d\d\.\d{1,2}$/)
        expect(labels.at(-1)!.text).toBe(`${ym.slice(2, 4)}.${+ym.slice(5)}`)
        const xs = labels.map((l) => l.x)
        for (let i = 1; i < labels.length; i++) {
          const need = (textWidth(labels[i - 1].text, MONTH_LABEL_FONT) + textWidth(labels[i].text, MONTH_LABEL_FONT)) / 2 + 2
          if (xs[i] - xs[i - 1] < need) expect.fail(`「${labels[i - 1].text}」和「${labels[i].text}」只隔 ${(xs[i] - xs[i - 1]).toFixed(1)}px`)
        }
      })
})

describe('钱的流向的标签（真画出来量）：四张白条 + 现金 + 未指定、一大笔房租的月份', () => {
  const A = (id: string, name: string, sort: number, kind: Account['kind'] = 'bank'): Account => ({ id, name, kind, sort, is_archived: false, repay_day: null, defer_after_repay: null, facade_offset: null })
  const C = (id: string, name: string, sort: number, parent_id: string | null = null): Category => ({ id, kind: 'expense', parent_id, name, icon: null, sort, is_archived: false, note: null })
  const accounts = [A('boc', '中国银行储蓄卡', 1), A('cmb', '招商银行信用卡', 2), A('wx', '微信零钱', 3, 'wallet'), A('zfb', '支付宝余额宝', 4, 'wallet'), A('cash', '现金', 5, 'wallet'), A('jd', '京东白条', 6, 'credit'), A('hb', '花呗', 7, 'credit'), A('pdd', '拼多多先用后付', 8, 'credit')]
  const cats = [
    C('food', '日常餐饮', 1), C('life', '经常生活开支', 2), C('big', '非经常生活消费', 3), C('fun', '娱乐消费', 4), C('oops', '意外开支', 5),
    C('rent', '房租物业水电', 1, 'life'), C('bus', '地铁公交打车', 2, 'life'), C('daily', '日用品', 3, 'life'), C('phone', '话费宽带会员订阅', 4, 'life'),
    C('digi', '数码电子产品', 1, 'big'), C('cloth', '衣服鞋包', 2, 'big'), C('furn', '家具家电', 3, 'big'),
    C('lunch', '午餐', 1, 'food'), C('dinner', '晚餐', 2, 'food'), C('snack', '零食饮料', 3, 'food'), C('fruit', '水果', 4, 'food'),
    C('game', '游戏充值', 1, 'fun'), C('movie', '电影演出', 2, 'fun'), C('med', '看病买药', 1, 'oops'),
  ]
  let n = 0
  const t = (amount: number, account_id: string | null, category_id: string): Transaction => ({
    id: `k${++n}`, date: '2026-09-05', type: 'expense', amount, account_id, to_account_id: null, category_id, note: null, installments: null, settles: null, hidden: null, created_at: '2026-09-05T00:00:00.000Z',
  })
  const txs = [
    t(350000, 'boc', 'rent'), t(9000, 'cmb', 'lunch'), t(8000, 'wx', 'dinner'), t(6000, 'zfb', 'snack'), t(1500, 'cash', 'fruit'), t(2500, 'jd', 'digi'), t(1800, 'hb', 'cloth'),
    t(900, 'pdd', 'daily'), t(700, null, 'bus'), t(3000, 'wx', 'phone'), t(1200, 'wx', 'furn'), t(900, 'zfb', 'game'), t(800, 'wx', 'movie'), t(500, 'cash', 'med'), t(400, 'wx', 'bus'), t(300, 'boc', 'fun'), t(200, 'boc', 'oops'),
  ]
  for (const w of PHONES)
    it(`${w + 64} 宽：同一列的标签上下不叠；最后一列不出画布，长名字截断（全名在提示框）`, () => {
      // 变异：sankey.ts 的 nodeGap 改回 8 → 左列「现金 / 京东白条 / 花呗 …」压成一团，红
      // 变异：最后一列不设 label.width → 「话费宽带会员订阅」整个画出来、出了画布，红
      const c = sankeyChart({ txs, accounts, cats, ym: '2026-09', start: '2026-09-01', end: '2026-09-28', today: '2026-09-28' })
      const { svg } = render(c.option!, c.height!, w)
      const labels = texts(svg).filter((x) => x.size === SANKEY_FONT)
      expect(labels.length).toBe(9 + 5 + 13)
      const cols = new Map<number, typeof labels>()
      for (const l of labels) cols.set(Math.round(l.x), [...(cols.get(Math.round(l.x)) ?? []), l])
      expect(cols.size).toBe(3)
      for (const col of cols.values()) {
        const ys = col.map((l) => l.y).sort((a, b) => a - b)
        for (let i = 1; i < ys.length; i++) if (ys[i] - ys[i - 1] < SANKEY_FONT) expect.fail(`${w + 64} 宽：有两个标签只隔 ${(ys[i] - ys[i - 1]).toFixed(1)}px`)
      }
      const lastX = Math.max(...cols.keys())
      for (const l of cols.get(lastX)!) {
        expect(lastX + LAST_LABEL_W).toBeLessThanOrEqual(w)
        // 截断过的（以 ... 结尾）由 ECharts 按 width 量好了；没截断的自己得放得下
        if (!l.text.endsWith('...') && textWidth(l.text, SANKEY_FONT) > LAST_LABEL_W) expect.fail(`「${l.text}」没截断，出了画布`)
      }
      expect(labels.some((l) => l.text.startsWith('话费宽带') && l.text.endsWith('...'))).toBe(true)
    })
})
