import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Transaction } from '../types'
import { CAP_PEAK, capAxis, capSeries, capStack, dropBig, layoutPeaks, normalizeTrendFilter, parseYuanInt, peakText, trendGeometry, type Peak } from './trendFilter'

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
  it('超过的压到门槛（顶到门槛那条线），真实值留着；没超过的原样', () => {
    const r = capSeries([120, 3712, 90, 1000], 1000)
    expect([...r.over]).toEqual([1])
    expect(r.data).toEqual([120, 1000, 90, 1000])
    expect(r.real[1]).toBe(3712)
  })

  it('被压的尖永远不比没被压的矮：761 对门槛 800，被压的 3,912 不能画得比 761 低（用户 2026-10-26 看原型时的「更挤一点」）', () => {
    // 变异：改回压到 门槛 × CAP_PEAK（744）→ 761 那天比被压的尖还高，红
    const r = capSeries([3911.99, 761.3, 40], 800)
    const peak = Math.min(...[...r.over].map((i) => r.data[i]))
    const others = Math.max(...r.data.filter((_, i) => !r.over.has(i)))
    expect(peak).toBeGreaterThanOrEqual(others)
    // 尖顶还是在纵轴的九成多一点，不冲顶
    expect(peak / capAxis(800).max).toBeCloseTo(CAP_PEAK, 2)
  })

  it('没有点超过、或不开时什么都不动', () => {
    const v = [1, 2, 3]
    expect(capSeries(v, 5).data).toBe(v)
    expect(capSeries(v, 5).over.size).toBe(0)
    expect(capSeries([1, 99], 0).over.size).toBe(0)
  })

  it('纵轴：最高 = 门槛 ÷ 0.93 取整；刻度间隔让门槛正好落在一条线上，凑不出好看的间隔就交给 ECharts', () => {
    // 变异：最高不取整 → 860.215…，红；间隔一律不给 → 门槛那条线没了，红
    expect(capAxis(800)).toEqual({ max: 860, interval: 200 })
    expect(capAxis(1000)).toEqual({ max: 1075, interval: 250 })
    expect(capAxis(500)).toEqual({ max: 538, interval: 100 })
    expect(capAxis(750)).toEqual({ max: 806, interval: 250 })
    expect(capAxis(999).interval).toBeUndefined()
    for (const cap of [100, 300, 500, 600, 750, 800, 1000, 1200, 1500, 2000, 3000, 5000]) {
      const { max, interval } = capAxis(cap)
      expect(Number.isInteger(max)).toBe(true)
      expect(interval).toBeDefined()
      const parts = cap / interval!
      if (Math.abs(parts - Math.round(parts)) > 1e-9 || parts < 2 || parts > 6) expect.fail(`门槛 ${cap} 分成了 ${parts} 格`)
    }
  })

  it('堆叠：合计超过门槛的柱子整根按同一个比例压到门槛，各段占比不变；没超过的原样', () => {
    // 变异：只压最上面一段 / 不压 → 合计不等于门槛或占比变了，红
    const r = capStack(
      [
        [3800, 30, 0],
        [111.99, 20, 900],
      ],
      800,
    )
    expect([...r.over]).toEqual([0, 2])
    expect(r.totals).toEqual([3911.99, 50, 900])
    expect(r.data[0][0] + r.data[1][0]).toBeCloseTo(800, 9)
    expect(r.data[0][0] / r.data[1][0]).toBeCloseTo(3800 / 111.99, 9)
    expect([r.data[0][1], r.data[1][1]]).toEqual([30, 20])
    expect(r.data[1][2]).toBeCloseTo(800, 9)
    const none = [[1, 2]]
    expect(capStack(none, 0).data).toBe(none)
  })
})

describe('封顶的尖顶数字（用户 2026-10-26：「尖尖，会重叠，看不清楚」）', () => {
  it('整数元、不带 ¥ 和角分，上万写「万」', () => {
    // 变异：改回 ▲¥3,911.99 → 红
    expect(peakText(3911.99)).toBe('▲3912')
    expect(peakText(1035.37)).toBe('▲1035')
    expect(peakText(800.4)).toBe('▲800')
    expect(peakText(12345)).toBe('▲1.2万')
  })

  // 假的量字：一个字 6px；绘图区 40–290，每天 10px
  const w6 = (s: string) => s.length * 6
  const xOf = (i: number) => 40 + i * 10
  const lay = (peaks: Peak[]) => layoutPeaks(peaks, xOf, 40, 290, w6)

  it('你截图那三个尖：最左那个往右写不压纵轴；10/12 和 10/14 挨得近，后一个错开到上面一行', () => {
    // 变异：只有一行（挤了就不标）→ 1336 没了，红；不往里收 → 最左那个 align 还是 center，红
    const r = lay([
      { i: 0, real: 3911.99, key: 't' },
      { i: 11, real: 1035.37, key: 't' },
      { i: 13, real: 1336.4, key: 't' },
    ])
    expect(r.map((l) => [l.text, l.row, l.align])).toEqual([
      ['▲3912', 0, 'left'],
      ['▲1035', 0, 'center'],
      ['▲1336', 1, 'center'],
    ])
  })

  it('最右边的往左写', () => {
    expect(lay([{ i: 25, real: 980, key: 't' }])[0].align).toBe('right')
  })

  it('同一天两条线都超了：大的在下面一行、小的错开；第三个两行都挤就不标（提示框里看）', () => {
    // 变异：同一天不按大小排 → 900 占了第一行，红；放不下照样标 → 多出一个叠在一起的，红
    const r = lay([
      { i: 21, real: 900, key: 'c1' },
      { i: 21, real: 980, key: 'c0' },
      { i: 22, real: 1100, key: 'c2' },
    ])
    expect(r.map((l) => [l.key, l.row])).toEqual([
      ['c0', 0],
      ['c1', 1],
    ])
  })

  it('任意一堆尖：同一行里的数字两两隔开至少 4px，都不出绘图区', () => {
    // 不变量：拿 300 组随机尖撞（固定种子，红了能复现）
    let seed = 42
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    for (let k = 0; k < 300; k++) {
      const peaks = Array.from({ length: 1 + Math.floor(rnd() * 12) }, (_, j) => ({ i: Math.floor(rnd() * 26), real: 800 + rnd() * 20000, key: `k${j}` }))
      const r = lay(peaks)
      for (const row of [0, 1]) {
        const boxes = r
          .filter((l) => l.row === row)
          .map((l) => {
            const w = w6(l.text)
            const x = xOf(l.i)
            return l.align === 'left' ? [x, x + w] : l.align === 'right' ? [x - w, x] : [x - w / 2, x + w / 2]
          })
          .sort((a, b) => a[0] - b[0])
        for (let m = 0; m < boxes.length; m++) {
          if (boxes[m][0] < 40 - 1e-9 || boxes[m][1] > 290 + 1e-9) expect.fail(`第 ${k} 组出了绘图区`)
          if (m && boxes[m][0] < boxes[m - 1][1] + 4 - 1e-9) expect.fail(`第 ${k} 组第 ${row} 行有两个数字挨得太近`)
        }
      }
    }
  })

  it('横坐标：折线头尾贴着绘图区两边，柱子在每格中间；绘图区左边让出纵轴刻度字和 8px 间距', () => {
    const line = trendGeometry(326, 26, false, 17)
    expect(line.plotL).toBe(4 + 17 + 8)
    expect(line.plotR).toBe(326 - 14)
    expect(line.xOf(0)).toBe(line.plotL)
    expect(line.xOf(25)).toBeCloseTo(line.plotR, 9)
    const bar = trendGeometry(326, 26, true, 17)
    const band = (bar.plotR - bar.plotL) / 26
    expect(bar.xOf(0)).toBeCloseTo(bar.plotL + band / 2, 9)
  })
})

describe('统计页接线（源码守卫）', () => {
  const src = readFileSync(new URL('../pages/Stats.tsx', import.meta.url), 'utf8')
  it('封顶不再只管「合计」：分类、堆叠也用封顶后的数，尖顶数字走 layoutPeaks；设置里不写「只对合计」', () => {
    // 变异：改回 tf.cap && lineMode === 'total' → 红；分类还画原始数据 → 红
    expect(src).not.toMatch(/tf\.cap && lineMode === 'total'/)
    expect(src).toContain('capCats[j].data.map(')
    expect(src).toContain('capBars.data[j].map(')
    expect(src).toContain('layoutPeaks(')
    expect(src).not.toContain('只对「合计」')
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
