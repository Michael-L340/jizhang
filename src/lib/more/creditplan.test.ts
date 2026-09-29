/// <reference types="node" />
// 白条未来负担。输入是「今天几号 + 一本小账」，断言打开那张卡看到的数；而且让时间往前走（还一笔款、过一个月再看）——
// 白条的 bug（2026-09-08 那三个）无一例外只在跨月之后才现形。
// 期望值都是按 CLAUDE.md 的白条规则手算的，不拿 creditBill 自己的输出当答案。
// 每条用例注释里的「变异：xxx → 红」都真的跑过。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { accountColor } from '../../components/AccountIcon'
import type { Account, Transaction } from '../../types'
import { balances, creditBill, currentDueDate } from '../compute'
import { addDays, monthOf, shiftMonth } from '../date'
import { CHART } from '../palette'
import { fallbackColors, tooClose } from './acctcolor'
import { creditPlan, creditPlanChart } from './creditplan'
import type { MoreInput } from './types'

const A = (id: string, name: string, kind: Account['kind'], sort: number, repay_day: number | null = null, defer = false): Account => ({
  id, name, kind, sort, is_archived: false, repay_day, defer_after_repay: defer, facade_offset: null,
})
const boc = A('boc', '中国银行', 'bank', 1)
const jd = A('jd', '京东白条', 'credit', 5, 17, true) // 还款日 17，本期还过款之后下的单归下一期
const hb = A('hb', '花呗', 'credit', 6, 1)
const pdd = A('pdd', '拼多多', 'credit', 7, null) // 先用后付，没有固定还款日
const accounts = [boc, jd, hb, pdd]

let seq = 0
function tx(date: string, type: Transaction['type'], yuan: number, account_id: string | null, over: Partial<Transaction> = {}): Transaction {
  seq++
  return {
    id: `c${seq}`, date, type, amount: Math.round(yuan * 100), account_id, to_account_id: null, category_id: null, note: null,
    installments: null, settles: null, hidden: null, created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(), ...over,
  }
}
const buy = (date: string, yuan: number, acc: string, over: Partial<Transaction> = {}) => tx(date, 'expense', yuan, acc, over)
const repay = (date: string, yuan: number, to: string, over: Partial<Transaction> = {}) => tx(date, 'transfer', yuan, 'boc', { to_account_id: to, ...over })

const input = (txs: Transaction[], today: string, over: Partial<MoreInput> = {}): MoreInput => ({
  txs, accounts, cats: [], ym: monthOf(today), start: '2026-01-01', end: today, today, ...over,
})

type Series = { name: string; data: number[]; animationDelay: (i: number) => number; animationDuration: (i: number) => number; animationEasing: string; stack: string }
type Opt = {
  color: string[]
  legend: { data: string[] }
  xAxis: { data: string[] }
  series: Series[]
  tooltip: { formatter: (ps: { dataIndex: number; marker: string; seriesName: string; value: number }[]) => string }
}
function view(inp: MoreInput) {
  const ch = creditPlanChart(inp)
  const o = ch.option as unknown as Opt | null
  return {
    ch,
    o,
    months: o?.xAxis.data ?? [],
    by: Object.fromEntries((o?.series ?? []).map((s) => [s.name, s.data])) as Record<string, number[]>,
    tiles: Object.fromEntries((ch.tiles ?? []).map((t) => [t.label, t.value])),
  }
}
const z = (n: number) => Array.from({ length: n }, () => 0)

// 9/1 京东下单 600 分 3 期：8/17 之后没还过款、不顺延 → 9/17、10/17、11/17 各 200
// 9/10 花呗下单 100：还款日 1 号 → 10/1 到期
// 9/2 中行买东西 50：不是白条，不该出现在任何数里
const ledger = () => [buy('2026-09-01', 600, 'jd', { installments: 3 }), buy('2026-09-10', 100, 'hb'), buy('2026-09-02', 50, 'boc')]

describe('白条未来负担：打开看到什么，时间往前走', () => {
  it('9/20 打开：京东 9/17 那期逾期没还，滚进本期（10/17）→ 10 月京东 400、花呗 100；11 月京东 200。9 月已经没有要还的，从 10 月起', () => {
    // 变异：逾期的按它自己的到期日归月（payBy 对 overdue 返回 row.due.date）→ 9 月冒出 200、整排往前挪一个月，红
    // 变异：起点恒为今天这个月 → 区间成了 26.9–27.8，红
    const v = view(input(ledger(), '2026-09-20'))
    expect(v.ch.key).toBe('creditplan')
    expect(v.ch.title).toBe('白条未来负担')
    expect(v.ch.span).toBe('26.10–27.9')
    expect(v.months).toHaveLength(12)
    expect(v.by['京东白条']).toEqual([40000, 20000, ...z(10)])
    expect(v.by['花呗']).toEqual([10000, ...z(11)])
    // 拼多多一分不欠：不占图例
    expect(v.o!.legend.data).toEqual(['京东白条', '花呗'])
    expect(v.tiles).toEqual({ '未来 12 个月合计': '¥700.00', '最重：10月': '¥500.00' })
  })

  it('10/25 还京东 600、10/26 再看：京东三期全被顶掉（11/17 那期是提前还的），只剩花呗 10/1 逾期的 100 滚进 11/1', () => {
    // 变异：每期按全额算、不扣已还的（due.amount 代替 due.amount − paid）→ 京东 11 月还挂着 200，红
    const v = view(input([...ledger(), repay('2026-10-25', 600, 'jd')], '2026-10-26'))
    expect(v.ch.span).toBe('26.11–27.10')
    expect(v.o!.legend.data).toEqual(['花呗'])
    expect(v.by['花呗']).toEqual([10000, ...z(11)])
    expect(v.tiles).toEqual({ '未来 12 个月合计': '¥100.00', '最重：11月': '¥100.00' })
  })

  it('拼多多 8/15 下的单一直没结清，9/20 看：它是「现在就欠着」，算 9 月，于是从 9 月起', () => {
    // 变异：没有还款日的也按下单日归月（payBy 返回 row.due.date）→ 落在 8 月、跑出 12 个月之外，红
    // 变异：起点恒为下个月 → 这 80 块被挤到「12 个月以后」，红
    const v = view(input([...ledger(), buy('2026-08-15', 80, 'pdd')], '2026-09-20'))
    expect(v.ch.span).toBe('26.9–27.8')
    expect(v.by['拼多多']).toEqual([8000, ...z(11)])
    expect(v.by['京东白条']).toEqual([0, 40000, 20000, ...z(9)])
    expect(v.tiles['12 个月以后']).toBeUndefined()
  })

  it('勾选结清优先于往前顶：9/19 还 100 指名结清当天那单 → 9/1 那单的 300 一分没少，整笔在 10 月', () => {
    // 9/1 京东下单 300（9/17 到期，逾期 → 滚进 10/17）；9/19 还 100 并勾选结清 9/19 下的那单 100。
    // 那单下在本期还过款之后，平台算下下期（11/17）——勾选结清的就是它，所以 11 月是空的。
    // 变异：creditBill 前把 settles 抹掉（不认勾选结清，钱只能往前顶）→ 10 月 200、11 月 100，红
    const late = buy('2026-09-19', 100, 'jd')
    const txs = [buy('2026-09-01', 300, 'jd'), late, repay('2026-09-19', 100, 'jd', { settles: [late.id] })]
    const v = view(input(txs, '2026-09-20'))
    expect(v.by['京东白条']).toEqual([30000, ...z(11)])
  })

  it('京东 9/9 刚还完本期、当天又下单 500：平台算下一期（10/17），图上是 10 月而不是 9 月', () => {
    // 变异：creditBill 拿到的账户把 defer_after_repay 关掉（不认「还过款之后下的单归下一期」）→ 9 月冒出 500、从 9 月起，红
    const txs = [buy('2026-08-20', 300, 'jd'), repay('2026-09-09', 300, 'jd'), buy('2026-09-09', 500, 'jd')]
    const v = view(input(txs, '2026-09-12'))
    expect(v.ch.span).toBe('26.10–27.9')
    expect(v.by['京东白条']).toEqual([50000, ...z(11)])
  })

  it('24 期分期：9/10 看，9 月起 12 期画在图上（1200），后 12 期单独一格「12 个月以后」，一分不藏', () => {
    // 变异：12 个月之外的直接丢掉（不加进 beyond）→ 少一格，红
    const v = view(input([buy('2026-09-01', 2400, 'jd', { installments: 24 })], '2026-09-10'))
    expect(v.ch.span).toBe('26.9–27.8')
    expect(v.by['京东白条']).toEqual(Array.from({ length: 12 }, () => 10000))
    // 12 个月一样重：取最早那个月。变异：比较写成 `>=`（一样重取最晚）→ 「8月」，红
    expect(v.tiles).toEqual({ '未来 12 个月合计': '¥1,200.00', '最重：9月': '¥100.00', '12 个月以后': '¥1,200.00' })
  })
})

describe('什么时候不画', () => {
  it('没有白条账户 → 「还没有白条账户」；区间照写，说明以句号结尾', () => {
    // 变异：去掉 credits.length 判断 → 落到「没有要还的」那句，红
    const ch = creditPlanChart({ ...input([buy('2026-09-02', 100, 'boc')], '2026-09-20'), accounts: [boc] })
    expect(ch.option).toBeNull()
    expect(ch.empty).toBe('还没有白条账户')
    expect(ch.span).toBeTruthy()
    expect(ch.note.endsWith('。')).toBe(true)
  })

  it('有白条但全还清了（多还了也一样）→ 一句话、没有小方块', () => {
    // 变异：去掉「全为 0」的判断 → 画一张空柱图，红
    const ch = creditPlanChart(input([buy('2026-08-05', 300, 'jd'), repay('2026-08-10', 500, 'jd')], '2026-09-20'))
    expect(ch.option).toBeNull()
    expect(ch.empty).toBe('往后 12 个月白条没有要还的')
    expect(ch.tiles).toBeUndefined()
  })
})

describe('样子', () => {
  it('提示框：10 月写京东 ¥400.00、花呗 ¥100.00、合计 ¥500.00；没东西的月份写「没有要还的」', () => {
    // 变异：合计取 ps[0].value（只有第一家）→ 红
    const v = view(input(ledger(), '2026-09-20'))
    const ps = (i: number) => v.o!.series.map((s) => ({ dataIndex: i, marker: '', seriesName: s.name, value: s.data[i] }))
    const oct = v.o!.tooltip.formatter(ps(0))
    for (const want of ['2026年10月', '京东白条', '¥400.00', '花呗', '¥100.00', '合计', '¥500.00']) expect(oct).toContain(want)
    expect(v.o!.tooltip.formatter(ps(5))).toContain('没有要还的')
  })

  it('账户名里带尖括号（「<Steam>分期」）：提示框里原样显示，不被浏览器当成标签吞掉', () => {
    // 变异：seriesName 不过 esc() → 「<Steam>」原样进了 HTML，红
    const steam = A('steam', '<Steam>分期', 'credit', 8, 1)
    const v = view({ ...input([buy('2026-09-10', 100, 'steam')], '2026-09-20'), accounts: [...accounts, steam] })
    const tip = v.o!.tooltip.formatter(v.o!.series.map((s) => ({ dataIndex: 0, marker: '', seriesName: s.name, value: s.data[0] })))
    expect(tip).toContain('&lt;Steam&gt;分期')
    expect(tip).not.toContain('<Steam>')
  })

  it('小方块不截断：「最重的一个月」把月份挪进标签（「最重：10月」），值只放金额', () => {
    // 手机上一格一百来 px，「10月 ¥12,345.00」塞在值里会被截成「10月 ¥12,3…」（审阅 #12）。
    // 变异：月份写回值里（`${月}月 ${金额}`）→ 红
    const v = view(input([buy('2026-09-01', 12345, 'jd')], '2026-09-20'))
    const t = v.ch.tiles!.find((x) => x.label.startsWith('最重'))!
    expect(t).toEqual({ label: '最重：10月', value: '¥12,345.00' })
  })

  it('入场动画：一根柱子里各段接力长（上一段长完下一段才开始），缓动 linear，同统计页的堆叠柱', () => {
    // 变异：去掉 animationDelay（各段同时长，ECharts 默认）→ 红
    const v = view(input(ledger(), '2026-09-20'))
    const [a, b] = v.o!.series
    expect(a.animationEasing).toBe('linear')
    expect(a.animationDelay(0)).toBe(0)
    // 10 月：京东 400 在下、花呗 100 在上，总 500
    expect(a.animationDelay(0) + a.animationDuration(0)).toBeCloseTo(b.animationDelay(0))
    expect(b.animationDelay(0) + b.animationDuration(0)).toBeCloseTo(620)
    expect(a.stack).toBe(b.stack)
  })

  it('配色：不传品牌色用深焦糖的同色系，按整张白条表发——花呗这 12 个月没数被筛掉，拼多多的颜色不跟着挪', () => {
    // 变异：先筛掉没数的再发色 → 拼多多拿到花呗那一档，红
    const txs = [buy('2026-09-01', 600, 'jd', { installments: 3 }), buy('2026-09-15', 80, 'pdd')]
    const v = view(input(txs, '2026-09-20'))
    expect(v.o!.legend.data).toEqual(['京东白条', '拼多多'])
    const ramp = fallbackColors(CHART.brandInk, 3)
    expect(v.o!.color).toEqual([ramp[0], ramp[2]])
  })

  it('配色：传品牌色（页面传 accountColor）时京东和拼多多（都是红）堆在一起也分得开，京东还是京东红', () => {
    // 变异：creditPlanChart 不把 colorOf 往下传（恒用兜底色）→ 红
    const txs = [buy('2026-09-01', 600, 'jd', { installments: 3 }), buy('2026-09-15', 80, 'pdd')]
    const cs = (creditPlanChart(input(txs, '2026-09-20'), { colorOf: accountColor }).option as unknown as Opt).color
    expect(cs[0]).toBe(accountColor('京东白条'))
    expect(tooClose(cs[0], cs[1])).toBe(false)
  })
})

// ---------- 不变量：随机账本 ----------

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

describe('不变量（随机账本 × 200 × 每份 8 个抽查日）', () => {
  it('图上 12 个月 + 12 个月以后 ≡ 各家白条欠款之和（按余额定义现算）；有还款日的，本期那个月 ≡ 面板上的「本期该还」；起点是这个月或下个月', () => {
    // 变异：每期按全额算、不扣已还的 → 红
    // 变异：逾期的按它自己的到期日归月 → 逾期那部分掉到窗口之前（算进「以后」也对不上本期该还），红
    // 变异：12 个月之外的直接丢掉 → 红
    // 变异：creditBill 前抹掉 settles（不认勾选结清）→ 红；把账户的 defer_after_repay 关掉 → 红
    const x31 = A('x31', '月付', 'credit', 8, 31)
    const credits = [jd, hb, pdd, x31]
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed)
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]
      const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1))
      const txs: Transaction[] = []
      const buys: Transaction[] = []
      for (let i = 0; i < int(2, 12); i++) {
        const t = buy(addDays('2026-01-05', int(0, 240)), 0, pick(credits).id, { amount: int(1, 300000), installments: r() < 0.4 ? pick([3, 6, 12, 24]) : null })
        buys.push(t)
        txs.push(t)
      }
      // 还款：一部分指名结清某一单（只对一次还清的单，金额不少于那单）；白条上不记退款和校准——
      // 那两样动余额却不进账单的还款池，「未还 ≡ 欠款」这条等式本来就不管它们
      const settled = new Set<string>()
      for (let i = 0; i < int(0, 6); i++) {
        const single = buys.filter((b) => (b.installments ?? 1) === 1 && !settled.has(b.id))
        const target = single.length && r() < 0.35 ? pick(single) : null
        if (target) settled.add(target.id)
        const to = target ? target.account_id! : pick(credits).id
        txs.push(repay(addDays('2026-01-05', int(0, 300)), 0, to, { amount: target ? target.amount + int(0, 3000) : int(1, 250000), settles: target ? [target.id] : null }))
      }
      txs.push(buy(addDays('2026-01-05', int(0, 300)), 0, 'boc', { amount: int(1, 9999) }))
      for (let k = 0; k < 8; k++) {
        const today = addDays('2026-01-05', int(0, 420))
        const P = creditPlan(txs, credits, today)
        const bad = (msg: string) => expect.fail(`seed=${seed} 今天=${today}：${msg}`)
        const cur = monthOf(today)
        if (P.months[0] !== cur && P.months[0] !== shiftMonth(cur, 1)) bad(`起点 ${P.months[0]}`)
        const drawn = P.total.reduce((s, v) => s + v, 0)
        const bal = balances(txs, credits)
        const owed = credits.reduce((s, a) => s + Math.max(0, -bal[a.id]), 0)
        if (drawn + P.beyond !== owed) bad(`图上 ${drawn} + 以后 ${P.beyond} ≠ 欠款 ${owed}`)
        for (const row of P.byAccount) {
          if (row.data.some((v) => v < 0)) bad(`${row.account.name} 有负数`)
          if (row.account.repay_day === null) continue
          const due = currentDueDate(today, row.account.repay_day)!
          const left = creditBill(txs, row.account, today).left
          const i = P.months.indexOf(monthOf(due))
          const got = i < 0 ? 0 : row.data[i]
          if (got !== left) bad(`${row.account.name} 本期（${due}）图上 ${got} ≠ 本期该还 ${left}`)
        }
      }
    }
  })
})

describe('源码', () => {
  it('不写死颜色、不看 hidden、不碰 store / api / facade / components；到期日不自己算（不用 dueDateOf / installmentPlan）', () => {
    // 变异：creditplan.ts 里 import dueDateOf 自己排期 → 红
    const src = readFileSync(new URL('./creditplan.ts', import.meta.url), 'utf8')
    expect(src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([])
    expect(src).not.toMatch(/\.hidden\b/)
    expect(src).not.toMatch(/from '\.\.\/(store|api|supabase|facade)'/)
    expect(src).not.toMatch(/^import[^\n]*['"][./]*\/?components\//m)
    expect(src).not.toMatch(/\b(dueDateOf|installmentPlan|paidThisCycle)\b/)
  })
})
