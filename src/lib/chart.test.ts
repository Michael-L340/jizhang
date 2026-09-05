import { describe, expect, it } from 'vitest'
import { gridTopFor, LEGEND, legendRows, textWidth } from './chart'

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
