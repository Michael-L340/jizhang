// 进阶分析页的登记表：全部图（两批共二十张）的标题、怎么接点击、卡片底下那行字，以及整页共同的两条死规矩——
// 只吃传进来的那本账（不看 hidden）、吐出来的字里不露「隐」「外页面」。
// 每条用例的「变异：xxx → 红」都实际改过、跑过、再改回来。
/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FacadeAdjust } from '../../types'
import { balances } from '../compute'
import { addDays } from '../date'
import { FACADE_EPOCH, outerBook } from '../facade'
import { textWidth } from '../chart'
import { CHART } from '../palette'
import { categoryAxisOf } from '../tap'
import { DEFAULT_SHOWN, MORE_KEYS, type MoreKey } from './layout'
import { buildSafely, MORE_CHARTS, noteWithTap, pointMode, rangeHint, TAP_HINT } from './registry'
import { sampleInput, SAMPLE_ACCOUNTS, SAMPLE_TODAY } from './sample'
import type { MoreChart, MoreInput } from './types'

const CTX = { chartWidth: 329, axisWidth: 285 }
const build = (k: MoreKey, inp: MoreInput = sampleInput()) => MORE_CHARTS[k].build(inp, CTX)

afterEach(() => vi.restoreAllMocks())

describe('登记表', () => {
  it('二十张图一张不少、一张不多，每张吐出来的 key 就是登记的 key', () => {
    // 变异：登记表里把 radar 的 build 接成 sankeyChart → key 对不上，红
    expect(Object.keys(MORE_CHARTS).sort()).toEqual([...MORE_KEYS].sort())
    for (const k of MORE_KEYS) expect(build(k).key, k).toBe(k)
  })

  it('「自定义」里列的标题 = 卡片上的标题（登记表里那份静态标题没过期）', () => {
    // 变异：登记表里 race 的标题写成「本月累计」→ 红
    // 吃饭占多少例外的一种情况：没有名字像吃饭的分类时卡片上换成「<那一类>占多少」（engel.test.ts 守着），样例账里有「日常餐饮」
    for (const k of MORE_KEYS) expect(MORE_CHARTS[k].title, k).toBe(build(k).title)
  })

  it('「自定义」里每行标题下那句话（desc）：每张都有、两两不同、手机上一行放得下（11px 字不超过 180px），不说「本月」这种写死的话', () => {
    // 二十行只有标题分不清哪张是哪张（审阅 #9）。弹层一行里还要放两个箭头和一个开关，字的那一栏窄屏上不到 200px。
    // 变异：给 treemap 的 desc 写成空串 → 红；给 position 的 desc 写成一整句口径说明 → 超宽，红
    const descs = MORE_KEYS.map((k) => MORE_CHARTS[k].desc)
    for (const k of MORE_KEYS) {
      const d = MORE_CHARTS[k].desc
      if (!d.trim()) expect.fail(`${k} 没有 desc`)
      if (textWidth(d, 11) > 180) expect.fail(`${k} 的 desc「${d}」有 ${textWidth(d, 11)}px，一行放不下`)
      if (/本月|这个月|五大类/.test(d)) expect.fail(`${k} 的 desc「${d}」写死了月份`)
    }
    expect(new Set(descs).size).toBe(descs.length)
  })

  it('标题两两不同：「自定义」清单、时间段按钮旁那句话里分得清是哪张', () => {
    // 第二批的矩形树图原定也叫「钱去哪了」，和第一批的瀑布图撞名，整合时改成「支出版图」。
    // 变异：登记表和 treemap.ts 的标题都改回「钱去哪了」→ 红（只改登记表一处的话上一条也红）
    const titles = MORE_KEYS.map((k) => MORE_CHARTS[k].title)
    expect(new Set(titles).size).toBe(titles.length)
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

  it('第二批跟宽度有关的五张，宽度都从页面传进去（窄屏、宽屏吐出来的不一样）', () => {
    // 变异：登记表里 delta 写成 (i) => delta(i)（用默认 329）→ 红；
    // engel 不转发 axisWidth → 红；bigticket 不转发 chartWidth → 红；assets 不转发 axisWidth → 红；
    // creditplan 不转发 axisWidth → 红；assets 不转发 chartWidth（图例宽度）→ 红
    const N = { chartWidth: 104, axisWidth: 60 }
    const W = { chartWidth: 644, axisWidth: 600 }
    const at = (k: MoreKey, ctx: typeof N) => MORE_CHARTS[k].build(sampleInput(), ctx).option as Record<string, unknown>
    const labelsShown = (axis: unknown) => {
      const a = axis as { data: string[]; axisLabel: { interval: (i: number) => boolean } }
      return a.data.filter((_, i) => a.axisLabel.interval(i)).length
    }
    // 环比涨跌榜：金额轴一边多长按宽度算（放得下柱头的金额）
    const dMax = (ctx: typeof N) => (at('delta', ctx).xAxis as { max: number }).max
    expect(dMax(N)).not.toBe(dMax(W))
    // （支出版图不在这里：块上的字写不写，由 ECharts 排完版按每一块的实际大小定，不用页面传宽度，见 treemap.ts 的 cell）
    expect(labelsShown(at('engel', N).xAxis)).toBeLessThan(labelsShown(at('engel', W).xAxis))
    expect(labelsShown(at('bigticket', N).singleAxis)).toBeLessThan(labelsShown(at('bigticket', W).singleAxis))
    expect(labelsShown(at('assets', N).xAxis)).toBeLessThan(labelsShown(at('assets', W).xAxis))
    expect(labelsShown(at('creditplan', N).xAxis)).toBeLessThan(labelsShown(at('creditplan', W).xAxis))
    // 图例几行按整张图的宽度排
    for (const k of ['assets', 'creditplan'] as const) expect((at(k, W).legend as { width: number }).width, k).toBe(W.chartWidth)
  })

  it('资产结构、白条未来负担按账户品牌色分色：页面传进来的 colorOf 真的转发到了图上', () => {
    // 品牌色在 components/AccountIcon，lib 不许 import，由页面经 BuildCtx.colorOf 传进来。
    // 变异：登记表里 assets 不转发 c.colorOf → 红；creditplan 不转发 → 红
    const brand: Record<string, string> = { 中国银行: CHART.expense, 微信: CHART.income, 支付宝: CHART.balance, 京东白条: CHART.brandInk, 花呗: CHART.balance }
    const ctx = { ...CTX, colorOf: (name: string) => brand[name] ?? CHART.label }
    const colors = (k: MoreKey, c: typeof CTX) => (MORE_CHARTS[k].build(sampleInput(), c).option as { color: string[] }).color
    // 第一个账户不会被「撞色换深浅」改掉，一定是它的品牌色
    expect(colors('assets', ctx)[0]).toBe(CHART.expense)
    expect(colors('creditplan', ctx)[0]).toBe(CHART.brandInk)
    expect(colors('assets', ctx)).not.toEqual(colors('assets', CTX))
    expect(colors('creditplan', ctx)).not.toEqual(colors('creditplan', CTX))
  })
})

describe('怎么点：一年的账、今天 9/28 打开', () => {
  it('日历、大额消费点图形（没有直角坐标）；累计 / 瀑布 / 储蓄率 / 白条 / 环比涨跌榜 / 历史位置 / 吃饭占多少 / 资产结构点绘图区；其余不接点击', () => {
    // 历史位置（position）第二批审阅 #16 加了 onPoint：点哪一号跳所选月份那一天，和「累计支出 vs 上月」一样
    // 变异：position.ts 的返回去掉 onPoint → position 成了 null，红
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
      // 第二批
      bigticket: 'item',
      delta: 'axis',
      engel: 'axis',
      assets: 'axis',
      treemap: null,
      position: 'axis',
      fixed: null,
      places: null,
      creditplan: null,
      delay: null,
    })
  })

  it('点绘图区的那几张，Chart 都认得出类目轴（点哪一列 / 哪一行就是哪一个）；环比涨跌榜是横着的，取 y 的下标', () => {
    // 原来 Chart.tsx 一律取 x：环比涨跌榜的 x 是金额轴，点哪一行提示框都被拉回第一行（整合第二批时修的，lib/tap.ts）。
    // 变异：categoryAxisOf 不看 y（x 没 data 就 0 项）→ delta 红
    for (const k of MORE_KEYS) {
      const c = build(k)
      if (pointMode(c) !== 'axis') continue
      const ax = categoryAxisOf(c.option)
      if (ax.count === 0) expect.fail(`${k}：Chart 找不到类目轴，点哪儿都是第 0 个`)
      for (let i = 0; i < ax.count; i++) if (c.onPoint?.(i, 0) === undefined) expect.fail(`${k} 第 ${i} 个没有 onPoint`)
    }
    const d = build('delta')
    expect(categoryAxisOf(d.option)).toEqual({ dim: 1, count: (d.option as { yAxis: { data: string[] } }).yAxis.data.length })
  })

  it('没数据（空状态）时不接点击，哪怕这张图有 onPoint', () => {
    const empty = sampleInput({ txs: [] })
    for (const k of MORE_KEYS) expect(pointMode(build(k, empty)), k).toBeNull()
    // 现在每张图空状态时 option 都是 null；但约定是「有 empty 就不画图」，option 留着也一样不接点击。
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
  it('把一半流水打上 hidden 记号（但不拿掉），每张图吐出来的一模一样——谁偷看 hidden 谁就红', () => {
    // 页面传进来的已经是 outerBook 的结果，藏掉的早就不在了；图自己再看一遍 hidden 就是双重过滤，
    // 里页面下（txs 原样、hidden 还在）会把该算的漏掉。
    // 变异：在 histogram.ts 的循环里加一行 `if (t.hidden) continue` → 红
    const inp = sampleInput()
    const marked = { ...inp, txs: inp.txs.map((t, i) => (i % 2 ? { ...t, hidden: true } : t)) }
    for (const k of MORE_KEYS) expect(face(build(k, marked)), k).toBe(face(build(k, inp)))
  })

  it('外页面那本账（藏掉几笔、换掉真实校准、加上外页面校准记录）喂进去：除了画余额的「资产结构变化」，和「只有真流水」的账本结果一样；资产结构的余额 = 外页面账户页的余额', () => {
    // 端到端：页面那一行 outerBook(txs, accounts, fadj, mode) → 图。藏掉的那几笔不能从任何地方漏回来；
    // 外页面校准记录（外页面流水从来不列它们）也不能让不画余额的图变样。
    // 「资产结构变化」画的正是资产账户的余额：外页面下它必须跟着外页面校准记录走，和账户页、统计页「总资产」读同一本账——
    // 不跟着走才是露馅（外页面的总资产和这张图对不上）。所以它单独查：每个账户最后一个月底 = 外页面账户页上那个数。
    // 变异：assets.ts 喂给 balanceSeries 前滤掉 adjust（外页面校准记录没算进去）→ 红
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
    const DRAWS_BALANCE: MoreKey[] = ['assets']
    for (const k of MORE_KEYS) if (!DRAWS_BALANCE.includes(k)) expect(face(build(k, { ...inp, txs: outer })), k).toBe(face(build(k, { ...inp, txs: byHand })))
    const a = build('assets', { ...inp, txs: outer })
    const series = (a.option as { series: { name: string; data: number[] }[] }).series
    const shown = balances(outer, SAMPLE_ACCOUNTS) // 账户页外页面那一列：balances(outerBook(...), accounts)
    const assetAccs = SAMPLE_ACCOUNTS.filter((x) => x.kind !== 'credit')
    for (const acc of assetAccs) expect(series.find((x) => x.name === acc.name)?.data.at(-1) ?? 0, acc.name).toBe(shown[acc.id] ?? 0)
    // 真的走了外页面那本账：和只有真流水的账本画出来的不一样（外页面校准记录记在微信、中行上）
    expect(face(a)).not.toBe(face(build('assets', { ...inp, txs: byHand })))
  })
})

describe('吐出来的字里不露馅', () => {
  it('每张图的标题、说明、空状态、小数字、坐标轴上的字，没有「隐」也没有「外页面」', () => {
    // 这一页在外页面下照常打开，给别人看的时候一个字都不能漏。
    // 变异：给 habits 的 note 加上「（外页面）」→ 红
    const inps = [sampleInput(), sampleInput({ txs: [] }), sampleInput({ ym: '2025-12', start: '2025-01-01', end: '2025-12-31' })]
    for (const inp of inps)
      for (const k of MORE_KEYS) {
        const s = face(build(k, inp))
        if (/隐|外页面|外面/.test(s)) expect.fail(`${k}：${s.match(/.{0,12}(隐|外页面|外面).{0,12}/)?.[0]}`)
      }
    for (const k of MORE_KEYS) expect(MORE_CHARTS[k].title).not.toMatch(/隐|外页面/)
    // 「自定义」弹层里标题下那句话也是外页面下看得见的
    // 变异：给 delay 的 desc 加上「（外页面）」→ 红
    for (const k of MORE_KEYS) expect(MORE_CHARTS[k].desc, k).not.toMatch(/隐|外页面|外面/)
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
      // 第二批
      treemap: '25.10–26.9',
      bigticket: '25.10–26.9',
      places: '25.10–26.9',
      assets: '25.10–26.9',
      delay: '25.10–26.9',
      engel: '25.10–26.9', // 到 9 月为止的 12 个月
      delta: '26.8–26.9', // 9 月比 8 月
      position: '25.9–26.9', // 往前 12 个月（样例账从 25.9 记起）+ 9 月
      fixed: '26.6–26.8', // 9 月还没过完：最近三个过完的月份
      creditplan: '26.10–27.9', // 从今天往后：9 月已经没有要还的，从 10 月起
    })
  })

  it('「白条未来负担」两个控件都不管（scope = now）：翻月份、换时间段，区间都不变；只跟着今天走', () => {
    // 它看的是还没到期的账：翻回 3 月看，也是从今天往后的 12 个月。
    // 变异：登记表里 creditplan 的 scope 写成 'month' → 「翻到 8 月」那条要求区间以 26.8 结尾，红；
    //       写成 'range' → 「换成本月」那条要求区间跟着变，红（这两条变异都实际跑过）
    // 变异：rangeHint 按 scope !== 'month' 挑（把 now 也算成跟着时间段走）→ 下面最后一条红
    expect(MORE_KEYS.filter((k) => MORE_CHARTS[k].scope === 'now')).toEqual(['creditplan'])
    const span = build('creditplan').span
    for (const inp of [sampleInput({ ym: '2026-03' }), sampleInput({ start: '2026-09-01' }), sampleInput({ ym: '2025-12', start: '2025-01-01', end: '2025-12-31' })]) {
      expect(build('creditplan', inp).span).toBe(span)
    }
    expect(build('creditplan', sampleInput({ today: '2026-11-20' })).span).not.toBe(span)
    expect(rangeHint(['creditplan'])).toBeNull()
  })

  it('把时间段换成「本月」：scope = range 的那几张区间跟着变，其余（month、now）的一张都不变（用户能看出按钮管的是哪几张）', () => {
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
    expect(rangeHint(MORE_KEYS)).toBe('「钱的流向」等 10 张图按这段时间算')
  })
})

// ---------- lib/more 下所有源文件的死规矩（新加一张图自动被守住） ----------

describe('lib/more/*.ts 源码守卫', () => {
  const dir = new URL('.', import.meta.url)
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'sample.ts')

  it('找得到全部源文件（二十张图 + 账户配色 + 登记表 + 布局 + 类型 + 区间）', () => {
    // 守卫自己的守卫：变异：files 的过滤写成 f.endsWith('.tsx')（一个都找不到，下面两条空转也是绿的）→ 红
    expect(files.length).toBeGreaterThanOrEqual(25)
    expect(files).toContain('treemap.ts')
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
