// 账户图标的形状与大小必须统一。
// 用户实测反馈：两个银行的图标和微信/支付宝「形状大小不一样」——
// 底板一个是圆、一个是圆角方，而招行的图形右边还挂着六条横杠会把重心带偏。
// 这里守住的是「以后加别的银行时不会又歪掉」。
import { describe, expect, it } from 'vitest'
import { accountColor, accountTint, BRANDS, brandOf, CREDIT_CARD } from './AccountIcon'

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

  it('同一种底板下大小占比一致，不能一个大一个小', () => {
    // 深色底板上的白标要留出一圈底色，浅色底板上的标可以做大，两者视觉重量才接近。
    for (const [name, b] of Object.entries(BRANDS)) {
      const [lo, hi] = b.plate === 'brand' ? [0.55, 0.62] : [0.7, 0.85]
      expect(b.scale, `${name}（${b.plate} 底板）`).toBeGreaterThanOrEqual(lo)
      expect(b.scale, `${name}（${b.plate} 底板）`).toBeLessThanOrEqual(hi)
    }
  })

  it('四个账户的配色方向统一——并排时不能一深一浅', () => {
    // 2026-09-04 用户拍板：宁可银行标志是负片，也要四个并排看起来是一套
    const plates = new Set(['WECHAT', 'ALIPAY', 'BOC', 'CMB'].map((k) => BRANDS[k].plate))
    expect(plates.size).toBe(1)
  })

  it('招行图标右侧那六条横线必须保留——它们是标志的一部分', () => {
    // 真实标志是「红圆 + 白色 M + 右侧横向渐变条」。2026-09-04 两次误判：
    // 先当成中文字样的残留裁掉，又因为一次被截断的网络抓取以为官方没有。
    // 横线的特征是路径末尾一串 `m…l2.3 5.1h…` 的横条，最右伸到 x=246。
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

  it('格子底色看得见，又不至于压过卡片', () => {
    // 首页四个账户格子的底 = 品牌色兑白。两头都得守住：
    // 兑得太淡（比如退回 bg-bg 那种）在白卡片上就分不开；兑得太浓会盖过上面的总资产数字。
    const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
    for (const name of ['中国银行', '招商银行', '支付宝', '微信']) {
      const t = accountTint(name)
      expect(t, name).toMatch(/^#[0-9a-f]{6}$/)
      const c = rgb(t)
      // 离纯白至少 8/255，否则等于没上色
      expect(Math.max(...c.map((v) => 255 - v)), `${name} 的底色 ${t} 太淡`).toBeGreaterThanOrEqual(8)
      // 仍然是浅底，灰色的账户名压在上面要读得出
      expect(Math.min(...c), `${name} 的底色 ${t} 太深`).toBeGreaterThanOrEqual(215)
    }
  })

  it('白条卡面上下左右都居中——几何验的，不是眼睛验的', () => {
    // 先用过系统 emoji 💳，两次被用户指出没居中：不同平台把这个字形画在 em 盒里的位置不同，
    // 靠字体基线对齐永远是猜。改成自画之后，居中变成一条能断言的等式。
    const c = CREDIT_CARD
    const [vx, vy, vw, vh] = BRANDS.GENERIC_BANK.viewBox.trim().split(/\s+/).map(Number)
    expect([c.cx, c.cy], '卡心必须落在 viewBox 正中').toEqual([vx + vw / 2, vy + vh / 2])
    expect(c.right - c.cx, '左右到卡心等距').toBe(c.cx - c.left)
    expect(c.bottom - c.cy, '上下到卡心等距').toBe(c.cy - c.top)

    // 按命令解析，别按奇偶分 x/y：H 只带一个 x、V 只带一个 y，圆弧那三个标志位也不是坐标
    const xs: number[] = []
    const ys: number[] = []
    for (const a of brandOf('白条').art!) {
      for (const [, cmd, argStr] of a.d.matchAll(/([MHVAZ])([^MHVAZ]*)/g)) {
        const n = (argStr.match(/-?\d*\.?\d+/g) ?? []).map(Number)
        if (cmd === 'M') xs.push(n[0]), ys.push(n[1])
        else if (cmd === 'H') xs.push(...n)
        else if (cmd === 'V') ys.push(...n)
        else if (cmd === 'A') xs.push(n[5]), ys.push(n[6]) // A rx ry rot large sweep x y
      }
    }
    expect([Math.min(...xs), Math.max(...xs)], '所有图形的左右边').toEqual([c.left, c.right])
    expect([Math.min(...ys), Math.max(...ys)], '所有图形的上下边').toEqual([c.top, c.bottom])
    // 卡面本身也要留在 viewBox 里，不能顶到圆形底板的边
    expect(c.left).toBeGreaterThan(vx + 1)
    expect(c.right).toBeLessThan(vx + vw - 1)
  })

  it('不认识的名字有兜底，不会崩', () => {
    expect(brandOf('随便什么').scale).toBeGreaterThan(0)
    expect(accountColor('')).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('白条平台四家都用官方位图，「白条」两个字用通用卡片', () => {
    expect(brandOf('京东白条').image).toMatch(/brand\/jd-v\d+\.png$/)
    expect(brandOf('拼多多').image).toMatch(/brand\/pdd-v\d+\.png$/)
    expect(brandOf('美团月付').image).toMatch(/brand\/meituan-v\d+\.png$/)
    expect(brandOf('花呗').image).toMatch(/brand\/huabei-v\d+\.png$/)
    expect(brandOf('花呗').imageLight).toBe(true) // 白底标要加边
    // 「白条」分组和认不出平台的先用后付用自画的多色信用卡，不是位图也不是单色 path
    expect(brandOf('白条').image).toBeUndefined()
    expect(brandOf('白条').art?.length).toBe(4)
    expect(brandOf('先用后付').art).toBe(brandOf('白条').art)
    expect(brandOf('美团月付').art).toBeUndefined() // 认得出的平台仍旧用官方图标
    // 单色自绘图标一个都不能带 art，否则 path 白画了
    for (const [k, b] of Object.entries(BRANDS)) expect(b.art, k).toBeUndefined()
    // 四家颜色（图表里的线和圆点用）各不相同
    expect(new Set(['京东白条', '花呗', '拼多多', '美团月付'].map(accountColor)).size).toBe(4)
  })
})
