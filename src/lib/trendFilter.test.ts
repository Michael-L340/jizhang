import { describe, expect, it } from 'vitest'
import type { Transaction } from '../types'
import { CAP_PEAK, capSeries, dropBig, normalizeTrendFilter, parseYuanInt } from './trendFilter'

let n = 0
const tx = (o: Partial<Transaction>): Transaction => ({
  id: `t${++n}`, date: '2026-10-09', type: 'expense', amount: 100, account_id: 'wx', to_account_id: null, category_id: 'food',
  note: null, installments: null, settles: null, hidden: null, is_offset: null, created_at: '2026-10-09T01:00:00.000Z', ...o,
})

describe('不看大额单笔', () => {
  const txs = [tx({ amount: 3200 }), tx({ amount: 371200 }), tx({ type: 'income', amount: 800000 }), tx({ amount: 50000 }), tx({ amount: -29900, type: 'expense' })]

  it('只拿掉这一边、金额 ≥ 门槛的；门槛那一笔也算大额', () => {
    const r = dropBig(txs, 'expense', 50000)
    expect(r.count).toBe(2)
    expect(r.sum).toBe(421200)
    expect(r.txs.map((t) => t.amount)).toEqual([3200, 800000, -29900])
  })

  it('不开（≤0）或没有命中时原样返回同一个数组', () => {
    expect(dropBig(txs, 'expense', 0).txs).toBe(txs)
    expect(dropBig(txs, 'expense', 10000000).txs).toBe(txs)
    expect(dropBig(txs, 'income', 900000).count).toBe(0)
  })
})

describe('封顶', () => {
  it('超过的压到上限的九成多一点，纵轴上限 = 门槛，真实值留着', () => {
    const r = capSeries([120, 3712, 90, 1000], 1000)
    expect(r.max).toBe(1000)
    expect([...r.over]).toEqual([1])
    expect(r.data).toEqual([120, 1000 * CAP_PEAK, 90, 1000])
    expect(r.real[1]).toBe(3712)
  })

  it('没有点超过、或不开时什么都不动', () => {
    const v = [1, 2, 3]
    expect(capSeries(v, 5).data).toBe(v)
    expect(capSeries(v, 5).max).toBeUndefined()
    expect(capSeries(v, 0).max).toBeUndefined()
  })
})

describe('输入与存储', () => {
  it('金额只收正整数', () => {
    expect(parseYuanInt('500')).toBe(500)
    expect(parseYuanInt(' 12 ')).toBe(12)
    for (const s of ['', '0', '-3', '1.5', 'abc']) expect(parseYuanInt(s)).toBeNull()
  })

  it('旧值缺字段或填坏了，补成默认', () => {
    expect(normalizeTrendFilter(null)).toEqual({ big: false, bigYuan: 500, cap: false, capYuan: 1000 })
    expect(normalizeTrendFilter({ big: true, bigYuan: 0, cap: 'yes', capYuan: 2000 })).toEqual({ big: true, bigYuan: 500, cap: false, capYuan: 2000 })
    expect(normalizeTrendFilter({ big: 1, cap: true }).big).toBe(false) // 只认真正的 true
  })
})
