// 里外页面的纯逻辑。
//
// 这一层守的是三条不能破的规矩：
//   一、白条永远不参与修饰——欠款两边一样，这是用户 2026-09-07 拍板的；
//   二、里模式必须原样返回，一分钱都不能动；
//   三、外模式只平移，不改形状——统计页那条余额曲线的涨跌和拐点全是真的。
import { describe, expect, it } from 'vitest'
import { applyFacade, facadeShift, normalizeOffset, offsetFor, offsetOf, shiftSeries } from './facade'
import type { Account } from '../types'

const acc = (id: string, kind: Account['kind'], facade_offset: number | null = null): Account => ({
  id,
  name: id,
  kind,
  sort: 1,
  is_archived: false,
  repay_day: null,
  facade_offset,
})

const boc = acc('boc', 'bank', -216326) // 真实 4163.26 → 外面 2000.00
const cmb = acc('cmb', 'bank', -134874) // 真实 2148.74 → 外面 800.00
const wx = acc('wx', 'wallet') // 没设过，里外一样
const jd = acc('jd', 'credit', -500000) // 白条，数据里就算带着偏移量也不能生效
const ALL = [boc, cmb, wx, jd]
const BAL = { boc: 416326, cmb: 214874, wx: 184, jd: -8177 }

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
