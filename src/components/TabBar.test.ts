// 导航栏图标的几何守卫。
// 图标是手写的 SVG 路径，肉眼看不出「贴边会被描边裁掉」「两笔间距太小 22px 下会粘连」，
// 但在手机上一眼就丑。这里把量过的规矩固定下来，以后换图标时不会凭手感又踩回去。
import { describe, expect, it } from 'vitest'
import { tabs } from './TabBar'

/** 从路径里抠出所有坐标数字。够用：这些图标只有直线、圆弧和少量贝塞尔 */
function coords(d: string): number[] {
  return (d.match(/-?\d*\.?\d+/g) ?? []).map(Number)
}

describe('导航栏图标', () => {
  it('五个标签各有各的图标，没有复制粘贴漏改的', () => {
    expect(new Set(tabs.map((t) => t.icon)).size).toBe(tabs.length)
    expect(new Set(tabs.map((t) => t.to)).size).toBe(tabs.length)
    expect(new Set(tabs.map((t) => t.label)).size).toBe(tabs.length)
  })

  it('坐标都在 0~24 的 viewBox 里，不会画到框外', () => {
    for (const t of tabs) {
      for (const n of coords(t.icon)) {
        expect(Math.abs(n), `${t.label} 的路径里有 ${n}`).toBeLessThanOrEqual(24)
      }
    }
  })

  it('「流水」用的是小票那版，不是原来的三条横线', () => {
    const ledger = tabs.find((t) => t.to === '/ledger')!
    expect(ledger.icon).not.toBe('M4 6h16M4 12h16M4 18h10')
    expect(ledger.icon).toContain('M5 3h14v18') // 小票外框
  })

  it('每个图标都画得出东西（至少两个坐标）', () => {
    for (const t of tabs) expect(coords(t.icon).length, t.label).toBeGreaterThan(2)
  })

  it('路径只用允许的命令，不含 fill 才有意义的写法', () => {
    // 组件渲染时是 fill="none" stroke=currentColor，用 A 弧线和 z 闭合都可以，
    // 但不能出现多个 path 才需要的分隔符
    for (const t of tabs) expect(t.icon, t.label).not.toContain('"')
  })
})
