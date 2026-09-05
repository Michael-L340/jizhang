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
