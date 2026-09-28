// 进阶分析页的登记表：十张图的标题、怎么接点击、卡片底下那行字，以及整页共同的两条死规矩——
// 只吃传进来的那本账（不看 hidden）、吐出来的字里不露「隐」「外页面」。
// 每条用例的「变异：xxx → 红」都实际改过、跑过、再改回来。
/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FacadeAdjust } from '../../types'
import { addDays } from '../date'
import { FACADE_EPOCH, outerBook } from '../facade'
import { DEFAULT_SHOWN, MORE_KEYS, type MoreKey } from './layout'
import { buildSafely, MORE_CHARTS, noteWithTap, pointMode, rangeHint, TAP_HINT } from './registry'
import { sampleInput, SAMPLE_ACCOUNTS, SAMPLE_TODAY } from './sample'
import type { MoreChart, MoreInput } from './types'

const CTX = { chartWidth: 329, axisWidth: 285 }
const build = (k: MoreKey, inp: MoreInput = sampleInput()) => MORE_CHARTS[k].build(inp, CTX)

afterEach(() => vi.restoreAllMocks())

describe('登记表', () => {
  it('十张图一张不少、一张不多，每张吐出来的 key 就是登记的 key', () => {
    // 变异：登记表里把 radar 的 build 接成 sankeyChart → key 对不上，红
    expect(Object.keys(MORE_CHARTS).sort()).toEqual([...MORE_KEYS].sort())
    for (const k of MORE_KEYS) expect(build(k).key, k).toBe(k)
  })

  it('「自定义」里列的标题 = 卡片上的标题（登记表里那份静态标题没过期）', () => {
    // 变异：登记表里 race 的标题写成「本月累计」→ 红
    for (const k of MORE_KEYS) expect(MORE_CHARTS[k].title, k).toBe(build(k).title)
  })

  it('翻到 8 月看：标题里没有「本月」「这个月」「五大类」「近 12 个月」这种写死的话，月份写在标题旁', () => {
    // 看 8 月时「本月累计 vs 上月」画的是 8 月 vs 7 月；加了第六个一级分类，「五大类」的雷达图上是六条轴
    // 变异：race 的标题改回「本月累计 vs 上月」→ 红；radar 改回「五大类：本月 vs 上月」→ 红
    const aug = sampleInput({ ym: '2026-08', start: '2025-09-01', end: '2026-08-31' })
    for (const k of MORE_KEYS) {
      const c = build(k, aug)
      expect(c.title, k).not.toMatch(/本月|这个月|五大类|近 ?12/)
      expect(c.note, k).not.toMatch(/近 ?12/)
      if (MORE_CHARTS[k].scope === 'month') expect(c.span, k).toMatch(/26\.8$/)
    }
  })

  it('白条那张的 x 轴宽度从页面传进去（宽度不同，标签疏密可以不同，但不能不传）', () => {
    // 变异：登记表里 credit 不转发 axisWidth（用默认 285）→ 两个宽度吐出同一份，红
    const narrow = MORE_CHARTS.credit.build(sampleInput(), { chartWidth: 104, axisWidth: 60 })
    const wide = MORE_CHARTS.credit.build(sampleInput(), { chartWidth: 644, axisWidth: 600 })
    const shown = (c: MoreChart) => {
      const o = c.option as { xAxis: { axisLabel: { interval: (i: number) => boolean }; data: string[] } }
      return o.xAxis.data.map((_, i) => o.xAxis.axisLabel.interval(i)).filter(Boolean).length
    }
    expect(shown(narrow)).toBeLessThan(shown(wide))
  })
})

describe('怎么点：一年的账、今天 9/28 打开', () => {
  it('日历点格子（没有直角坐标）；累计 / 瀑布 / 储蓄率 / 白条点绘图区；其余五张不接点击', () => {
    // 变异：pointMode 不看有没有 xAxis、一律 'axis' → 日历成了 axis（永远点不动），红
    // 变异：pointMode 不看 onPoint → 桑基、雷达也成了能点的，红
    const got = Object.fromEntries(MORE_KEYS.map((k) => [k, pointMode(build(k))]))
    expect(got).toEqual({
      calendar: 'item',
      race: 'axis',
      waterfall: 'axis',
      saving: 'axis',
      credit: 'axis',
      sankey: null,
      radar: null,
      weekhour: null,
      histogram: null,
      habits: null,
    })
  })

  it('没数据（空状态）时不接点击，哪怕这张图有 onPoint', () => {
    const empty = sampleInput({ txs: [] })
    for (const k of MORE_KEYS) expect(pointMode(build(k, empty)), k).toBeNull()
    // 现在十张图空状态时 option 都是 null；但约定是「有 empty 就不画图」，option 留着也一样不接点击。
    // 变异：pointMode 不看 empty → 下面这张成了 axis，红
    const odd: MoreChart = { key: 'x', title: '', note: '', option: { xAxis: {} }, empty: '没有', onPoint: () => 'ym=2026-09' }
    expect(pointMode(odd)).toBeNull()
  })

  it('能点的那几张，底下那行字补一句「点一下看明细，再点一下看流水。」，句号不重复；不能点的原样', () => {
    // 变异：不管原文结尾一律补「。」→ 日历那句（以「。」结尾）成了「。。」，红
    // 变异：原文没句号时不补 → 下面那张自造的卡成了「没句号点一下…」，红
    const cal = build('calendar')
    expect(noteWithTap(cal)).toBe(`${cal.note}${TAP_HINT}`)
    const odd: MoreChart = { key: 'x', title: '', note: '没句号', option: { xAxis: {} }, onPoint: () => 'ym=2026-09&cat=all' }
    expect(noteWithTap(odd)).toBe(`没句号。${TAP_HINT}`)
    const sankey = build('sankey')
    expect(noteWithTap(sankey)).toBe(sankey.note)
  })

  it('每张卡底下那行字都以「。」结尾——有数据、没数据（空状态不接点击，不会替它补句号）、翻回去年都一样', () => {
    // 变异：日历的 note 去掉句末的「。」→ 空状态那张就以「校准不算」结尾，红
    const inps = [sampleInput(), sampleInput({ txs: [] }), sampleInput({ ym: '2025-12', start: '2025-01-01', end: '2025-12-31' })]
    for (const inp of inps)
      for (const k of MORE_KEYS) {
        const n = build(k, inp).note
        if (!n.endsWith('。')) expect.fail(`${k}：「${n.slice(-12)}」没以句号结尾`)
      }
  })

  it('日历点的是 9 月 12 号那格 → 跳到 9 月、定位到 12 号；累计线点「今天之后」的日子不跳', () => {
    // 变异：calendar.ts 的 onPoint 取 days[dataIndex + 1] → 红；race.ts 把「今天之后」写成 d >= today（今天也不跳）→ 红
    const cal = build('calendar')
    const o = cal.option as { series: { data: [string, number][] }[] }
    const i = o.series[0].data.findIndex(([d]) => d === '2026-09-12')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(cal.onPoint?.(i, 0)).toBe('ym=2026-09&date=2026-09-12&cat=all')
    const race = build('race')
    expect(race.onPoint?.(27, 0)).toBe('ym=2026-09&date=2026-09-28&cat=all')
    expect(race.onPoint?.(28, 0)).toBeNull()
  })

  it('每一个跳去流水的链接都带 cat（流水页只有收到 cat 才重设筛选，不带就会留着上次的分类筛选）——图上的点、能点的小方块都算', () => {
    // 变异：saving.ts 的 onPoint 去掉 &cat=all → 红；histogram 小方块的 go 去掉 &cat=all → 红
    let n = 0
    for (const k of MORE_KEYS) {
      const c = build(k)
      for (let i = 0; i < 400; i++) {
        const q = c.onPoint?.(i, 0) ?? null
        if (q === null) continue
        n++
        if (!/(^|&)cat=/.test(q)) expect.fail(`${k} 第 ${i} 个点跳「${q}」，没带 cat`)
      }
      for (const t of c.tiles ?? []) if (t.go !== undefined && !/(^|&)cat=/.test(t.go)) expect.fail(`${k} 的小方块「${t.label}」跳「${t.go}」，没带 cat`)
    }
    expect(n).toBeGreaterThan(300) // 真的走到了：日历三百多天、累计线、瀑布、储蓄率、白条
    expect(build('histogram').tiles!.every((t) => t.go)).toBe(true)
  })
})

describe('一张图算崩了', () => {
  it('只有那一张卡说出错了，key 和标题照旧；不往外抛（整页不会掉进 ErrorBoundary）', () => {
    // 变异：buildSafely 去掉 try/catch → 抛出来，红
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = { ...sampleInput(), cats: null } as unknown as MoreInput
    const c = buildSafely('sankey', broken, CTX)
    expect(c.key).toBe('sankey')
    expect(c.title).toBe('钱的流向')
    expect(c.option).toBeNull()
    expect(c.empty).toMatch(/出错/)
    const fine = buildSafely('race', sampleInput(), CTX)
    expect(fine.empty).toBeUndefined()
    expect(fine.option).not.toBeNull()
  })
})

// ---------- 整页的两条死规矩（CLAUDE.md「里外页面」） ----------

/** 一张图「看得见的东西」：option 里的数据（函数被 JSON 丢掉）、tiles、empty、几个点的跳转 */
function face(c: MoreChart): string {
  const jumps = [0, 1, 5, 12, 40].map((i) => c.onPoint?.(i, 0) ?? null)
  return JSON.stringify({ title: c.title, note: c.note, option: c.option, tiles: c.tiles, empty: c.empty, height: c.height, jumps })
}

describe('只吃传进来的那本账', () => {
  it('把一半流水打上 hidden 记号（但不拿掉），十张图吐出来的一模一样——谁偷看 hidden 谁就红', () => {
    // 页面传进来的已经是 outerBook 的结果，藏掉的早就不在了；图自己再看一遍 hidden 就是双重过滤，
    // 里页面下（txs 原样、hidden 还在）会把该算的漏掉。
    // 变异：在 histogram.ts 的循环里加一行 `if (t.hidden) continue` → 红
    const inp = sampleInput()
    const marked = { ...inp, txs: inp.txs.map((t, i) => (i % 2 ? { ...t, hidden: true } : t)) }
    for (const k of MORE_KEYS) expect(face(build(k, marked)), k).toBe(face(build(k, inp)))
  })

  it('外页面那本账（藏掉几笔、换掉真实校准、加上外页面校准记录）喂进去，和「只有真流水」的账本结果一样', () => {
    // 端到端：页面那一行 outerBook(txs, accounts, fadj, mode) → 图。藏掉的那几笔不能从任何地方漏回来；
    // 外页面校准记录（外页面流水从来不列它们）也不能让任何一张图变样——十张图没有一张画非白条账户的余额。
    // 外页面校准放在三个地方：迁移出来的 2000-01-01、「连续记账」断掉的那一天、半年前的某一天。
    // 变异：facade.ts 的 stripForOuter 不看 hidden → 红
    // 变异：habits.ts 的 streakDays 不看类型（校准也算记过账，改前的写法）→ 断掉的那天被外页面校准接上，红
    const inp = sampleInput()
    const raw = inp.txs.map((t, i) => (i % 7 === 3 && t.account_id !== 'jd' && t.account_id !== 'hb' && t.to_account_id !== 'jd' && t.to_account_id !== 'hb' ? { ...t, hidden: true } : t))
    const byHand = raw.filter((t) => !t.hidden && !(t.type === 'adjust' && t.account_id !== 'jd' && t.account_id !== 'hb'))
    const recorded = new Set(byHand.filter((t) => t.type !== 'adjust').map((t) => t.date))
    let gap = SAMPLE_TODAY
    while (recorded.has(gap)) gap = addDays(gap, -1)
    const fa = (id: string, account_id: string, date: string, cents: number): FacadeAdjust => ({ id, account_id, date, cents, created_at: `${date}T02:00:00.000Z` })
    const fadj = [fa('fa-epoch', 'wx', FACADE_EPOCH, 123400), fa('fa-gap', 'wx', gap, -5000), fa('fa-mid', 'boc', '2026-03-15', 88800)]
    const outer = outerBook(raw, SAMPLE_ACCOUNTS, fadj, 'outer')
    expect(outer.length).toBe(byHand.length + fadj.length)
    for (const k of MORE_KEYS) expect(face(build(k, { ...inp, txs: outer })), k).toBe(face(build(k, { ...inp, txs: byHand })))
  })
})

describe('吐出来的字里不露馅', () => {
  it('十张图的标题、说明、空状态、小数字、坐标轴上的字，没有「隐」也没有「外页面」', () => {
    // 这一页在外页面下照常打开，给别人看的时候一个字都不能漏。
    // 变异：给 habits 的 note 加上「（外页面）」→ 红
    const inps = [sampleInput(), sampleInput({ txs: [] }), sampleInput({ ym: '2025-12', start: '2025-01-01', end: '2025-12-31' })]
    for (const inp of inps)
      for (const k of MORE_KEYS) {
        const s = face(build(k, inp))
        if (/隐|外页面|外面/.test(s)) expect.fail(`${k}：${s.match(/.{0,12}(隐|外页面|外面).{0,12}/)?.[0]}`)
      }
    for (const k of MORE_KEYS) expect(MORE_CHARTS[k].title).not.toMatch(/隐|外页面/)
  })
})

// ---------- 每张卡按哪段时间算 ----------

describe('标题旁的区间：顶上两个控件各管哪几张图', () => {
  it('近一年、停在 9 月：日历和储蓄率是到 9 月为止的 12 个月，流向 / 单笔 / 时段 / 白条 / 习惯是那一年，累计 / 瀑布 / 雷达是 9 月', () => {
    // 变异：sankey 的 span 写成 ym 的月份 → 红
    const got = Object.fromEntries(MORE_KEYS.map((k) => [k, build(k).span]))
    expect(got).toEqual({
      calendar: '25.10–26.9',
      sankey: '25.10–26.9',
      race: '26.9',
      waterfall: '26.9',
      saving: '25.10–26.9',
      radar: '26.9',
      credit: '25.10–26.9',
      weekhour: '25.10–26.9',
      histogram: '25.10–26.9',
      habits: '25.10–26.9',
    })
  })

  it('把时间段换成「本月」：scope = range 的那几张区间跟着变，scope = month 的一张都不变（用户能看出按钮管的是哪几张）', () => {
    // 变异：登记表里日历的 scope 写成 'range' → 它的区间不跟着变，红
    // 变异：histogram 的 span 按 ym 写 → 换成本月时不变，红
    const year = sampleInput()
    const month = sampleInput({ start: '2026-09-01' })
    for (const k of MORE_KEYS) {
      const a = build(k, year).span
      const b = build(k, month).span
      if (MORE_CHARTS[k].scope === 'range') expect(b, k).not.toBe(a)
      else expect(b, k).toBe(a)
    }
    expect(build('sankey', month).span).toBe('26.9')
  })

  it('半截月份写到日，不写成「26.9」冒充整个 9 月：自定义 9/5–9/20、9/5 到今天；「全部记录」从第一笔（3/14）起', () => {
    // 变异：rangeSpan 不看起点是不是月初（终点是月底或今天就按月写）→ 后两条红
    // 变异：rangeSpan 不看终点（起点是月初就按月写）→ 第四条红
    expect(build('histogram', sampleInput({ start: '2026-09-05', end: '2026-09-20' })).span).toBe('26.9.5–26.9.20')
    expect(build('histogram', sampleInput({ start: '2026-09-05' })).span).toBe('26.9.5–26.9.28')
    expect(build('sankey', sampleInput({ start: '2025-03-14' })).span).toBe('25.3.14–26.9.28')
    expect(build('sankey', sampleInput({ start: '2026-09-01', end: '2026-09-20' })).span).toBe('26.9.1–26.9.20')
    // 同一天：只写一天
    expect(build('sankey', sampleInput({ start: '2026-09-20', end: '2026-09-20' })).span).toBe('26.9.20')
  })

  it('没数据的卡也写区间（「这段时间没有支出」说的是哪段）', () => {
    // 变异：sankey 空状态那条 return 不带 base.span → 红
    for (const k of MORE_KEYS) expect(build(k, sampleInput({ txs: [] })).span, k).toBeTruthy()
  })

  it('时间段按钮旁那句话：默认三张里只有「钱的流向」跟着它；一张都没有就不显示；多了只写第一张和张数', () => {
    // 变异：rangeHint 不看 scope（列出全部打开的图）→ 红
    expect(rangeHint(DEFAULT_SHOWN)).toBe('「钱的流向」按这段时间算')
    expect(rangeHint(['calendar', 'race'])).toBeNull()
    expect(rangeHint(['sankey', 'histogram'])).toBe('「钱的流向」「单笔多大」按这段时间算')
    expect(rangeHint(MORE_KEYS)).toBe('「钱的流向」等 5 张图按这段时间算')
  })
})

// ---------- lib/more 下所有源文件的死规矩（新加一张图自动被守住） ----------

describe('lib/more/*.ts 源码守卫', () => {
  const dir = new URL('.', import.meta.url)
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'sample.ts')

  it('找得到全部源文件（十张图 + 登记表 + 布局 + 类型 + 区间）', () => {
    // 守卫自己的守卫：变异：files 的过滤写成 f.endsWith('.tsx')（一个都找不到，下面两条空转也是绿的）→ 红
    expect(files.length).toBeGreaterThanOrEqual(14)
    expect(files).toContain('calendar.ts')
  })

  it('不写死十六进制颜色（3、4、6、8 位都算）', () => {
    // 原来各文件自己守、正则五花八门：{6} 的漏掉 '#eee'、'#ece6dd80'，{3,6} 的漏掉 8 位。
    // 变异：waterfall.ts 的轴线色写成 '#eee' → 红；saving.ts 写成 '#ece6dd80' → 红
    for (const f of files) {
      const hits = readFileSync(new URL(f, dir), 'utf8').match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
      if (hits.length) expect.fail(`${f} 里写死了颜色：${hits.join(' ')}`)
    }
  })

  it('不看 hidden、不碰 store / api / supabase / facade（注释不算）', () => {
    // layout.ts 的 hidden 是「自定义」里关掉的那几张图（MoreLayout.hidden），不是流水的记号；它也不碰流水
    // 变异：radar.ts 里加一句 `inp.txs.filter((t) => !t.hidden)` → 红
    for (const f of files) {
      const code = readFileSync(new URL(f, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      if (f !== 'layout.ts' && /\.hidden\b/.test(code)) expect.fail(`${f} 看了 hidden`)
      if (/from '\.\.\/(store|api|supabase|facade)'/.test(code)) expect.fail(`${f} import 了 store / api / facade`)
    }
  })
})
