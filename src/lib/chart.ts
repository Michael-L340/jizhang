// 图表布局里的纯计算。不依赖 ECharts、store、DOM，单测跑得到。

/** 中日韩字符和全角标点算一个字宽，其余按 0.55 估。够用就行，误差半个字不影响换行判断。 */
const WIDE = /[⺀-鿿豈-﫿︰-﹏＀-￯]/

export function textWidth(s: string, fontSize: number): number {
  let w = 0
  for (const ch of s) w += WIDE.test(ch) ? fontSize : fontSize * 0.55
  return w
}

export interface LegendMetrics {
  /** 色块宽度 */
  itemWidth: number
  /** 色块和文字之间的间隙（ECharts 固定 5） */
  gap: number
  /** 两项之间的间隙 */
  itemGap: number
  fontSize: number
}

export const LEGEND: LegendMetrics = { itemWidth: 14, gap: 5, itemGap: 10, fontSize: 11 }

/**
 * 图例换行后占几行。ECharts 的 plain 图例会自己换行，但**不会**把多出来的行数
 * 告诉你，grid.top 还得自己算——留少了线会盖住图例，留多了上面一片空白。
 *
 * 一行至少放一项：名字比整行还长时也不会返回 0 行，只是它自己会被截断。
 */
export function legendRows(names: string[], width: number, m: LegendMetrics = LEGEND): number {
  if (!names.length) return 0
  const itemW = (n: string) => m.itemWidth + m.gap + textWidth(n, m.fontSize)
  let rows = 1
  let used = itemW(names[0])
  for (const n of names.slice(1)) {
    const w = itemW(n)
    if (used + m.itemGap + w <= width) used += m.itemGap + w
    else {
      rows++
      used = w
    }
  }
  return rows
}

/** 图例占 rows 行时，画图区域要从多高开始。0 行就是没有图例。 */
export function gridTopFor(rows: number): number {
  return rows === 0 ? 16 : 12 + rows * 17
}

// ---------- x 轴标签 ----------

/**
 * x 轴要标哪几个桶、每个标什么。
 *
 * **年份永远带着**（用户 2026-09-08 定）：`25.10`、`26.1`。省掉年份省不出多少宽度，
 * 却要人自己数「这是哪一年的 7 月」。代价是全标经常装不下，于是有了下面的降级。
 *
 * 从「每个都标」开始逐级往下降，取**第一个装得下的**级别：
 *   按月：全标 → 每季度（1/4/7/10 月）→ 每半年（1/7 月）→ 每年（1 月）
 *   按日：全标 → 每 2/3/5/7/10/14 天 → 每月 1 号 → 每季度首日 → 每年 1 月 1 日
 *
 * 「装得下」= 相邻两个被标出来的标签，中心距 ≥ 两个半宽之和 + 4px 余量。
 * 原来是 `interval: keys.length <= 14 ? 0 : ...`，只看个数不看宽度——近一年按月是 12 个，
 * 走的是「全标」，而 `25.10` 有 27.5px、一格只有 22px，糊成一片。
 *
 * 降到某一级只剩不到 2 个标签就停住，宁可挤一点也不能一个刻度都没有。
 */
export function axisLabels(
  keys: string[],
  unit: 'day' | 'month',
  width: number,
  fontSize = 10,
): { show: boolean[]; text: string[] } {
  const text = keys.map((k) =>
    unit === 'month' ? `${k.slice(2, 4)}.${+k.slice(5)}` : `${k.slice(2, 4)}/${+k.slice(5, 7)}/${+k.slice(8, 10)}`,
  )
  if (keys.length < 2) return { show: keys.map(() => true), text }

  const w = text.map((t) => textWidth(t, fontSize))
  const slot = width / keys.length
  const QUARTER = ['01', '04', '07', '10']
  const levels: boolean[][] = [keys.map(() => true)]
  if (unit === 'day') {
    // 跨了三个月以上就直接用「每月 1 号」——它比「每 14 天」有意义得多：
    // 7/1 8/1 9/1 一眼知道是月初，而 7/15 7/29 8/12 只是等距落点。
    // 区间在一两个月之内时月初太少（只有一两个刻度），才退回等距。
    const first = keys.map((k) => k.slice(8) === '01')
    if (first.filter(Boolean).length >= 3) levels.push(first)
    for (const step of [2, 3, 5, 7, 10, 14]) levels.push(keys.map((_, i) => i % step === 0))
    levels.push(first)
    levels.push(keys.map((k) => k.slice(8) === '01' && QUARTER.includes(k.slice(5, 7))))
    levels.push(keys.map((k) => k.slice(5) === '01-01'))
  } else {
    levels.push(keys.map((k) => QUARTER.includes(k.slice(5, 7))))
    levels.push(keys.map((k) => k.slice(5, 7) === '01' || k.slice(5, 7) === '07'))
    levels.push(keys.map((k) => k.slice(5, 7) === '01'))
  }

  const fits = (idx: number[]): boolean => {
    for (let n = 1; n < idx.length; n++) {
      const need = (w[idx[n - 1]] + w[idx[n]]) / 2 + 4
      if ((idx[n] - idx[n - 1]) * slot < need) return false
    }
    return true
  }

  let show = levels[0]
  for (const lv of levels) {
    const idx = lv.flatMap((s, i) => (s ? [i] : []))
    if (idx.length < 2) break
    show = lv
    if (fits(idx)) break
  }
  return { show, text }
}

// ---------- 图例缩写 ----------

/** 一级分类名里的通用后缀。剥掉它们剩下的才是区别性的那几个字 */
const GENERIC = ['消费', '开支', '支出', '生活']

/**
 * 图例用的短名：「非经常生活消费」→「非经常」，「经常生活开支」→「经常」。
 *
 * 不写死映射表——分类名是用户数据，改个名字表就失效了。改成剥通用后缀，
 * 剥到只剩 2 个字就停（再剥下去「日常开支」会变成空的）。
 *
 * **撞名就整组回退用原名**：同时有「日常开支」和「日常餐饮」时两个都会变成「日常」，
 * 那还不如都写全——图例里两个一模一样的名字比长名字糟得多。
 *
 * 只给图例和 x 轴用。提示框里仍然是全名，那里空间够，而且要能对得上分类管理页。
 */
export function shortLabels(names: string[]): string[] {
  const short = names.map((n) => {
    let s = n
    for (;;) {
      const hit = GENERIC.find((g) => s.endsWith(g) && s.length - g.length >= 2)
      if (!hit) return s
      s = s.slice(0, -hit.length)
    }
  })
  return new Set(short).size === short.length ? short : names
}

// ---------- 双轴对齐 ----------

/**
 * 把一个原始步长收成「好看的刻度」。
 *
 * 比常见的 1/2/5 系多给了 1.5/3/4/6/8——只有 1/2/5 的话跨度太粗：
 * 最高柱 2360 想留一成头，理想上限是 2682，1/2/5 系会一口气跳到 5000，
 * 柱子只剩半屏高。有了 6 就落在 3000，正好。
 */
function niceStep(raw: number): number {
  if (!(raw > 0)) return 1
  const mag = 10 ** Math.floor(Math.log10(raw))
  const n = raw / mag
  for (const c of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (n <= c) return c * mag
  return 10 * mag
}

/**
 * 柱子 + 折线这种双轴图的两个上限。**目标是让折线正好压在柱顶的轮廓上。**
 *
 * 丑在哪：让 ECharts 两根轴各自 auto 缩放，线会掉进柱子肚子里横切过去
 * （实测线只有柱高的 32%，加了「两边格数一样」也才 82%，仍然从中上部穿过）。
 * 用户拿来对照的那张 Excel 之所以顺眼，是因为它的线/柱比正好是 1.0——
 * 线就是柱顶的轮廓线。
 *
 * 怎么做到：日均 × 桶天数 = 桶总额。所以只要
 *
 *     线轴上限 = 柱轴上限 ÷ 标准桶天数
 *
 * 一个「标准长度」的月份，它的线就精确落在柱顶。比标准月短（2 月）线抬起来一点，
 * 长（31 天）压下去一点——**线和柱顶之间的缝，就是这个月比标准月长多少**，
 * 这正是这条线唯一值得看的东西。
 *
 * 柱轴先留一成头（headroom 0.88），免得最高那根顶到图例上；线轴取完之后再兜一次底，
 * 保证不会把某个特别高的点切掉。
 *
 * @param unitDays 标准桶天数：按月取各完整月天数的中位数，按日就是 1
 */
export function pairedAxisMax(
  barMax: number,
  lineMax: number,
  unitDays: number,
  split = 5,
  headroom = 0.88,
): { bar: number; line: number } {
  const bar = niceStep(barMax / headroom / split) * split
  const ideal = niceStep(bar / Math.max(1, unitDays) / split) * split
  const cover = niceStep(lineMax / split) * split
  return { bar, line: Math.max(ideal, cover) }
}
