// 大额消费。输入一律是「用户记了这些账，选了这段时间，打开看到什么」。
// 每条用例都先把实现改坏跑过一次，确认它会红（注释里的「变异：… → 红」）。
import * as echarts from 'echarts/core'
import { ScatterChart } from 'echarts/charts'
import { SingleAxisComponent, TooltipComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Category, Transaction } from '../../types'
import { textWidth } from '../chart'
import { bucketKeys } from '../compute'
import { addDays } from '../date'
import { categoryColor, CHART } from '../palette'
import { BAND, BIG_CENTS, bigticket, bigTickets, liftOf, NOTE_MAX, SIZE_MAX, SIZE_MIN, symbolSizeOf } from './bigticket'
import { pointMode } from './registry'
import { sampleInput } from './sample'
import type { MoreChart, MoreInput } from './types'

const cat = (id: string, parent_id: string | null, name: string, sort = 1): Category => ({
  id, kind: 'expense', parent_id, name, icon: null, sort, is_archived: false, note: null,
})
const CATS: Category[] = [
  cat('food', null, '日常餐饮', 1),
  cat('dinner', 'food', '晚餐', 2),
  cat('life', null, '经常生活开支', 2),
  cat('rent', 'life', '房租', 1),
  cat('big', null, '非经常生活消费', 3),
  cat('pet', null, '宠物', 4),
  cat('study', null, '学习', 5),
]

let seq = 0
function tx(p: Partial<Transaction> & Pick<Transaction, 'amount' | 'date'>): Transaction {
  seq++
  return {
    id: `b${seq}`,
    type: 'expense',
    account_id: 'boc',
    to_account_id: null,
    category_id: null,
    note: null,
    installments: null,
    settles: null,
    hidden: null,
    created_at: `${p.date}T04:00:00.000Z`,
    ...p,
  }
}
const spend = (date: string, yuan: number, category_id: string | null, note: string | null = null, over: Partial<Transaction> = {}) =>
  tx({ date, amount: Math.round(yuan * 100), category_id, note, ...over })

const inputOf = (txs: Transaction[], start = '2025-10-01', end = '2026-09-28'): MoreInput => ({
  txs, accounts: [], cats: CATS, ym: '2026-09', start, end, today: '2026-09-28',
})

type Item = { value: [number, number]; symbolSize: number; symbolOffset: [number, number]; itemStyle: { color: string } }
type Opt = {
  series: { type: string; coordinateSystem: string; data: Item[] }[]
  singleAxis: { data: string[]; axisLabel: { interval: (i: number) => boolean } }
  tooltip: { formatter: (p: { dataIndex: number }) => string; extraCssText: string }
}
const opt = (c: MoreChart) => c.option as unknown as Opt
const items = (c: MoreChart) => opt(c).series[0].data

/**
 * 一年的账，时间段选近一年（25.10.1–26.9.28）：
 *   9/1 房租 3500；8/15 京东白条买手机 5999 分 3 期；7/3 请客吃饭正好 500；6/6 499.99（差一分）；
 *   9/17 还白条 5000（转账）、9/10 工资 12000、9/20 校准 +800（都不是支出）；
 *   25/9/30 范围前一天 9000、26/9/29 范围后一天（提前记的）8000。
 */
const BOOK: Transaction[] = [
  spend('2026-09-01', 3500, 'rent', '9 月房租'),
  spend('2026-08-15', 5999, 'big', '手机', { account_id: 'jd', installments: 3 }),
  spend('2026-07-03', 500, 'dinner', '请客'),
  spend('2026-06-06', 499.99, 'dinner'),
  tx({ type: 'transfer', amount: 500000, date: '2026-09-17', to_account_id: 'jd' }),
  tx({ type: 'income', amount: 1200000, date: '2026-09-10', category_id: null }),
  tx({ type: 'adjust', amount: 80000, date: '2026-09-20' }),
  spend('2025-09-30', 9000, 'big'),
  spend('2026-09-29', 8000, 'big'),
]

afterEach(() => vi.restoreAllMocks())

describe('大额消费：打开近一年看到什么', () => {
  it('圈只有三个：手机、房租、正好 500 的那顿饭；499.99、还白条、工资、校准、范围外的都不算', () => {
    // 变异：`t.amount >= BIG_CENTS` 改成 `>` → 正好 500 那笔没了，红
    // 变异：去掉 `t.type === 'expense'` → 还白条 5000、工资 12000 成了圈，红
    // 变异：`t.date <= end` 改成 `<`（范围最后一天不算）→ 下面第二段 9/1 那笔丢了，红
    const c = bigticket(inputOf(BOOK))
    expect(c.key).toBe('bigticket')
    expect(c.title).toBe('大额消费')
    expect(c.span).toBe('25.10–26.9')
    const got = bigTickets(BOOK, '2025-10-01', '2026-09-28').map((t) => [t.date, t.amount])
    // 小的在前、大的在后（大的最后画、压在最上面）
    expect(got).toEqual([
      ['2026-07-03', BIG_CENTS],
      ['2026-09-01', 350000],
      ['2026-08-15', 599900],
    ])
    expect(items(c)).toHaveLength(3)
    expect(c.tiles).toEqual([
      { label: '大额笔数', value: '3 笔' },
      { label: '合计', value: '¥9,999.00' },
    ])
    // 范围两端当天都算
    expect(bigTickets(BOOK, '2026-08-15', '2026-09-01').map((t) => t.date)).toEqual(['2026-09-01', '2026-08-15'])
  })

  it('圈的面积跟金额成正比：最大那笔直径 40，四分之一那么多的直径 20，再小也不小于 8', () => {
    // 变异：直径按金额线性（SIZE_MAX * amount / max）→ 四分之一那笔成了 10，红
    // 变异：去掉 Math.max(SIZE_MIN, …) → 最小那笔成了 4，红
    const txs = [spend('2026-09-01', 8000, 'big'), spend('2026-09-02', 2000, 'big'), spend('2026-09-03', 500, 'big')]
    // 数据按小的在前排：500、2000、8000
    const sizes = items(bigticket(inputOf(txs))).map((d) => d.symbolSize)
    expect(sizes[2]).toBe(40)
    expect(sizes[1]).toBe(20)
    // 500 / 8000 → 40 × √(1/16) = 10，没到底；换成 50000 那笔当最大，500 这笔就只有 4 → 抬到 8
    expect(sizes[0]).toBe(10)
    expect(symbolSizeOf(50000, 5000000)).toBe(SIZE_MIN)
  })

  it('每个圈落在它自己那天：x 下标 = 那天在「25.10.1 起逐日」里的位置；点一下跳的就是那一笔那天的流水', () => {
    // 变异：onPoint 按 x 下标取日期（keys[dataIndex]）→ 第 0 个圈跳到 25/10/1，红
    // 变异：onPoint 还按原来「大的在前」的顺序找（`list[list.length - 1 - dataIndex]`）→ 第 0 个圈跳到手机那天，红
    // 变异：x 下标写成 `(at.get(t.date) ?? 0) + 1`（错开一天）→ 红
    const c = bigticket(inputOf(BOOK))
    const keys = bucketKeys('2025-10-01', '2026-09-28', 'day')
    expect(opt(c).singleAxis.data).toHaveLength(keys.length)
    const want = ['2026-07-03', '2026-09-01', '2026-08-15']
    items(c).forEach((d, i) => {
      expect(d.value[0]).toBe(keys.indexOf(want[i]))
      expect(c.onPoint!(i, 0)).toBe(`ym=${want[i].slice(0, 7)}&date=${want[i]}&cat=all`)
    })
    expect(c.onPoint!(3, 0)).toBeNull()
  })

  it('点击走「点中哪个圈算哪个」（和日历一样），不走「点绘图区取最近的 x 下标」——一年 365 天一天不到 1 px，那样点不中', () => {
    // 变异：singleAxis 换成 xAxis（+ 一行的 yAxis）→ pointMode 成了 'axis'，红
    const c = bigticket(inputOf(BOOK))
    expect(pointMode(c)).toBe('item')
    expect(opt(c).series[0].coordinateSystem).toBe('singleAxis')
  })

  it('同一天两笔大额（2000 的机票、600 的酒店）：大的后画、压在上面；两个圈一高一低错开，各点各的', () => {
    // 审阅 #11：原来大的先画、全压在一条线上，一年十几个圈叠成一坨，最大那几笔反而被压在底下。
    // 变异：bigTickets 排序改回大的在前 → 红
    // 变异：去掉 symbolOffset（不错开）→ 两个圈心一样高，红
    const txs = [spend('2026-09-05', 2000, 'big', '机票'), spend('2026-09-05', 600, 'big', '酒店')]
    const c = bigticket(inputOf(txs))
    const d = items(c)
    expect(d.map((x) => x.value[1])).toEqual([600, 2000])
    // 机票（大的）圈心更高：偏移更往上（负得多）
    expect(d[1].symbolOffset[1]).toBeLessThan(d[0].symbolOffset[1])
    // 提示框、跳转都认下标：第 1 个就是机票
    expect(opt(c).tooltip.formatter({ dataIndex: 1 })).toContain('机票')
    expect(opt(c).tooltip.formatter({ dataIndex: 0 })).toContain('酒店')
    expect(c.onPoint!(1, 0)).toBe('ym=2026-09&date=2026-09-05&cat=all')
  })

  it('纵向按 log(金额) 错开：最大那笔贴着带子顶、最小那笔贴着轴线；钱越多圈心越高；只有一种金额就放中间', () => {
    // 变异：liftOf 按金额线性（不取 log）→ 5000 那笔掉到下半截，红
    // 变异：上端点也按这个圈自己的大小算（`size / 2 + 1`）→ 500 到 1 万块之间扫一遍，近顶那段钱多的圈心反而低，红
    const half = BAND / 2
    // 最大（40 px）：圈顶离带子顶 1 px
    expect(liftOf(5000000, 50000, 5000000, 40)).toBe(20 + 1 - half)
    // 最小（8 px）：圈底离轴线 1 px
    expect(liftOf(50000, 50000, 5000000, 8)).toBe(half - 4 - 1)
    // 500 → 5000 → 50000：log 上正好一半，圈心在两端点正中间（按线性算的话 5000 只有 0.09，贴着底）
    const mid = liftOf(500000, 50000, 5000000, 20)
    expect(mid).toBe(Math.round(((21 + (BAND - 10 - 1)) / 2 - half) * 10) / 10)
    expect(liftOf(80000, 80000, 80000, 40)).toBe(Math.round(((21 + (BAND - 21)) / 2 - half) * 10) / 10)
    // 这段时间最小 500、最大 1 万：一块一块往上扫，圈心只升不降
    let prev = Infinity
    for (let a = 50000; a <= 1000000; a += 100) {
      const dy = liftOf(a, 50000, 1000000, symbolSizeOf(a, 1000000))
      if (dy > prev) expect.fail(`${a / 100} 元的圈心比少一块的还低（${dy} > ${prev}）`)
      prev = dy
    }
  })

  it('提示框：日期、分类（记在二级上写「日常餐饮 · 晚餐」）、金额、备注；备注里的尖括号原样显示，不当 HTML', () => {
    // 变异：catLabel 只写二级名 → 没有「日常餐饮 · 」，红
    // 变异：备注不转义 → 「<b>」原样进了 HTML，红
    const txs = [spend('2026-09-12', 888, 'dinner', '<b>生日</b> & 蛋糕'), spend('2026-09-13', 520, null)]
    const c = bigticket(inputOf(txs, '2026-09-01', '2026-09-28'))
    // 小的在前：0 是 520 那笔，1 是 888 那笔
    const tip = opt(c).tooltip.formatter({ dataIndex: 1 })
    expect(tip).toContain('9月12日 周六')
    expect(tip).toContain('日常餐饮 · 晚餐')
    expect(tip).toContain('¥888.00')
    expect(tip).toContain('&lt;b&gt;生日&lt;/b&gt; &amp; 蛋糕')
    expect(tip).not.toContain('<b>')
    expect(tip).toContain('再点一下看流水')
    // 没分类、没备注
    const tip2 = opt(c).tooltip.formatter({ dataIndex: 0 })
    expect(tip2).toContain('未分类')
    expect(tip2).not.toContain('opacity:.75')
  })

  it('分类名里带尖括号（「<Steam>游戏」）：提示框里原样显示，不被浏览器当成标签吞掉', () => {
    // 走的是共享的 lib/more/html.ts 的 esc（原来这里自己抄了一份）。
    // 变异：catLabel 不过 esc → 「<Steam>」原样进了 HTML，红
    const cats = [...CATS, cat('steam', null, '<Steam>游戏', 9)]
    const c = bigticket({ ...inputOf([spend('2026-09-12', 648, 'steam')]), cats })
    const tip = opt(c).tooltip.formatter({ dataIndex: 0 })
    expect(tip).toContain('&lt;Steam&gt;游戏')
    expect(tip).not.toContain('<Steam>')
  })

  it('提示框：长备注截到 16 个字加「…」，提示框能折行、最宽 240 px（不撑出屏幕）', () => {
    // 变异：去掉截断 → 整段备注进了提示框，红
    // 变异：按 UTF-16 长度截（s.slice(0, 16)）→ 「𠮷」这种字被劈成半个，红
    // 变异：先转义再截 → 「&amp;」被截成「&am」，红
    const long = '𠮷野家牛肉饭加大份两碗外带给室友还有一杯柠檬茶'
    const amp = '一二三四五六七八九十一二三四五&六七'
    const c = bigticket(inputOf([spend('2026-09-12', 600, 'dinner', long), spend('2026-09-13', 700, 'dinner', amp)], '2026-09-01', '2026-09-28'))
    const tip = opt(c).tooltip.formatter({ dataIndex: 0 })
    expect(tip).toContain(`${[...long].slice(0, NOTE_MAX).join('')}…`)
    expect(tip).not.toContain(long)
    expect(opt(c).tooltip.formatter({ dataIndex: 1 })).toContain('一二三四五六七八九十一二三四五&amp;…')
    // 16 个字以内原样，不加「…」
    const short = bigticket(inputOf([spend('2026-09-12', 600, 'dinner', '机票')], '2026-09-01', '2026-09-28'))
    expect(opt(short).tooltip.formatter({ dataIndex: 0 })).not.toContain('…')
    expect(opt(c).tooltip.extraCssText).toBe('white-space:normal;max-width:240px')
  })

  it('提示框的日期：时间段跨年（近一年）带年份「2025年10月3日」，不跨年（26 年 1 月到 9 月）不带', () => {
    // 年份永远带着是统计页的规矩：近一年里的「10月3日」看不出是哪年的 10 月。
    // 变异：一律不带年份 → 红；一律带 → 不跨年那张也带了，红
    const txs = [spend('2025-10-03', 600, 'big'), spend('2026-03-03', 700, 'big')]
    const cross = opt(bigticket(inputOf(txs)))
    expect(cross.tooltip.formatter({ dataIndex: 0 })).toMatch(/^2025年10月3日 周五<br\/>/)
    expect(cross.tooltip.formatter({ dataIndex: 1 })).toMatch(/^2026年3月3日 周二<br\/>/)
    const same = opt(bigticket(inputOf(txs, '2026-01-01', '2026-09-28')))
    expect(same.tooltip.formatter({ dataIndex: 0 })).toMatch(/^3月3日 周二<br\/>/)
  })

  it('颜色 = 一级分类在饼图上的颜色：认得名字的用固定色，认不出的按这几笔里的合计排名次取备用色，没分类的灰', () => {
    // 变异：按记账那一级取色（categoryColor('晚餐')）→ 晚餐那笔拿到备用色，红
    // 变异：认不出名字的一律 categoryColor(name)（不传名次）→「宠物」「学习」撞成同一个色，红
    const txs = [
      spend('2026-09-01', 900, 'dinner'),
      spend('2026-09-02', 3000, 'pet'),
      spend('2026-09-03', 2000, 'study'),
      spend('2026-09-04', 700, null),
    ]
    const colors = items(bigticket(inputOf(txs))).map((d) => d.itemStyle.color)
    // 顺序（小的在前）：700 未分类、900 晚餐、2000 学习、3000 宠物
    expect(colors).toEqual([CHART.label, categoryColor('日常餐饮'), categoryColor('学习', 1), categoryColor('宠物', 0)])
    expect(colors[2]).not.toBe(colors[3])
  })

  it('横轴标签：年份带着（26/4/1），窄屏标得比宽屏疏；手机宽度下近一年按季度标', () => {
    // 变异：axisLabels 不用传进来的宽度（写死 285）→ 两个宽度一样疏密，红
    const shown = (w: number) => {
      const o = opt(bigticket(inputOf(BOOK), w))
      return o.singleAxis.data.filter((_, i) => o.singleAxis.axisLabel.interval(i))
    }
    expect(shown(200).length).toBeLessThan(shown(900).length)
    expect(shown(329)).toEqual(['25/10/1', '26/1/1', '26/4/1', '26/7/1'])
  })

  it('范围第一天 / 最后一天的圈和标签不被卡片边切掉：左右留白 ≥ 最大圈的半径，也 ≥ 首尾标签的半宽', () => {
    // SSR 画出来看过：留白 12 px 时 40 px 的圈被切掉一块，「25/10/1」只剩「5/10/1」
    // 变异：AXIS_PAD 写回 12 → 红
    const txs = [spend('2025-10-01', 5000, 'big'), spend('2026-09-28', 5000, 'big')]
    const o = bigticket(inputOf(txs)).option as { singleAxis: { left: number; right: number; data: string[] } }
    const half = (s: string) => textWidth(s, 10) / 2
    const ends = [o.singleAxis.data[0], o.singleAxis.data[o.singleAxis.data.length - 1]]
    expect(ends).toEqual(['25/10/1', '26/9/28'])
    for (const pad of [o.singleAxis.left, o.singleAxis.right]) {
      expect(pad).toBeGreaterThanOrEqual(SIZE_MAX / 2)
      for (const e of ends) expect(pad).toBeGreaterThanOrEqual(half(e))
    }
  })

  it('这段时间只有几十块的小钱 → 一句话「没有 500 元以上的单笔」，不画图；标题旁照样写这段时间', () => {
    // 变异：删掉 empty 分支 → 取最大那笔时 list[0] 是 undefined，抛错，红
    const c = bigticket(inputOf([spend('2026-09-01', 30, 'dinner'), spend('2026-09-02', 499.99, 'big')], '2026-09-01', '2026-09-28'))
    expect(c.option).toBeNull()
    expect(c.empty).toBe('这段时间没有 500 元以上的单笔')
    expect(c.span).toBe('26.9')
    expect(c.note.endsWith('。')).toBe(true)
  })
})

describe('大额消费：不变量', () => {
  function rng(seed: number) {
    let s = seed >>> 0
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
  }

  it('随机账本 × 随机时间段：圈数 = 范围内 ≥500 的支出笔数；图上金额之和 = 「合计」；直径在 [8, 40]、钱越多圈越大越高、最大那笔正好 40、不探出带子；第 i 个圈的提示框和跳转说的就是第 i 笔', () => {
    // 变异：直径不按最大那笔归一（分母写成 BIG_CENTS）、也不封顶 40 → 出界，红
    // 变异：onPoint 还按「大的在前」的顺序找（`list[list.length - 1 - dataIndex]`）→ 跳的日子和圈的位置对不上，红
    const TYPES = ['expense', 'expense', 'expense', 'income', 'transfer', 'adjust'] as const
    for (let k = 0; k < 200; k++) {
      const r = rng(k + 7)
      const txs: Transaction[] = []
      for (let i = 0; i < 50; i++) {
        const amount = r() < 0.3 ? BIG_CENTS - 2 + Math.floor(r() * 4) : 1 + Math.floor(r() * (r() < 0.2 ? 2000000 : 60000))
        txs.push(tx({ type: TYPES[Math.floor(r() * TYPES.length)], amount, date: addDays('2026-01-01', Math.floor(r() * 270)) }))
      }
      const start = addDays('2026-01-01', Math.floor(r() * 120))
      const end = addDays(start, Math.floor(r() * 150))
      const want = txs.filter((t) => t.type === 'expense' && t.amount >= BIG_CENTS && t.date >= start && t.date <= end)
      const c = bigticket(inputOf(txs, start, end))
      if (!want.length) {
        if (c.option !== null || !c.empty) expect.fail(`第 ${k} 份：没有大额却画了图`)
        continue
      }
      const d = items(c)
      if (d.length !== want.length) expect.fail(`第 ${k} 份：${d.length} 个圈 ≠ ${want.length} 笔`)
      const sum = want.reduce((s, t) => s + t.amount, 0)
      if (Math.round(d.reduce((s, x) => s + x.value[1] * 100, 0)) !== sum) expect.fail(`第 ${k} 份：图上之和 ≠ ${sum}`)
      if (c.tiles?.[0].value !== `${want.length} 笔`) expect.fail(`第 ${k} 份：笔数格子不对`)
      if (d[d.length - 1].symbolSize !== SIZE_MAX) expect.fail(`第 ${k} 份：最大那笔直径 ${d[d.length - 1].symbolSize}`)
      const keys = bucketKeys(start, end, 'day')
      const tip = opt(c).tooltip.formatter
      for (let i = 0; i < d.length; i++) {
        const s = d[i].symbolSize
        const dy = d[i].symbolOffset[1]
        if (s < SIZE_MIN || s > SIZE_MAX) expect.fail(`第 ${k} 份：直径 ${s} 出界`)
        if (Math.abs(dy) + s / 2 > BAND / 2 + 1e-9) expect.fail(`第 ${k} 份：第 ${i} 个圈探出带子（偏 ${dy}、直径 ${s}）`)
        if (i && d[i].value[1] < d[i - 1].value[1]) expect.fail(`第 ${k} 份：没按小的在前排`)
        if (i && d[i].value[1] > d[i - 1].value[1] && (s < d[i - 1].symbolSize || dy > d[i - 1].symbolOffset[1])) expect.fail(`第 ${k} 份：钱多的圈反而小或反而低`)
        const day = keys[d[i].value[0]]
        if (c.onPoint!(i, 0) !== `ym=${day.slice(0, 7)}&date=${day}&cat=all`) expect.fail(`第 ${k} 份：第 ${i} 个圈在 ${day}，跳的是 ${c.onPoint!(i, 0)}`)
        const yuan = (d[i].value[1]).toFixed(2)
        if (!tip({ dataIndex: i }).replace(/,/g, '').includes(`¥${yuan}`)) expect.fail(`第 ${k} 份：第 ${i} 个圈 ¥${yuan}，提示框说的不是它`)
      }
    }
  })
})

describe('大额消费：真画一遍（ECharts SSR）', () => {
  // 进阶分析页要给这张图注册的模块就是这几个：ScatterChart + SingleAxisComponent（+ Chart.tsx 已有的 TooltipComponent）
  echarts.use([ScatterChart, SingleAxisComponent, TooltipComponent, SVGRenderer])

  it('一年的样例账：不报错、不报「没注册」，每一笔大额都画成一个圈', () => {
    // 变异：series 去掉 coordinateSystem: 'singleAxis' → ECharts 找不到直角坐标系，报错，红
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')))
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')))
    const c = bigticket(sampleInput())
    expect(c.option).not.toBeNull()
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 329, height: c.height ?? 220 })
    try {
      chart.setOption(c.option as echarts.EChartsCoreOption, true)
      const svg = chart.renderToSVGString()
      expect(errors, errors.join('\n')).toEqual([])
      expect(svg.length).toBeGreaterThan(3000)
      // 每个圈的颜色都出现在画出来的图里
      for (const d of items(c)) expect(svg).toContain(d.itemStyle.color)
    } finally {
      chart.dispose()
    }
  })

  /** 在 (x, y) 真点一下（按下、抬起、click），返回 ECharts 报上来的 dataIndex；没点中任何圈是 [] */
  function tapAt(chart: ReturnType<typeof echarts.init>, x: number, y: number): number[] {
    const got: number[] = []
    const on = (p: { dataIndex: number }) => void got.push(p.dataIndex)
    chart.on('click', on)
    const zr = chart.getZr() as unknown as { handler: { dispatch: (n: string, e: object) => void } }
    for (const n of ['mousedown', 'mouseup', 'click']) zr.handler.dispatch(n, { zrX: x, zrY: y })
    chart.off('click', on)
    return got
  }

  it('点中哪个圈算哪个：错开之后，在每个圈露出来的地方点一下，ECharts 报上来的就是它（symbolOffset 挪的是圈本身，点击判定跟着挪）', () => {
    // 同一天一大一小、一年的样例账两份：只要一个圈没被后画的圈整个盖住，就在它露出来的地方找一个点点下去。
    // 变异：option 里不带 symbolOffset（圈全在中线上）→ 在该在的位置点下去点到空白或别的圈，红
    const cases: MoreInput[] = [inputOf([spend('2026-09-05', 2000, 'big', '机票'), spend('2026-09-05', 600, 'big', '酒店')]), sampleInput()]
    let checked = 0
    for (const inp of cases) {
      const c = bigticket(inp)
      const d = items(c)
      const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 329, height: c.height ?? 220 })
      try {
        chart.setOption(c.option as echarts.EChartsCoreOption, true)
        // 圈该在哪：横向问 ECharts（那天在轴上的位置），纵向自己按 liftOf 算，不读 option 里的 symbolOffset
        const lo = Math.round(d[0].value[1] * 100)
        const hi = Math.round(d[d.length - 1].value[1] * 100)
        const at = d.map((x) => {
          const [px, py] = chart.convertToPixel({ seriesIndex: 0 }, x.value) as number[]
          return { x: px, y: py + liftOf(Math.round(x.value[1] * 100), lo, hi, x.symbolSize), r: x.symbolSize / 2 }
        })
        const inside = (p: { x: number; y: number }, q: { x: number; y: number; r: number }, pad: number) => Math.hypot(p.x - q.x, p.y - q.y) < q.r + pad
        for (let i = 0; i < d.length; i++) {
          // 圆心和圈里 0.6 半径的一圈点：挑一个不在任何后画的圈里的（离它们的边再远 2 px）
          const cands = [{ x: at[i].x, y: at[i].y }, ...Array.from({ length: 16 }, (_, j) => ({ x: at[i].x + 0.6 * at[i].r * Math.cos((j * Math.PI) / 8), y: at[i].y + 0.6 * at[i].r * Math.sin((j * Math.PI) / 8) }))]
          const p = cands.find((q) => at.slice(i + 1).every((o) => !inside(q, o, 2)))
          if (!p) continue // 整个被后画的大圈盖住了：点它本来就点到上面那个
          checked++
          const got = tapAt(chart, p.x, p.y)
          if (got.length !== 1 || got[0] !== i) expect.fail(`第 ${i} 个圈（${d[i].value[1]} 元）露出来的地方点下去，报的是 ${JSON.stringify(got)}`)
        }
        // 同一天那两笔：大的压在上面，点大圈的圆心就是大的
        if (inp === cases[0]) expect(tapAt(chart, at[1].x, at[1].y)).toEqual([1])
      } finally {
        chart.dispose()
      }
    }
    expect(checked).toBeGreaterThan(10)
  })
})
