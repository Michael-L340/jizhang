// 备注里常写的（原来叫「最常去的地方」）。输入一律是「用户这段时间的支出备注写了什么，打开看到什么」。
// 每条用例都先把实现改坏跑过一次，确认它会红（注释里的「变异：… → 红」）。
import * as echarts from 'echarts/core'
import { BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Transaction } from '../../types'
import { addDays } from '../date'
import { placeWords, places, TOP_WORDS, wordsOf } from './places'
import { pointMode } from './registry'
import { sampleInput } from './sample'
import type { MoreChart, MoreInput } from './types'

let seq = 0
function tx(date: string, yuan: number, note: string | null, over: Partial<Transaction> = {}): Transaction {
  seq++
  return {
    id: `p${seq}`, date, type: 'expense', amount: Math.round(yuan * 100), account_id: 'wx', to_account_id: null,
    category_id: null, note, installments: null, settles: null, hidden: null, created_at: `${date}T04:00:00.000Z`, ...over,
  }
}
const inputOf = (txs: Transaction[], start = '2026-09-01', end = '2026-09-28'): MoreInput => ({
  txs, accounts: [], cats: [], ym: '2026-09', start, end, today: '2026-09-28',
})

type Opt = {
  yAxis: { data: string[]; inverse: boolean }
  series: { type: string; data: number[] }[]
  tooltip: { formatter: (ps: { dataIndex: number }[]) => string }
}
const opt = (c: MoreChart) => c.option as unknown as Opt
const bars = (c: MoreChart) => {
  const o = opt(c)
  return o.yAxis.data.map((w, i) => [w, o.series[0].data[i]])
}

/**
 * 9 月的支出备注：
 *   「星巴克 拿铁」35、「星巴克」40、「全家 便当」20、「全家」15、「星巴克 星巴克 续杯」30（一笔里写了两遍）
 *   工资的备注「星巴克 兼职」、还白条的备注「星巴克」、校准的备注「全家」——都不是支出，不算
 */
const BOOK: Transaction[] = [
  tx('2026-09-01', 35, '星巴克 拿铁'),
  tx('2026-09-02', 40, '星巴克'),
  tx('2026-09-03', 20, '全家 便当'),
  tx('2026-09-04', 15, '全家'),
  tx('2026-09-05', 30, '星巴克 星巴克 续杯'),
  tx('2026-09-10', 3000, '星巴克 兼职', { type: 'income' }),
  tx('2026-09-11', 500, '星巴克', { type: 'transfer', to_account_id: 'jd' }),
  tx('2026-09-12', 5, '全家', { type: 'adjust' }),
]

afterEach(() => vi.restoreAllMocks())

describe('备注里常写的：打开看到什么', () => {
  it('星巴克 3 次、全家 2 次排在最上面；剩下各 1 次的按花得多的在前（拿铁 35、续杯 30、便当 20）', () => {
    // 变异：一笔备注里重复的词不去重 → 星巴克 4 次，红
    // 变异：去掉 `t.type !== 'expense'` → 工资、还白条、校准的备注也算，星巴克 5 次，红
    // 变异：一样多的不按合计排（只按次数）→ 1 次那几个的顺序不对，红
    // 变异：yAxis 去掉 inverse → 第一名跑到最底下，红
    const c = places(inputOf(BOOK))
    expect(c.key).toBe('places')
    // 切出来的词不全是地方（拿铁、便当），标题照实说（审阅 #15）。变异：标题改回「最常去的地方」→ 红
    expect(c.title).toBe('备注里常写的')
    expect(c.span).toBe('26.9')
    expect(bars(c)).toEqual([
      ['星巴克', 3],
      ['全家', 2],
      ['拿铁', 1],
      ['续杯', 1],
      ['便当', 1],
    ])
    // 第一名在最上面
    expect(opt(c).yAxis.inverse).toBe(true)
  })

  it('提示框：这个词对应的那几笔支出合计（星巴克 35 + 40 + 30 = ¥105.00）', () => {
    // 变异：合计写成 `e.cents = t.amount`（只留最后一笔）→ ¥30.00，红
    const c = places(inputOf(BOOK))
    const tip = opt(c).tooltip.formatter([{ dataIndex: 0 }])
    expect(tip).toContain('星巴克')
    expect(tip).toContain('3 次')
    expect(tip).toContain('¥105.00')
  })

  it('切词：按汉字 / 字母 / 数字的边界切；单字、单个字母、纯数字都不算；一整串汉字是一个词', () => {
    // 变异：去掉「至少两个字」（MIN_LEN）→ 「元」「份」「s」冒出来，红
    // 变异：去掉纯数字那条 → 「15」「2026」冒出来，红
    const w = (s: string) => wordsOf(s).map((x) => x.text)
    expect(w('午饭15元')).toEqual(['午饭'])
    expect(w('KFC 2 份')).toEqual(['KFC'])
    expect(w('在星巴克买咖啡')).toEqual(['在星巴克买咖啡'])
    expect(w("麦当劳McDonald's")).toEqual(['麦当劳', 'McDonald'])
    expect(w('饭，2026，A')).toEqual([])
    expect(wordsOf(null)).toEqual([])
  })

  it('全角半角算一个写法：「ＫＦＣ」「KFC」「ｋｆｃ」是同一家，一共 3 次，显示成半角「KFC」；全角数字「１５」也是数字、不算词', () => {
    // 变异：切词前不做 NFKC → 「ＫＦＣ」一个字母都匹配不上（[A-Za-z] 不认全角），只剩 1 次，红
    const txs = [tx('2026-09-01', 30, 'ＫＦＣ'), tx('2026-09-02', 30, 'KFC 全家桶'), tx('2026-09-03', 30, 'ｋｆｃ１５元')]
    expect(bars(places(inputOf(txs)))[0]).toEqual(['KFC', 3])
    expect(wordsOf('午饭１５元').map((x) => x.text)).toEqual(['午饭'])
  })

  it('扩展区的汉字（「𠮷野家」的「𠮷」）不被切掉：整串是一个词；单独一个「𠮷」是一个字、不算', () => {
    // 变异：汉字范围写回 [一-龥]（只到基本区）→ 切出「野家」，红
    // 变异：字数按 UTF-16 长度算（w.length）→ 单独一个「𠮷」（占两个单元）被当成两个字，红
    expect(wordsOf('𠮷野家 牛肉饭').map((x) => x.text)).toEqual(['𠮷野家', '牛肉饭'])
    expect(wordsOf('𠮷 A').map((x) => x.text)).toEqual([])
    const c = places(inputOf([tx('2026-09-01', 30, '𠮷野家'), tx('2026-09-02', 32, '𠮷野家 外带')]))
    expect(bars(c)[0]).toEqual(['𠮷野家', 2])
  })

  it('英文不分大小写：「kfc」1 次、「KFC」2 次算同一家，一共 3 次，写成用得多的「KFC」', () => {
    // 变异：key 不转小写 → 拆成两家，红
    // 变异：写法取第一次出现的（`if (!word)`）→ 显示成「kfc」，红
    const txs = [tx('2026-09-01', 30, 'kfc'), tx('2026-09-02', 30, 'KFC 全家桶'), tx('2026-09-03', 30, 'KFC')]
    expect(bars(places(inputOf(txs)))[0]).toEqual(['KFC', 3])
  })

  it('词再多也只画前 10 个；卡片高度跟着条数走', () => {
    // 变异：去掉 slice(0, TOP_WORDS) → 画了 12 条，红
    const names = ['一号店', '二号店', '三号店', '四号店', '五号店', '六号店', '七号店', '八号店', '九号店', '十号店', '十一店', '十二店']
    const txs = names.map((n, i) => tx(addDays('2026-09-01', i), 10 + i, n))
    const c = places(inputOf(txs))
    expect(opt(c).yAxis.data).toHaveLength(TOP_WORDS)
    // 一样是 1 次，按合计大的在前：十二店（21 元）第一
    expect(opt(c).yAxis.data[0]).toBe('十二店')
    expect(c.height).toBeGreaterThan(places(inputOf(txs.slice(0, 3))).height!)
  })

  it('范围两端当天的算，范围外的不算', () => {
    // 变异：`t.date > end` 写成 `t.date >= end` → 9/28 那笔丢了，红
    const txs = [tx('2026-08-31', 10, '罗森'), tx('2026-09-01', 10, '罗森'), tx('2026-09-28', 10, '罗森'), tx('2026-09-29', 10, '罗森')]
    expect(bars(places(inputOf(txs)))).toEqual([['罗森', 2]])
  })

  it('备注都没写、或者只写了数字和单字 → 一句话「备注写得少，还统计不出来」；这张图不接点击', () => {
    // 变异：删掉 empty 分支 → 画出一张没有条的图，红
    const c = places(inputOf([tx('2026-09-01', 10, null), tx('2026-09-02', 10, ''), tx('2026-09-03', 10, '2 份 饭')]))
    expect(c.option).toBeNull()
    expect(c.empty).toBe('备注写得少，还统计不出来')
    expect(c.span).toBe('26.9')
    expect(c.note.endsWith('。')).toBe(true)
    expect(pointMode(places(inputOf(BOOK)))).toBeNull()
  })
})

describe('备注里常写的：不变量', () => {
  function rng(seed: number) {
    let s = seed >>> 0
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
  }
  const VOCAB = ['星巴克', '全家', '罗森', 'KFC', 'Lawson', '麦当劳', '食堂', '地铁', '𠮷野家']
  /** 半角字母 → 全角（Ａ = U+FF21） */
  const wide = (w: string) => w.replace(/[A-Za-z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0))
  // 词和词之间一定隔着点什么（空格、标点、数字）：「星巴克15全家」切成「星巴克」「全家」。别拿汉字当分隔（「15元全家」会粘成「元全家」）
  const SEP = [' ', '，', '、', ' 2 ', '15', '/']

  it('随机备注（用词表拼出来、夹着数字和标点）：每个词的次数 ≡ 备注里含这个词的支出笔数，合计 ≡ 这些笔的金额和；次数从多到少排', () => {
    // 生成的时候就知道每条备注里有哪几个词——拿生成器当标准答案，不拿实现自己的切词
    // 变异：不做 NFKC → 全角写的 KFC / Lawson 不算，红；汉字范围写回 [一-龥] → 「野家」冒出来，红
    // 变异：合计写成 `e.cents = t.amount` → 合计对不上，红
    for (let k = 0; k < 200; k++) {
      const r = rng(k + 5)
      const txs: Transaction[] = []
      const truth = new Map<string, { count: number; cents: number }>()
      for (let i = 0; i < 40; i++) {
        const picked = VOCAB.filter(() => r() < 0.25)
        // 同一个词随机写成原样 / 小写 / 全角：都算同一个
        const parts = picked.flatMap((w) => {
          const x = r()
          return [x < 0.4 ? w : x < 0.7 ? w.toLowerCase() : wide(w), SEP[Math.floor(r() * SEP.length)]]
        })
        const type = r() < 0.8 ? 'expense' : 'income'
        const t = tx(addDays('2026-08-25', Math.floor(r() * 40)), 1 + Math.floor(r() * 300), parts.join('') || null, { type })
        txs.push(t)
        if (type !== 'expense' || t.date < '2026-09-01' || t.date > '2026-09-28') continue
        for (const w of new Set(picked.map((x) => x.toLowerCase()))) {
          const e = truth.get(w) ?? { count: 0, cents: 0 }
          e.count++
          e.cents += t.amount
          truth.set(w, e)
        }
      }
      const got = placeWords(txs, '2026-09-01', '2026-09-28')
      if (got.length !== truth.size) expect.fail(`第 ${k} 份：${got.length} 个词 ≠ ${truth.size}`)
      for (let i = 0; i < got.length; i++) {
        const g = got[i]
        const want = truth.get(g.word.toLowerCase())
        if (!want || want.count !== g.count || want.cents !== g.cents) expect.fail(`第 ${k} 份：「${g.word}」${g.count} 次 ${g.cents} ≠ ${JSON.stringify(want)}`)
        if (i && g.count > got[i - 1].count) expect.fail(`第 ${k} 份：没按次数从多到少排`)
      }
      const c = places(inputOf(txs))
      if (c.option && opt(c).series[0].data.join() !== got.slice(0, TOP_WORDS).map((g) => g.count).join()) expect.fail(`第 ${k} 份：图上的条和统计对不上`)
    }
  })
})

describe('备注里常写的：真画一遍（ECharts SSR）', () => {
  // 要的模块：BarChart + GridComponent + TooltipComponent（Chart.tsx 本来就注册了，不用另加）
  echarts.use([BarChart, GridComponent, TooltipComponent, SVGRenderer])

  it('一堆带备注的支出：不报错，每个词都印在图上', () => {
    // 变异：series 的 type 写成 'pictorialBar'（没注册）→ 报「没注册」，红
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')))
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')))
    const base = sampleInput()
    const notes = ['星巴克 拿铁', '全家', '食堂 午饭', 'KFC', '地铁']
    const txs = base.txs.map((t, i) => (t.type === 'expense' ? { ...t, note: notes[i % notes.length] } : t))
    const c = places({ ...base, txs })
    expect(c.option).not.toBeNull()
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 329, height: c.height ?? 220 })
    try {
      chart.setOption(c.option as echarts.EChartsCoreOption, true)
      const svg = chart.renderToSVGString()
      expect(errors, errors.join('\n')).toEqual([])
      expect(svg.length).toBeGreaterThan(3000)
      for (const w of opt(c).yAxis.data) expect(svg).toContain(`>${w}<`)
    } finally {
      chart.dispose()
    }
  })
})
