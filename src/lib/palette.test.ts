/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { categoryColor, CHART, childColors, childShade, contrast, hexToHsl, READABLE_MIN, readableOn } from './palette'

/** 两个颜色在 RGB 空间的距离。粗糙但够用：肉眼能分辨大约要 40 以上 */
function dist(a: string, b: string): number {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const [x, y] = [p(a), p(b)]
  return Math.sqrt(x.reduce((s, v, i) => s + (v - y[i]) ** 2, 0))
}

/** 现行的五个一级支出色，下面的不变量都要在它们身上成立 */
const ROOTS = ['#c7820a', '#408632', '#17979b', '#7051d6', '#c62f85']
const EXPENSE_ROOTS = ['日常餐饮', '经常生活开支', '非经常生活消费', '娱乐消费', '意外开支']

/**
 * 主题色一律从 index.css 的 @theme 现读，不要在这里抄一份。
 * 2026-09-06 就是抄错的：主题 09-05 换成暖色之后，这条测试还守着旧的冷色
 * #e5484d / #1f9d55 / #2f6fed，守了半天守的是三个已经不存在的颜色。
 */
function themeColor(token: string): string {
  // 试过 Vite 的 `?raw` 导入，在这个项目里拿到的是空字符串——
  // Tailwind 的插件把 .css 的导入接管了。单测跑在 node 里，直接读文件最稳。
  const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')
  const m = css.match(new RegExp(`--color-${token}:\\s*(#[0-9a-fA-F]{6})`))
  if (!m) throw new Error(`index.css 里找不到 --color-${token}`)
  return m[1]
}

describe('二级分类配色', () => {
  it('每个都是合法的 6 位十六进制', () => {
    for (const n of [1, 2, 3, 6, 12]) {
      for (const c of childColors('#c7820a', n)) expect(c).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('只有一个二级时就用父色', () => {
    expect(childColors('#c7820a', 1)).toEqual(['#c7820a'])
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
    expect(categoryColor('新分类', 0)).toBe('#7a9523')
    expect(categoryColor('新分类', 9)).toBe(categoryColor('新分类', 0))
  })
})

describe('流水行里二级分类的底色', () => {
  it('同一个二级分类的底色永远不变（按 sort 取，不随出现顺序变）', () => {
    expect(childShade('#c7820a', 3)).toBe(childShade('#c7820a', 3))
  })

  it('同一大类下相邻的两个二级底色不同，连着几行才不会糊成一片', () => {
    const shades = [1, 2, 3, 4, 5, 6].map((s) => childShade('#c7820a', s))
    expect(new Set(shades).size).toBe(6)
  })

  it('仍然是父色那个色系，一眼还能看出属于哪个大类', () => {
    const [h0] = hexToHsl('#7051d6')
    for (const s of [1, 2, 3, 4, 5, 6]) {
      const [h] = hexToHsl(childShade('#7051d6', s))
      expect(Math.min(Math.abs(h - h0), 360 - Math.abs(h - h0))).toBeLessThanOrEqual(25)
    }
  })

  it('sort 超出范围或为 0 也不会崩', () => {
    for (const s of [0, 7, 99, -3]) expect(childShade('#c7820a', s)).toMatch(/^#[0-9a-f]{6}$/)
  })
})

describe('一级支出分类的配色约束', () => {
  it('五个色相两两至少差 56°——差少了，两边的二级分类会互相撞', () => {
    // childColors 把色相往左右各摆 28°，每个大类要独占 56°。
    // 旧配色的蓝(219)和紫(253)只差 34°，这条会红。
    const hs = EXPENSE_ROOTS.map((n) => hexToHsl(categoryColor(n))[0]).sort((a, b) => a - b)
    for (let i = 0; i < hs.length; i++) {
      const gap = ((hs[(i + 1) % hs.length] - hs[i] + 360) % 360) || 360
      expect(gap, `${hs[i].toFixed(0)}° 之后只隔了 ${gap.toFixed(0)}°`).toBeGreaterThanOrEqual(56)
    }
  })

  it('避开两个数据语义色：支出色和收入色', () => {
    // 品牌色不在这条约束里，有两个原因：
    // 一、它只出现在按钮底色和选中的胶囊上，从不给数据上色，撞色相不会产生
    //     「同一屏里一个颜色两种含义」——那正是把「意外开支」从支出色挪走的理由。
    // 二、五个色相 72° 等分时，支出(6°)、收入(137°)、品牌(33°) 三个位置
    //     不可能同时让开 20° 以上，实测最好的旋转也只有 16°。
    const TAKEN: Record<string, string> = { 支出色: themeColor('expense'), 收入色: themeColor('income') }
    for (const name of EXPENSE_ROOTS) {
      const c = categoryColor(name)
      for (const [what, hex] of Object.entries(TAKEN)) {
        expect(c, `${name} 用了${what}本身`).not.toBe(hex)
        const d = Math.abs(hexToHsl(c)[0] - hexToHsl(hex)[0])
        expect(Math.min(d, 360 - d), `${name} 的色相离${what}太近`).toBeGreaterThan(20)
      }
    }
  })

  it('收入的「其他」不能是支出红——它曾经和「意外开支」共用一条规则', () => {
    expect(categoryColor('其他')).not.toBe('#e5484d')
    expect(categoryColor('其他')).not.toBe(categoryColor('意外开支'))
  })
})

describe('分类颜色只有一个来源', () => {
  // 首页曾经自带一串写死的颜色、按名次发色：同一个分类在首页和统计页颜色不一样，
  // 两页对着看会错乱；而且那串还是换暖色主题之前的冷色，主题变了它不会跟着变。
  // 页面里不许再出现写死的颜色，一律走 categoryColor。
  it('首页不许写死十六进制颜色', () => {
    const src = readFileSync(new URL('../pages/Home.tsx', import.meta.url), 'utf8')
    const hits = src.match(/#[0-9a-fA-F]{6}\b/g) ?? []
    expect(hits, `Home.tsx 里写死了颜色：${hits.join(' ')}`).toEqual([])
  })

  // 2026-09-08 收拾干净了：那批 09-05 之前留下的冷色（支出红 #e5484d、收入绿 #1f9d55、
  // 余额蓝 #2f6fed、冷灰坐标轴）全部换成 palette.CHART，这里跟着从例外升级成守卫。
  it('统计页也不许写死十六进制颜色', () => {
    const src = readFileSync(new URL('../pages/Stats.tsx', import.meta.url), 'utf8')
    const hits = src.match(/#[0-9a-fA-F]{6}\b/g) ?? []
    expect(hits, `Stats.tsx 里写死了颜色：${hits.join(' ')}`).toEqual([])
  })

  // 进阶分析页只管排卡片，图上的颜色全在 lib/more/*.ts 里走 CHART / categoryColor（那边各有各的守卫）
  it('进阶分析页也不许写死十六进制颜色', () => {
    // 变异：卡片标题加一个 style={{ color: '#c95a4e' }} → 红
    for (const p of ['../pages/StatsMore.tsx', '../components/ChartMore.tsx']) {
      const src = readFileSync(new URL(p, import.meta.url), 'utf8')
      const hits = src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
      expect(hits, `${p} 里写死了颜色：${hits.join(' ')}`).toEqual([])
    }
  })

  // CHART 是图表上唯一允许出现十六进制的地方，代价是它可能和主题脱节。
  // 从 index.css 现读来对账，改了主题不改这张表就红在这里。
  it('CHART 里每个色值都等于 index.css 的对应 token', () => {
    expect(CHART.expense).toBe(themeColor('expense'))
    expect(CHART.income).toBe(themeColor('income'))
    expect(CHART.balance).toBe(themeColor('balance'))
    expect(CHART.axis).toBe(themeColor('line'))
    expect(CHART.label).toBe(themeColor('muted'))
    expect(CHART.gap).toBe(themeColor('card'))
    // 变异：brandInk 写成 '#8a6027' → 红
    expect(CHART.brandInk).toBe(themeColor('brand-ink'))
    // 变异：ink 写成 '#33302c' → 红
    expect(CHART.ink).toBe(themeColor('ink'))
  })
})

describe('色块上的字用白字还是深字（readableOn）', () => {
  // 进阶分析「支出版图」钻进大类之后，二级那几档浅色块上一律白字，对比度只有 1.3–1.8，看不清（审阅 #6）
  it('对比度的算法对得上 WCAG：黑配白 21，同色 1', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5)
    expect(contrast('#c7820a', '#c7820a')).toBe(1)
  })

  it('五个一级支出色上是白字（白字对比度 ≥ 3）', () => {
    // 变异：readableOn 改成单纯挑对比度高的那个 → 「日常餐饮」的琥珀色（白 3.2 / 深 4.1）成了深字，红
    // 变异：readableOn 恒返回 CHART.ink → 红
    for (const name of EXPENSE_ROOTS) {
      const bg = categoryColor(name)
      expect(readableOn(bg), name).toBe(CHART.gap)
      expect(contrast(CHART.gap, bg), name).toBeGreaterThanOrEqual(READABLE_MIN)
    }
  })

  it('二级最浅的那档（childShade 的 sort 6，明度 0.78）上是深字，而且深字对比度 ≥ 4.5', () => {
    // 变异：readableOn 恒返回 CHART.gap（改回一律白字）→ 红
    // 变异：门槛写反（`< READABLE_MIN ? gap : ink`）→ 红
    for (const name of EXPENSE_ROOTS) {
      const bg = childShade(categoryColor(name), 6)
      expect(readableOn(bg), `${name} 最浅那档 ${bg}`).toBe(CHART.ink)
      expect(contrast(CHART.ink, bg), `${name} 最浅那档 ${bg}`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(CHART.ink, bg)).toBeGreaterThan(contrast(CHART.gap, bg))
    }
  })

  it('扫一遍所有分类色和它们的六档二级色：选出来的字色对比度 ≥ 3；换成深字时深字一定比白字清楚', () => {
    // 变异：门槛从 3 提到 5 → 「经常生活开支」的绿（白 4.5 / 深 2.9）被换成深字，比白字还糊，红
    const roots = [...new Set([...EXPENSE_ROOTS, '工资', '生活费', '奖学金', '理财', '退款', '其他', ...Array.from({ length: 9 }, (_, i) => `新${i}`)].map((n, i) => categoryColor(n, i)))]
    for (const root of roots) {
      for (const bg of [root, ...[1, 2, 3, 4, 5, 6].map((s) => childShade(root, s))]) {
        const fg = readableOn(bg)
        if (contrast(fg, bg) < READABLE_MIN) expect.fail(`${bg} 上的 ${fg} 对比度只有 ${contrast(fg, bg).toFixed(2)}`)
        if (fg === CHART.ink && contrast(CHART.ink, bg) <= contrast(CHART.gap, bg)) expect.fail(`${bg} 换成深字反而更糊`)
      }
    }
  })
})
