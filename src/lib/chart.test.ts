import { describe, expect, it } from 'vitest'
import { axisLabels, gridTopFor, LEGEND, legendRows, shortLabels, textWidth } from './chart'

describe('textWidth', () => {
  it('中文按一个字宽算', () => {
    expect(textWidth('日常开支', 11)).toBe(44)
  })
  it('数字和字母按半个多字宽算，比同样长度的中文窄', () => {
    expect(textWidth('abcd', 11)).toBeLessThan(textWidth('日常开支', 11))
  })
  it('空串是 0', () => {
    expect(textWidth('', 11)).toBe(0)
  })
})

describe('legendRows', () => {
  it('没有图例项就是 0 行', () => {
    expect(legendRows([], 320)).toBe(0)
  })
  it('放得下就一行', () => {
    expect(legendRows(['微信', '支付宝'], 320)).toBe(1)
  })
  it('五个一级分类在手机宽度下要两行（截图里那个场景）', () => {
    const names = ['非经常生活消费', '日常开支', '经常生活开支', '娱乐消费', '意外开支']
    expect(legendRows(names, 329)).toBe(2)
  })
  it('宽度够大时同样五项只要一行', () => {
    const names = ['非经常生活消费', '日常开支', '经常生活开支', '娱乐消费', '意外开支']
    expect(legendRows(names, 1000)).toBe(1)
  })
  it('一项比整行还长也算一行，不会返回 0', () => {
    expect(legendRows(['特别特别特别长的一个分类名字'], 50)).toBe(1)
  })
  it('每多一项就可能多一行：逐项加宽时行数只增不减', () => {
    const names = ['甲类', '乙类', '丙类', '丁类', '戊类', '己类', '庚类', '辛类']
    const rows = names.map((_, i) => legendRows(names.slice(0, i + 1), 200))
    expect(rows).toEqual([...rows].sort((a, b) => a - b))
  })
  it('项间距算进去了：间距变大时行数不会变少', () => {
    const names = ['甲类', '乙类', '丙类', '丁类']
    const tight = legendRows(names, 200, { ...LEGEND, itemGap: 0 })
    const loose = legendRows(names, 200, { ...LEGEND, itemGap: 40 })
    expect(loose).toBeGreaterThan(tight)
  })
})

describe('gridTopFor', () => {
  it('没有图例时留 16', () => {
    expect(gridTopFor(0)).toBe(16)
  })
  it('两行比一行高出一行的量', () => {
    expect(gridTopFor(2) - gridTopFor(1)).toBe(17)
  })
})

describe('x 轴标签的降级链', () => {
  const months = (n: number, from = 10, year = 25) =>
    Array.from({ length: n }, (_, i) => {
      const m = from + i
      return `20${year + Math.floor((m - 1) / 12)}-${String(((m - 1) % 12) + 1).padStart(2, '0')}`
    })
  const shownText = (r: { show: boolean[]; text: string[] }) => r.text.filter((_, i) => r.show[i])

  it('年份永远带着，一个都不省', () => {
    const r = axisLabels(months(3, 7), 'month', 260)
    expect(r.text).toEqual(['25.7', '25.8', '25.9'])
    expect(r.show).toEqual([true, true, true])
  })

  it('近一年按月：全标装不下（25.10 就有 27.5px，一格只有 22px），降到每季度', () => {
    const keys = months(12)
    expect(keys[0]).toBe('2025-10')
    expect(keys[11]).toBe('2026-09')
    const r = axisLabels(keys, 'month', 264)
    expect(shownText(r)).toEqual(['25.10', '26.1', '26.4', '26.7'])
  })

  it('宽度够的时候还是全标——降级只在挤不下时发生', () => {
    expect(axisLabels(months(12), 'month', 1200).show.every(Boolean)).toBe(true)
  })

  it('五年按月：季度也挤，降到每半年，也就是每年的 1 月和 7 月', () => {
    const r = axisLabels(months(60), 'month', 264)
    expect(shownText(r).slice(0, 4)).toEqual(['26.1', '26.7', '27.1', '27.7'])
    expect(shownText(r).every((x) => x.endsWith('.1') || x.endsWith('.7'))).toBe(true)
  })

  it('按日短区间：全标；再密一点就隔天标', () => {
    const d = (n: number) => Array.from({ length: n }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`)
    expect(axisLabels(d(6), 'day', 264).show.every(Boolean)).toBe(true)
    const r = axisLabels(d(12), 'day', 264)
    expect(r.show.filter(Boolean).length).toBeLessThan(12)
    expect(r.text[0]).toBe('26/9/1')
  })

  it('按日跨月：降到只标每月 1 号', () => {
    const days: string[] = []
    for (const [m, n] of [['07', 31], ['08', 31], ['09', 8]] as const) {
      for (let i = 1; i <= n; i++) days.push(`2026-${m}-${String(i).padStart(2, '0')}`)
    }
    expect(shownText(axisLabels(days, 'day', 264))).toEqual(['26/7/1', '26/8/1', '26/9/1'])
  })

  it('降到某一级只剩不到两个标签就停住，不能一个刻度都不剩', () => {
    // 三个月里只有一个 1 月，再往下降就没刻度了
    const r = axisLabels(months(3, 12), 'month', 20)
    expect(r.show.filter(Boolean).length).toBeGreaterThanOrEqual(2)
  })

  it('一个桶或零个桶不做降级', () => {
    expect(axisLabels([], 'month', 264)).toEqual({ show: [], text: [] })
    expect(axisLabels(['2026-09'], 'month', 264).show).toEqual([true])
  })
})

describe('图例缩写', () => {
  it('剥掉通用后缀，剩下区别性的那几个字', () => {
    expect(shortLabels(['非经常生活消费', '日常开支', '经常生活开支', '娱乐消费', '意外开支', '日均消费'])).toEqual([
      '非经常',
      '日常',
      '经常',
      '娱乐',
      '意外',
      '日均',
    ])
  })

  it('缩到两个字就停，不会把「日常开支」剥成空的', () => {
    expect(shortLabels(['日常开支'])).toEqual(['日常'])
    expect(shortLabels(['开支'])).toEqual(['开支'])
  })

  it('没有通用后缀的原样返回', () => {
    expect(shortLabels(['工资/实习', '未分类'])).toEqual(['工资/实习', '未分类'])
  })

  it('撞名就整组回退用原名——图例里两个一样的名字比长名字糟得多', () => {
    expect(shortLabels(['日常开支', '日常消费'])).toEqual(['日常开支', '日常消费'])
  })

  it('缩写之后正好从两行变一行', () => {
    const full = ['非经常生活消费', '日常开支', '经常生活开支', '娱乐消费', '意外开支', '日均消费']
    expect(legendRows(full, 329)).toBe(2)
    expect(legendRows(shortLabels(full), 329)).toBe(1)
  })
})
