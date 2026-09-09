// 里外页面的纯逻辑。
//
// 这一层守的是三条不能破的规矩：
//   一、白条永远不参与修饰——欠款两边一样，这是用户 2026-09-07 拍板的；
//   二、里模式必须原样返回，一分钱都不能动；
//   三、外模式只平移，不改形状——统计页那条余额曲线的涨跌和拐点全是真的；
//   四、外模式下被修饰账户的「余额校准」整条隐身，且曲线末点仍然等于账户页显示的那个数。
import { describe, expect, it } from 'vitest'
import { adjustTotals, applyFacade, facadeShift, isDecorated, normalizeOffset, offsetFor, offsetOf, shiftSeries, visibleTxs } from './facade'
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
