import { describe, expect, it } from 'vitest'
import { categoryColor, childColors, childShade, hexToHsl } from './palette'

/** 两个颜色在 RGB 空间的距离。粗糙但够用：肉眼能分辨大约要 40 以上 */
function dist(a: string, b: string): number {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const [x, y] = [p(a), p(b)]
  return Math.sqrt(x.reduce((s, v, i) => s + (v - y[i]) ** 2, 0))
}

const ROOTS = ['#f5a524', '#7c5cff', '#2f6fed', '#14b8a6', '#e5484d']

describe('二级分类配色', () => {
  it('每个都是合法的 6 位十六进制', () => {
    for (const n of [1, 2, 3, 6, 12]) {
      for (const c of childColors('#f5a524', n)) expect(c).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('只有一个二级时就用父色', () => {
    expect(childColors('#f5a524', 1)).toEqual(['#f5a524'])
  })

  it('相邻两片必须明显不同——原来只往白里兑，最后两片肉眼分不出', () => {
    // 旧写法 6 个二级时相邻只差 12% 的白（#fad291 vs #fbddac，距离约 27），
    // 卡在 60 是为了保证换算法时不会悄悄退回去
    for (const root of ROOTS) {
      for (const n of [2, 3, 4, 6, 8, 12]) {
        const cs = childColors(root, n)
        for (let i = 1; i < cs.length; i++) {
          expect(dist(cs[i - 1], cs[i]), `${root} n=${n} 第 ${i} 对`).toBeGreaterThan(60)
        }
      }
    }
  })

  it('全部互不相同', () => {
    for (const root of ROOTS) {
      const cs = childColors(root, 12)
      expect(new Set(cs).size).toBe(12)
    }
  })

  it('仍然留在父色那个色系里，不能变成另一种颜色', () => {
    for (const root of ROOTS) {
      const [h0] = hexToHsl(root)
      for (const c of childColors(root, 8)) {
        const [h] = hexToHsl(c)
        const delta = Math.min(Math.abs(h - h0), 360 - Math.abs(h - h0))
        expect(delta, `${root} -> ${c}`).toBeLessThanOrEqual(25)
      }
    }
  })

  it('深浅都要有：最暗和最亮之间拉得开', () => {
    for (const root of ROOTS) {
      const ls = childColors(root, 6).map((c) => hexToHsl(c)[2])
      expect(Math.max(...ls) - Math.min(...ls)).toBeGreaterThan(0.3)
    }
  })

  it('一级分类的颜色是固定的，和顺序无关', () => {
    expect(categoryColor('日常开支', 0)).toBe(categoryColor('日常开支', 5))
    expect(categoryColor('娱乐消费')).not.toBe(categoryColor('意外开支'))
  })

  it('没匹配到名字的按顺序取备用色，且会循环不会越界', () => {
    expect(categoryColor('新分类', 0)).toBe('#2f6fed')
    expect(categoryColor('新分类', 9)).toBe(categoryColor('新分类', 0))
  })
})

describe('流水行里二级分类的底色', () => {
  it('同一个二级分类的底色永远不变（按 sort 取，不随出现顺序变）', () => {
    expect(childShade('#f5a524', 3)).toBe(childShade('#f5a524', 3))
  })

  it('同一大类下相邻的两个二级底色不同，连着几行才不会糊成一片', () => {
    const shades = [1, 2, 3, 4, 5, 6].map((s) => childShade('#f5a524', s))
    expect(new Set(shades).size).toBe(6)
  })

  it('仍然是父色那个色系，一眼还能看出属于哪个大类', () => {
    const [h0] = hexToHsl('#2f6fed')
    for (const s of [1, 2, 3, 4, 5, 6]) {
      const [h] = hexToHsl(childShade('#2f6fed', s))
      expect(Math.min(Math.abs(h - h0), 360 - Math.abs(h - h0))).toBeLessThanOrEqual(25)
    }
  })

  it('sort 超出范围或为 0 也不会崩', () => {
    for (const s of [0, 7, 99, -3]) expect(childShade('#f5a524', s)).toMatch(/^#[0-9a-f]{6}$/)
  })
})
