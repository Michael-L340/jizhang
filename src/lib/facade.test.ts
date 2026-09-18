// 里外页面的纯逻辑。
//
// 这一层守的是三条不能破的规矩：
//   一、白条永远不参与修饰——欠款两边一样，这是用户 2026-09-07 拍板的；
//   二、里模式必须原样返回，一分钱都不能动；
//   三、外模式只平移，不改形状——统计页那条余额曲线的涨跌和拐点全是真的；
//   四、外模式下被修饰账户的「余额校准」整条隐身，且曲线末点仍然等于账户页显示的那个数。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { adjustTotals, applyFacade, facadeShift, hiddenSummary, isDecorated, lastAdjustAt, normalizeOffset, offsetFor, offsetOf, outerTxs, shiftSeries, visibleTxs } from './facade'
import { balanceSeries, balances } from './compute'
import type { Account, Transaction } from '../types'

const acc = (id: string, kind: Account['kind'], facade_offset: number | null = null): Account => ({
  id,
  name: id,
  kind,
  sort: 1,
  is_archived: false,
  repay_day: null,
  facade_offset,
  defer_after_repay: null,
})

const boc = acc('boc', 'bank', -216326) // 真实 4163.26 → 外面 2000.00
const cmb = acc('cmb', 'bank', -134874) // 真实 2148.74 → 外面 800.00
const wx = acc('wx', 'wallet') // 没设过，里外一样
const jd = acc('jd', 'credit', -500000) // 白条，数据里就算带着偏移量也不能生效
const ALL = [boc, cmb, wx, jd]
const BAL = { boc: 416326, cmb: 214874, wx: 184, jd: -8177 }

const tx = (id: string, date: string, type: Transaction['type'], amount: number, account_id: string | null): Transaction => ({
  id,
  date,
  type,
  amount,
  account_id,
  to_account_id: null,
  category_id: null,
  note: null,
  installments: null,
  settles: null,
  hidden: null,
  created_at: `${date}T00:00:0${id.length}.000Z`,
})

describe('偏移量本身', () => {
  it('白条永远是 0，哪怕数据里写了值', () => {
    // 用户定的：白条不分里外。这里挡一道，免得数据脏了就漏出去
    expect(offsetOf(jd)).toBe(0)
    expect(offsetOf(boc)).toBe(-216326)
    expect(offsetOf(wx)).toBe(0)
  })

  it('由「外面显示多少」反推偏移量', () => {
    expect(offsetFor(80000, 214874)).toBe(-134874)
    expect(offsetFor(214874, 214874)).toBe(0)
    // 想让外面显示得比真实多也行
    expect(offsetFor(500000, 214874)).toBe(285126)
  })

  it('0 存成 null，不在数据库里留一堆没意义的 0', () => {
    expect(normalizeOffset(0)).toBe(null)
    expect(normalizeOffset(-134874)).toBe(-134874)
  })
})

describe('余额修饰', () => {
  it('里模式原样返回同一个对象，一分钱不动', () => {
    expect(applyFacade(BAL, ALL, 'inner')).toBe(BAL)
  })

  it('外模式给设过的账户加偏移量，没设的不动', () => {
    const out = applyFacade(BAL, ALL, 'outer')
    expect(out.boc).toBe(200000)
    expect(out.cmb).toBe(80000)
    expect(out.wx).toBe(184) // 没设过
    expect(out.jd).toBe(-8177) // 白条不动
    expect(BAL.boc).toBe(416326) // 不能改到入参头上
  })

  it('总资产 = 四张卡之和，这个等式在两边都成立', () => {
    for (const mode of ['inner', 'outer'] as const) {
      const b = applyFacade(BAL, ALL, mode)
      const assets = ALL.filter((a) => a.kind !== 'credit')
      const total = assets.reduce((s, a) => s + b[a.id], 0)
      expect(total).toBe(assets.reduce((s, a) => s + BAL[a.id as keyof typeof BAL], 0) + facadeShift(ALL, mode))
    }
  })

  it('平移总量只算非白条', () => {
    expect(facadeShift(ALL, 'outer')).toBe(-216326 - 134874)
    expect(facadeShift(ALL, 'inner')).toBe(0)
  })
})

describe('统计页的余额曲线', () => {
  const series = {
    total: [100000, 120000, 90000],
    byAccount: { boc: [60000, 70000, 50000], cmb: [39000, 49000, 39000], wx: [1000, 1000, 1000], jd: [0, 0, 0] },
  }

  it('里模式原样返回', () => {
    expect(shiftSeries(series, ALL, 'inner')).toBe(series)
  })

  it('外模式整条平移，形状（每一段的涨跌）完全不变', () => {
    const out = shiftSeries(series, ALL, 'outer')
    const diffs = (xs: number[]) => xs.slice(1).map((v, i) => v - xs[i])
    expect(diffs(out.total)).toEqual(diffs(series.total))
    expect(diffs(out.byAccount.boc)).toEqual(diffs(series.byAccount.boc))
    // 高度按各自的偏移量抬/落
    expect(out.byAccount.boc[0]).toBe(60000 - 216326)
    expect(out.byAccount.jd).toEqual([0, 0, 0]) // 白条不动
    expect(out.total[0]).toBe(100000 - 216326 - 134874)
  })

  it('不改到入参头上', () => {
    shiftSeries(series, ALL, 'outer')
    expect(series.byAccount.boc[0]).toBe(60000)
    expect(series.total[0]).toBe(100000)
  })
})

describe('外页面藏掉被修饰账户的校准', () => {
  // 2026-09-08 用户在首页截到的那一幕：支付宝余额显示 0.00，
  // 下面「最近流水」却挂着一条 +6,391.00 的余额校准。
  const txs = [
    tx('a', '2026-09-01', 'expense', 2090, 'boc'),
    tx('b', '2026-09-07', 'adjust', 639100, 'boc'), // 被修饰的账户
    tx('c', '2026-09-07', 'adjust', -1084, 'wx'), // 没修饰过，照常显示
    tx('d', '2026-09-07', 'adjust', 5000, 'jd'), // 白条不分里外，照常显示
  ]

  it('被修饰过 = 设过偏移量的资产账户；白条和没设过的都不算', () => {
    expect(isDecorated(boc)).toBe(true)
    expect(isDecorated(wx)).toBe(false)
    expect(isDecorated(jd)).toBe(false) // 白条哪怕数据里带着偏移量也不算
  })

  it('里模式原样返回同一个数组', () => {
    expect(visibleTxs(txs, ALL, 'inner')).toBe(txs)
  })

  it('外模式只藏被修饰账户的校准，别的一条不动', () => {
    expect(visibleTxs(txs, ALL, 'outer').map((t) => t.id)).toEqual(['a', 'c', 'd'])
  })

  it('一个账户都没修饰过时返回同一个数组，不做多余的拷贝', () => {
    expect(visibleTxs(txs, [wx, jd], 'outer')).toBe(txs)
  })

  it('校准合计只算被修饰的账户，同一个账户多笔要累加', () => {
    expect(adjustTotals(txs, ALL)).toEqual({ boc: 639100, cmb: 0 })
    expect(adjustTotals([...txs, tx('e', '2026-09-08', 'adjust', -100, 'boc')], ALL)).toEqual({ boc: 639000, cmb: 0 })
  })
})

describe('外页面的余额曲线：不能塌一整年', () => {
  // 真实场景：支付宝 9/7 之前余额是 0，那天在里页面校准 +6,391 变成 6,391，
  // 偏移量 −6,391 让外面继续显示 0.00。
  // 只平移不摘校准的话，外页面会看到 9/7 之前趴在 −6,391，那天弹回 0。
  const ali = acc('ali', 'wallet', -639100)
  const accounts = [ali]
  const txs = [tx('adj', '2026-09-07', 'adjust', 639100, 'ali')]
  const keys = ['2026-08', '2026-09']
  const curve = (mode: 'inner' | 'outer') =>
    shiftSeries(balanceSeries(visibleTxs(txs, accounts, mode), accounts, keys, 'month'), accounts, mode, adjustTotals(txs, accounts))

  it('外模式是平的 0，不是 −6,391 趴一年再弹回来', () => {
    expect(curve('outer').byAccount.ali).toEqual([0, 0])
    expect(curve('outer').total).toEqual([0, 0])
  })

  it('里模式是真实的那级台阶', () => {
    expect(curve('inner').byAccount.ali).toEqual([0, 639100])
  })

  it('曲线末点 = 账户页显示的那个数，两边都成立', () => {
    // 这条是整个改法的立足点：改完之后屏幕上现在那个 0.00 一个字都不能变，
    // 也就不用去动数据库里已经存好的偏移量。
    for (const mode of ['inner', 'outer'] as const) {
      const s = curve(mode)
      const shown = applyFacade(balances(txs, accounts), accounts, mode)
      expect(s.byAccount.ali[s.byAccount.ali.length - 1]).toBe(shown.ali)
      expect(s.total[s.total.length - 1]).toBe(shown.ali)
    }
  })
})

describe('账户页副标题「上次校准」：外页面下修饰过和没修饰过的账户必须长一样', () => {
  // 2026-09-16 用户截图：中国银行、支付宝（修饰过）显示「点此输入实际余额核对」，
  // 招行、微信（没修饰）显示「上次校准 9/3」。两种字并排，等于把哪两个动过手脚写在脸上。
  const adj = (id: string, account_id: string, created_at: string): Transaction => ({ ...tx(id, '2026-09-03', 'adjust', 100, account_id), created_at })
  const txs = [adj('a1', 'boc', '2026-09-03T12:15:00Z'), adj('a2', 'wx', '2026-09-03T12:02:00Z'), adj('a3', 'boc', '2026-09-01T00:00:00Z')]

  it('从原始流水取时间：修饰过的 boc 和没修饰的 wx 都有日期，取最近一次', () => {
    const m = lastAdjustAt(txs)
    expect(m.get('boc')).toBe('2026-09-03T12:15:00Z')
    expect(m.get('wx')).toBe('2026-09-03T12:02:00Z')
    expect(m.get('cmb')).toBeUndefined()
  })

  it('要是拿外页面的 visibleTxs 去算，boc 的日期就没了——这就是那个露馅点', () => {
    const m = lastAdjustAt(visibleTxs(txs, ALL, 'outer'))
    expect(m.get('boc')).toBeUndefined()
    expect(m.get('wx')).toBe('2026-09-03T12:02:00Z')
  })

  it('账户页必须把原始 txs 传给 lastAdjustAt，不能传 vtxs', () => {
    // 页面测不了（没有 DOM），守源码：改成 lastAdjustAt(vtxs) 这条会红
    const src = readFileSync(new URL('../pages/Accounts.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/lastAdjustAt\(txs\)/)
    expect(src).not.toMatch(/lastAdjustAt\(vtxs\)/)
  })
})

describe('「外面隐藏」：外页面当这一笔不存在', () => {
  // 用户 2026-09-16 最终口径：藏了的记录在外页面整条不算——列表、余额、曲线、统计都不算。
  // 第一版做成「只藏行、钱照算」，首页和流水页各出一个「本月支出」，对不上，当天推翻。
  const income = { ...tx('i1', '2026-09-10', 'income', 100000, 'wx'), hidden: true }
  const spend = tx('e1', '2026-09-11', 'expense', 3000, 'wx')
  const txs = [income, spend]

  it('外页面的账本里没有它；里页面原样；没藏任何一笔时返回同一个数组', () => {
    // 变异：outerTxs 去掉 mode 判断 → 里页面也被藏，红
    expect(outerTxs(txs, 'outer').map((t) => t.id)).toEqual(['e1'])
    expect(outerTxs(txs, 'inner')).toBe(txs)
    const one = [spend]
    expect(outerTxs(one, 'outer')).toBe(one)
  })

  it('外页面的余额不含它，里页面含', () => {
    // 变异：visibleTxs 不先过 outerTxs → 列表里出现藏掉的行；balances 那条由源码守卫兜
    expect(balances(outerTxs(txs, 'outer'), ALL).wx).toBe(-3000)
    expect(balances(outerTxs(txs, 'inner'), ALL).wx).toBe(97000)
    expect(visibleTxs(txs, ALL, 'outer').map((t) => t.id)).toEqual(['e1'])
  })

  it('不变量：随机藏一批、随机挑一天问，账户页显示的数 ≡ 曲线末点 ≡ 外页面看得见的记录之和 + 偏移量 + 藏掉的校准合计', () => {
    // 这一条同时守住三条路径（余额 / 曲线 / 列表）吃的是同一本账。
    // 固定种子 LCG，红了能复现。变异：让 applyFacade 那条路吃原始 txs（去掉 outerTxs）→ 红
    let seed = 20260916
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const days = Array.from({ length: 40 }, (_, i) => `2026-09-${String(1 + (i % 28)).padStart(2, '0')}`).sort()
    const ledger: Transaction[] = days.map((d, i) => {
      const kind = rnd()
      const acc = ['boc', 'cmb', 'wx'][i % 3]
      const t =
        kind < 0.5 ? tx(`t${i}`, d, 'expense', 100 + Math.floor(rnd() * 5000), acc)
        : kind < 0.8 ? tx(`t${i}`, d, 'income', 1000 + Math.floor(rnd() * 20000), acc)
        : kind < 0.9 ? { ...tx(`t${i}`, d, 'transfer', 500 + Math.floor(rnd() * 3000), acc), to_account_id: acc === 'boc' ? 'wx' : 'boc' }
        : tx(`t${i}`, d, 'adjust', Math.floor(rnd() * 8000) - 4000, acc)
      return rnd() < 0.3 ? { ...t, hidden: true } : t
    })
    expect(ledger.some((t) => t.hidden)).toBe(true)
    for (const mode of ['outer', 'inner'] as const) {
      for (const probe of ['2026-09-05', '2026-09-12', '2026-09-20', '2026-09-28']) {
        const upTo = ledger.filter((t) => t.date <= probe)
        const otxs = outerTxs(upTo, mode)
        const shown = applyFacade(balances(otxs, ALL), ALL, mode) // 账户页
        const keys = days.filter((d) => d <= probe)
        const curve = shiftSeries(balanceSeries(visibleTxs(upTo, ALL, mode), ALL, keys, 'day'), ALL, mode, adjustTotals(otxs, ALL)) // 统计页
        const listed = balances(visibleTxs(upTo, ALL, mode), ALL) // 列表里看得见的记录之和
        for (const a of [boc, cmb, wx]) {
          const last = curve.byAccount[a.id][curve.byAccount[a.id].length - 1]
          if (shown[a.id] !== last) expect.fail(`${mode} ${probe} ${a.id}：账户页 ${shown[a.id]} ≠ 曲线末点 ${last}`)
          const expect_ = listed[a.id] + (mode === 'outer' ? offsetOf(a) + (adjustTotals(otxs, ALL)[a.id] ?? 0) : 0)
          if (shown[a.id] !== expect_) expect.fail(`${mode} ${probe} ${a.id}：账户页 ${shown[a.id]} ≠ 列表之和+偏移+藏掉的校准 ${expect_}`)
        }
        // 外页面的余额 = 里页面的余额 − 藏掉的记录对该账户的影响（藏的钱确实不在外面）
        if (mode === 'outer') {
          const inner = balances(upTo, ALL)
          const hiddenOnly = balances(upTo.filter((t) => t.hidden), ALL)
          for (const a of [boc, cmb, wx]) {
            const got = shown[a.id] - offsetOf(a)
            if (got !== inner[a.id] - (hiddenOnly[a.id] ?? 0)) expect.fail(`${probe} ${a.id}：外 ${got} ≠ 里 ${inner[a.id]} − 藏 ${hiddenOnly[a.id]}`)
          }
        }
      }
    }
  })

  it('页面里算钱的地方一律不许吃原始 txs——只准吃 otxs / vtxs', () => {
    // 页面测不了（没有 DOM），守源码。第一版漏的正是这里：12 处调用各吃各的。
    // 变异：把 Home 的 monthSummary(otxs 改回 monthSummary(txs → 红
    const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
    const money = /(monthSummary|byCategory|balances|monthTotals|firstFlowDate|adjustTotals|seriesTotals|seriesByCategory|balanceSeries|searchTx)\(\s*txs\b/
    for (const p of ['../pages/Home.tsx', '../pages/Stats.tsx', '../pages/Ledger.tsx', '../pages/Accounts.tsx']) {
      const src = read(p)
      expect(src, `${p} 里有算钱的函数直接吃了原始 txs`).not.toMatch(money)
      expect(src, `${p} 必须建 otxs`).toMatch(/outerTxs\(txs, mode\)/)
    }
    expect(read('../pages/Home.tsx')).not.toMatch(/for \(const t of txs\)/) // 今日收支那个循环
    expect(read('../pages/Ledger.tsx')).toMatch(/g\.items\.map/) // 行不再单独过滤
    for (const p of ['./compute.ts', './chart.ts']) expect(read(p), `${p} 不该碰 hidden`).not.toMatch(/\.hidden/)
  })
})

describe('里页面校准弹层那行「外面看不到的 n 笔 −¥X」', () => {
  // 纯展示：把这个账户藏掉的记录加起来告诉用户，不进任何计算（用户 2026-09-18）
  const h1 = { ...tx('h1', '2026-09-10', 'income', 300000, 'boc'), hidden: true }
  const h2 = { ...tx('h2', '2026-09-12', 'expense', 50000, 'boc'), hidden: true }
  const h3 = { ...tx('h3', '2026-09-13', 'transfer', 20000, 'boc'), to_account_id: 'wx', hidden: true }
  const shown = tx('s1', '2026-09-11', 'income', 100000, 'boc')
  const txs = [h1, h2, h3, shown]

  it('按账户汇总影响和笔数，转账两头都算，没藏过的账户不出现', () => {
    // 变异：count 只数 account_id → wx 没了，红；cents 改成 amount 直接相加 → boc 符号错，红
    const s = hiddenSummary(txs, ALL)
    expect(s.boc).toEqual({ cents: 300000 - 50000 - 20000, count: 3 })
    expect(s.wx).toEqual({ cents: 20000, count: 1 })
    expect(s.cmb).toBeUndefined()
    expect(hiddenSummary([shown], ALL)).toEqual({})
  })

  it('这个数正好是「里页面余额 − 外页面账本余额」，两边口径一致', () => {
    const inner = balances(txs, ALL)
    const outer = balances(outerTxs(txs, 'outer'), ALL)
    expect(inner.boc - outer.boc).toBe(hiddenSummary(txs, ALL).boc.cents)
  })

  it('这行只在里页面出现：必须嵌在 showFacadeField（mode === inner）那一块里', () => {
    // 页面测不了，守源码。变异：把这行挪到 showFacadeField 那块外面 → 红
    const src = readFileSync(new URL('../pages/Accounts.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/const showFacadeField = mode === 'inner'/)
    // 找的是 JSX 里那一行（后面跟着 {hiddenSum），注释里提到这几个字不算
    const marker = '隐藏金额汇总 · {hiddenSum'
    const block = src.indexOf('{showFacadeField ? (')
    const line = src.indexOf(marker)
    const end = src.indexOf('\n        ) : null}', block) // showFacadeField 那块的收尾（8 格缩进）
    expect(block).toBeGreaterThan(0)
    expect(line).toBeGreaterThan(block)
    expect(line).toBeLessThan(end)
    expect(src.split(marker).length).toBe(2) // 只有这一处
  })
})
