// 账户图标的形状与大小必须统一。
// 用户实测反馈：两个银行的图标和微信/支付宝「形状大小不一样」——
// 底板一个是圆、一个是圆角方，而招行的图形右边还挂着六条横杠会把重心带偏。
// 这里守住的是「以后加别的银行时不会又歪掉」。
import { describe, expect, it } from 'vitest'
import { accountColor, BRANDS, brandOf } from './AccountIcon'

const box = (vb: string) => vb.trim().split(/\s+/).map(Number)

describe('账户图标', () => {
  it('每个 viewBox 都接近正方形，否则图形会偏在一边', () => {
    for (const [name, b] of Object.entries(BRANDS)) {
      const [, , w, h] = box(b.viewBox)
      expect(w / h, `${name} 的 viewBox 是 ${b.viewBox}`).toBeGreaterThan(0.93)
      expect(w / h, `${name} 的 viewBox 是 ${b.viewBox}`).toBeLessThan(1.07)
    }
  })

  it('每个图形都填满自己的 viewBox，所以同一个 scale 下渲染出来一样大', () => {
    // 路径的坐标不能明显超出 viewBox，也不能只占一小块
    for (const [name, b] of Object.entries(BRANDS)) {
      const [x0, y0, w, h] = box(b.viewBox)
      const nums = (b.path.match(/-?\d*\.?\d+/g) ?? []).map(Number)
      const max = Math.max(...nums.map(Math.abs))
      expect(max, `${name} 的路径坐标超出 viewBox 太多`).toBeLessThanOrEqual(Math.max(x0 + w, y0 + h) * 1.02)
    }
  })

  it('大小占比统一在 0.55~0.62，不能一个大一个小', () => {
    for (const [name, b] of Object.entries(BRANDS)) {
      expect(b.scale, name).toBeGreaterThanOrEqual(0.55)
      expect(b.scale, name).toBeLessThanOrEqual(0.62)
    }
  })

  it('招行图标右侧那几条横杠必须保留——它们是标志的一部分', () => {
    // 2026-09-04 曾误把它们当成中文字样的残留裁掉，用户一眼看出来「没有线条了」。
    // 横杠的特征是路径末尾一串 `m…l2.3 5.1h…` 的横条，最右伸到 x=246。
    expect(BRANDS.CMB.path).toContain('H246')
    expect(box(BRANDS.CMB.viewBox)[2]).toBe(246)
    // 六条，缺一条都不行
    expect(BRANDS.CMB.path.match(/ m[\d.-]+ ?[\d.-]+l2[\d.]* 5\.1/g)?.length ?? 0).toBeGreaterThanOrEqual(5)
  })

  it('认得出四个账户，且颜色各不相同', () => {
    const names = ['中国银行', '招商银行', '支付宝', '微信']
    const colors = names.map(accountColor)
    expect(new Set(colors).size).toBe(4)
    expect(brandOf('中行')).toBe(brandOf('中国银行'))
    expect(brandOf('招行')).toBe(brandOf('招商银行'))
  })

  it('不认识的名字有兜底，不会崩', () => {
    expect(brandOf('随便什么').scale).toBeGreaterThan(0)
    expect(accountColor('')).toMatch(/^#[0-9a-f]{6}$/i)
  })
})
