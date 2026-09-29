/// <reference types="node" />
// 资产结构变化。输入是「用户记了这些账，今天几号，时间段选的哪段，打开看到什么」；
// 随机账本按定义（每笔流水怎么动余额）现算月底余额，和图上逐点对账。
// 每条用例都先把实现改坏跑过一次，确认它会红（注释里的「变异：… → 红」）。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { accountColor } from '../../components/AccountIcon'
import type { Account, Transaction } from '../../types'
import { addDays, monthRange } from '../date'
import { CHART } from '../palette'
import { fallbackColors, tooClose } from './acctcolor'
import { assetsChart, assetsSeries } from './assets'
import type { MoreChart, MoreInput } from './types'

const A = (id: string, name: string, kind: Account['kind'], sort: number): Account => ({
  id, name, kind, sort, is_archived: false, repay_day: kind === 'credit' ? 17 : null, defer_after_repay: null, facade_offset: null,
})
// 支付宝排在第二、而且一直是 0：它被筛掉时后面几个账户的颜色不能跟着挪
const boc = A('boc', '中国银行', 'bank', 1)
const zfb = A('zfb', '支付宝', 'wallet', 2)
const cmb = A('cmb', '招商银行', 'bank', 3)
const wx = A('wx', '微信', 'wallet', 4)
const jd = A('jd', '京东白条', 'credit', 5)
const ACCOUNTS = [boc, zfb, cmb, wx, jd]

let seq = 0
function tx(date: string, type: Transaction['type'], yuan: number, account_id: string | null, over: Partial<Transaction> = {}): Transaction {
  seq++
  return {
    id: `a${seq}`, date, type, amount: Math.round(yuan * 100), account_id, to_account_id: null, category_id: null, note: null,
    installments: null, settles: null, hidden: null, created_at: '2026-06-01T00:00:00.000Z', ...over,
  }
}

/**
 * 从 6 月开始记。今天 9/28，时间段 7/1 – 今天。
 *   6/10 中行工资 1 万（区间之前，余额照样从头累计）
 *   7/5  微信花 200（微信透支到 −200）；7/10 中行工资 1 万
 *   8/1  中行转微信 1000；8/3 京东白条买 500；8/17 中行还京东 300（白条还欠 200，不该出现在这张图上）；8/20 微信校准 −50
 *   8/31 招行进账 3000（算 8 月底）；9/1 招行花 100（算 9 月底）
 *   9/30 中行预记一笔 400（今天之后、月底之前：月底那一点算它，和统计页「总资产」一样按月底取）
 */
const BOOK: Transaction[] = [
  tx('2026-06-10', 'income', 10000, 'boc'),
  tx('2026-07-05', 'expense', 200, 'wx'),
  tx('2026-07-10', 'income', 10000, 'boc'),
  tx('2026-08-01', 'transfer', 1000, 'boc', { to_account_id: 'wx' }),
  tx('2026-08-03', 'expense', 500, 'jd'),
  tx('2026-08-17', 'transfer', 300, 'boc', { to_account_id: 'jd' }),
  tx('2026-08-20', 'adjust', -50, 'wx'),
  tx('2026-08-31', 'income', 3000, 'cmb'),
  tx('2026-09-01', 'expense', 100, 'cmb'),
  tx('2026-09-30', 'expense', 400, 'boc'),
]
const TODAY = '2026-09-28'
const input = (txs: Transaction[], over: Partial<MoreInput> = {}): MoreInput => ({
  txs, accounts: ACCOUNTS, cats: [], ym: '2026-09', start: '2026-07-01', end: TODAY, today: TODAY, ...over,
})

type Series = { name: string; type: string; stack: string; data: number[] }
type Opt = {
  color: string[]
  legend: { data: string[] }
  xAxis: { data: string[] }
  series: Series[]
  tooltip: { formatter: (ps: { dataIndex: number; marker: string; seriesName: string; value: number }[]) => string }
}
const opt = (c: MoreChart) => c.option as unknown as Opt
const tip = (c: MoreChart, i: number) => opt(c).tooltip.formatter(opt(c).series.map((s) => ({ dataIndex: i, marker: '', seriesName: s.name, value: s.data[i] })))

describe('今天 9/28，时间段 7 月到今天', () => {
  const c = assetsChart(input(BOOK))

  it('三个月底各资产账户的余额叠起来；白条不在里面，一直是 0 的支付宝不占图例', () => {
    // 变异：不分资产 / 白条（传 inp.accounts 全部）→ 京东白条出现，红
    // 变异：去掉「一直是 0 的不画」那道筛 → 支付宝出现，红
    expect(c.key).toBe('assets')
    expect(c.title).toBe('资产结构变化')
    expect(c.span).toBe('26.7–26.9')
    expect(opt(c).xAxis.data).toEqual(['26.7', '26.8', '26.9'])
    expect(opt(c).legend.data).toEqual(['中国银行', '招商银行', '微信'])
    const by = Object.fromEntries(opt(c).series.map((s) => [s.name, s.data]))
    // 单位是分
    expect(by['中国银行']).toEqual([2000000, 1870000, 1830000])
    expect(by['招商银行']).toEqual([0, 300000, 290000])
    expect(by['微信']).toEqual([-20000, 75000, 75000])
    for (const s of opt(c).series) {
      expect(s.type).toBe('line')
      expect(s.stack).toBe('assets')
    }
  })

  it('微信 7 月底透支 −200：照画负数，不抹成 0；说明里写着负的怎么画', () => {
    // 变异：数据里 Math.max(0, v)（把透支抹平）→ 红
    expect(opt(c).series.find((s) => s.name === '微信')!.data[0]).toBe(-20000)
    expect(c.note).toMatch(/为负/)
  })

  it('提示框：7 月底，微信写 -¥200.00，合计是加减之后的总资产 ¥19,800.00；带「再点一下看流水」', () => {
    // 变异：合计只加正的（Σ max(0, v)）→ ¥20,000.00，红
    const s = tip(c, 0)
    expect(s).toContain('2026年7月底')
    expect(s).toContain('-¥200.00')
    expect(s).toContain('合计')
    expect(s).toContain('¥19,800.00')
    expect(s).toContain('再点一下看流水')
    // 8 月底：18700 + 3000 + 750（京东欠的 200 不扣）
    expect(tip(c, 1)).toContain('¥22,450.00')
  })

  it('账户名里带尖括号（「<Steam>钱包」）：提示框里原样显示，不被浏览器当成标签吞掉', () => {
    // 变异：seriesName 不过 esc() → 「<Steam>」原样进了 HTML，红
    const steam = A('steam', '<Steam>钱包', 'wallet', 9)
    const s2 = assetsChart(input([...BOOK, tx('2026-07-02', 'income', 66, 'steam')], { accounts: [...ACCOUNTS, steam] }))
    const t = tip(s2, 0)
    expect(t).toContain('&lt;Steam&gt;钱包')
    expect(t).not.toContain('<Steam>')
  })

  it('点 8 月那一点 → 8 月的流水（带 cat=all 清掉上次的分类筛选）；越界不跳', () => {
    // 变异：onPoint 返回 keys[i + 1] → 红
    expect(c.onPoint!(1, 0)).toBe('ym=2026-08&cat=all')
    expect(c.onPoint!(3, 0)).toBeNull()
  })

  it('不传品牌色：用余额蓝的同色系，按整张资产账户表发色——支付宝被筛掉，招行和微信的颜色不跟着挪', () => {
    // 变异：先筛掉一直是 0 的再发色 → 招行拿到支付宝那一档，红
    const ramp = fallbackColors(CHART.balance, 4)
    expect(opt(c).color).toEqual([ramp[0], ramp[2], ramp[3]])
  })

  it('传品牌色（页面传 accountColor）：中行、招行都是红，堆在一起也分得开；微信还是微信绿', () => {
    // 变异：assetsChart 不把 colorOf 传给 assetsSeries（恒用兜底色）→ 红
    const cs = opt(assetsChart(input(BOOK), { colorOf: accountColor })).color
    expect(tooClose(cs[0], cs[1])).toBe(false)
    expect(cs[0]).toBe(accountColor('中国银行'))
    expect(cs[2]).toBe(accountColor('微信'))
  })
})

describe('别的时间段', () => {
  it('8/31 进的钱算 8 月底，9/1 花的算 9 月底（按月底取点，不是按月初）', () => {
    // 变异：bucketKeys 用 'day' 的口径去算余额（balanceSeries 传 'day'）→ 红
    const S = assetsSeries(input(BOOK, { start: '2026-08-01' }))
    const cmbRow = S.rows.find((r) => r.account.id === 'cmb')!
    expect(S.keys).toEqual(['2026-08', '2026-09'])
    expect(cmbRow.data).toEqual([300000, 290000])
  })

  it('只看本月：一个点画不出面积，换成一根堆叠柱', () => {
    // 变异：去掉「只有一个月换成柱子」→ 红
    const c = assetsChart(input(BOOK, { start: '2026-09-01' }))
    expect(opt(c).series.map((s) => s.type)).toEqual(['bar', 'bar', 'bar'])
    expect(opt(c).series.every((s) => s.stack === 'assets')).toBe(true)
  })

  it('只有白条账户 → 「还没有资产账户」；有资产账户但一笔账没有 → 另一句话；两种都不画图、区间照写', () => {
    // 变异：去掉 `!rows.length` 的判断 → 一笔账没有时画一张空图，红
    // 变异：去掉「没有资产账户」那句（落到下一句）→ 红
    const none = assetsChart(input(BOOK, { accounts: [jd] }))
    expect(none.option).toBeNull()
    expect(none.empty).toBe('还没有资产账户')
    const blank = assetsChart(input([]))
    expect(blank.option).toBeNull()
    expect(blank.empty).toBe('这段时间资产账户都没有余额')
    expect(blank.span).toBe('26.7–26.9')
    expect(blank.note.endsWith('。')).toBe(true)
    expect(blank.onPoint).toBeUndefined()
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

describe('不变量（随机账本 × 200）', () => {
  it('每个月底：每个账户的数 ≡ 按定义现算的余额；各账户之和 ≡ 提示框里的合计（总资产），白条一分不混进来', () => {
    // 变异：余额漏掉校准（applyTx 之外自己只数收支和转账）→ 红
    // 变异：合计用全部账户（含白条）的余额之和 → 红
    const assetIds = ['boc', 'zfb', 'cmb', 'wx']
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed)
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]
      const txs: Transaction[] = []
      for (let i = 0; i < 50; i++) {
        const d = addDays('2025-10-01', Math.floor(r() * 360))
        const k = r()
        const amount = 1 + Math.floor(r() * 300000)
        if (k < 0.35) txs.push(tx(d, 'expense', 0, pick([...assetIds, 'jd', null]), { amount }))
        else if (k < 0.6) txs.push(tx(d, 'income', 0, pick([...assetIds, 'jd', null]), { amount }))
        else if (k < 0.85) txs.push(tx(d, 'transfer', 0, pick([...assetIds, 'jd']), { amount, to_account_id: pick([...assetIds, 'jd']) }))
        else txs.push(tx(d, 'adjust', 0, pick([...assetIds, 'jd']), { amount: Math.floor(r() * 20000) - 10000 }))
      }
      const today = addDays('2026-01-15', Math.floor(r() * 250))
      const start = `${addDays(today, -Math.floor(r() * 300)).slice(0, 7)}-01`
      const c = assetsChart({ txs, accounts: ACCOUNTS, cats: [], ym: today.slice(0, 7), start, end: today, today })
      const effect = (t: Transaction, id: string): number => {
        if (t.type === 'transfer') return (t.to_account_id === id ? t.amount : 0) - (t.account_id === id ? t.amount : 0)
        if (t.account_id !== id) return 0
        return t.type === 'expense' ? -t.amount : t.amount
      }
      const S = assetsSeries({ txs, accounts: ACCOUNTS, start, end: today })
      if (!c.option) {
        if (S.rows.length) expect.fail(`seed ${seed}: 有余额却没画`)
        continue
      }
      const o = opt(c)
      S.keys.forEach((k, i) => {
        const end = monthRange(k).end
        const want = Object.fromEntries(assetIds.map((id) => [id, txs.filter((t) => t.date <= end).reduce((s, t) => s + effect(t, id), 0)]))
        for (const s of o.series) {
          const id = ACCOUNTS.find((a) => a.name === s.name)!.id
          if (id === 'jd') expect.fail(`seed ${seed}: 白条混进来了`)
          if (s.data[i] !== want[id]) expect.fail(`seed ${seed} ${k} ${s.name}: ${s.data[i]} ≠ ${want[id]}`)
        }
        const sum = assetIds.reduce((x, id) => x + want[id], 0)
        if (S.total[i] !== sum) expect.fail(`seed ${seed} ${k}: 合计 ${S.total[i]} ≠ ${sum}`)
        const drawn = o.series.reduce((x, s) => x + s.data[i], 0)
        if (drawn !== sum) expect.fail(`seed ${seed} ${k}: 叠起来 ${drawn} ≠ 总资产 ${sum}`)
      })
    }
  })
})

describe('源码', () => {
  it('不写死颜色、不看 hidden、不碰 store / api / facade / components', () => {
    // 变异：往 assets.ts 里加一行 `import { accountColor } from '../../components/AccountIcon'` → 红
    const src = readFileSync(new URL('./assets.ts', import.meta.url), 'utf8')
    expect(src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([])
    expect(src).not.toMatch(/\.hidden\b/)
    expect(src).not.toMatch(/from '\.\.\/(store|api|supabase|facade)'/)
    expect(src).not.toMatch(/^import[^\n]*['"][./]*\/?components\//m)
  })
})
