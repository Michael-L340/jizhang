/// <reference types="node" />
// 按账户分色（资产结构变化、白条未来负担共用）。输入是用户真有的那几个账户名，
// 颜色取自页面会传进来的那个函数（components/AccountIcon 的 accountColor）——测试可以跨层 import，App 代码不行。
// 每条用例都先把实现改坏跑过一次，确认它会红（注释里的「变异：… → 红」）。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { accountColor } from '../../components/AccountIcon'
import type { Account } from '../../types'
import { CHART, childShade, hexToHsl } from '../palette'
import { accountColors, fallbackColors, tooClose } from './acctcolor'

const A = (name: string, i: number): Account => ({
  id: `a${i}`, name, kind: 'bank', sort: i, is_archived: false, repay_day: null, defer_after_repay: null, facade_offset: null,
})
const accs = (...names: string[]) => names.map(A)
const pairwiseApart = (cs: string[]) => cs.every((c, i) => cs.every((d, j) => i === j || !tooClose(c, d)))

describe('账户配色', () => {
  it('四个预置资产账户（中行、招行、支付宝、微信）：中行和招行品牌色都是红，堆在一起要分得开', () => {
    // 前提：品牌色本身确实撞了（不然这条测的是空气）
    expect(tooClose(accountColor('中国银行'), accountColor('招商银行'))).toBe(true)
    // 变异：accountColors 直接返回 colorOf(a.name)，不做撞色处理 → 红
    const cs = accountColors(accs('中国银行', '招商银行', '支付宝', '微信'), accountColor, CHART.balance)
    expect(pairwiseApart(cs)).toBe(true)
    // 不撞的照用品牌色，一个都不改：微信还是微信绿
    expect(cs[0]).toBe(accountColor('中国银行'))
    expect(cs[2]).toBe(accountColor('支付宝'))
    expect(cs[3]).toBe(accountColor('微信'))
    // 撞了的换成同色系另一档，不是另发明一个颜色
    expect([2, 4, 6, 3, 5].map((s) => childShade(accountColor('招商银行'), s))).toContain(cs[1])
  })

  it('四家白条（京东、花呗、拼多多、美团）：京东和拼多多都是红，也要分得开', () => {
    // 变异：撞色时恒取第一档 childShade(raw, 2)、不看它是不是又撞了已发的颜色 → 红（拼多多那档浅红撞上花呗之后的某个色）
    const cs = accountColors(accs('京东白条', '花呗', '拼多多', '美团月付'), accountColor, CHART.brandInk)
    expect(pairwiseApart(cs)).toBe(true)
    expect(cs[1]).toBe(accountColor('花呗'))
  })

  it('三家红色的银行（中行、招行、再来一个和中行一样红的工行），换档时跳过已经发出去的颜色', () => {
    // 变异：去掉 `.find((c) => !out.some(...))`、恒取第一档 → 工行和招行拿到几乎一样的那档浅红，红
    const red = () => accountColor('中国银行')
    const cs = accountColors(accs('中国银行', '招商银行', '工商银行'), (n) => (n === '工商银行' ? red() : accountColor(n)), CHART.balance)
    expect(pairwiseApart(cs)).toBe(true)
  })

  it('不传品牌色：从给定颜色起同色系几档，两两分得开，第二档不是白卡片上看不见的那档浅色', () => {
    // 变异：fallbackColors 改回 childColors(fallback, n)（n = 2 时拿到渐变两头，浅的明度 0.78）→ 红
    for (let n = 1; n <= 8; n++) {
      const cs = fallbackColors(CHART.balance, n)
      expect(cs).toHaveLength(n)
      expect(new Set(cs).size).toBe(n)
    }
    const [, second] = fallbackColors(CHART.brandInk, 2)
    expect(hexToHsl(second)[2]).toBeLessThan(0.7)
    expect(accountColors(accs('甲', '乙', '丙'), undefined, CHART.balance)).toEqual(fallbackColors(CHART.balance, 3))
  })

  it('tooClose：色相差 30° 以内且明度差 0.15 以内才算近；灰色只和灰色比明度', () => {
    // 变异：去掉色相的环绕（350° 和 10° 算成差 340°）→ 红
    expect(tooClose('#e6194b', '#e61919')).toBe(true) // 同一个红
    expect(tooClose('#e61933', '#e63319')).toBe(true) // 350° vs 10°：隔着 0° 只差 20°
    expect(tooClose('#e61919', '#1919e6')).toBe(false)
    // 变异：明度门槛 L_NEAR 从 0.15 放到 0.5 → 下面这条红
    expect(tooClose('#8a1010', '#f07070')).toBe(false) // 同色相，一深一浅
    // 变异：灰色也比色相（`if (g1 || g2) return g1 && g2` 删掉）→ 灰和同明度的红被当成近，红
    expect(tooClose('#808080', '#c04040')).toBe(false)
    expect(tooClose('#808080', '#858585')).toBe(true)
  })

  it('源码不写死颜色、不 import components（分层：lib 不往上依赖）', () => {
    // 变异：往 acctcolor.ts 里加一行 `import '../../components/AccountIcon'` → 红
    const src = readFileSync(new URL('./acctcolor.ts', import.meta.url), 'utf8')
    expect(src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([])
    expect(src).not.toMatch(/^import[^\n]*['"][./]*\/?components\//m)
  })
})
