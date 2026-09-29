// 「点一下看明细、再点一下看流水」里，没有直角坐标的图（消费日历）第二下怎么算。纯函数，Chart.tsx 只管接事件。
//
// 日历一格在手机上只有 5–6 px 宽、10 px 高（12 个月 53 列挤在 300 px 里）。原来要求第二下点中**同一格**：
// 第一下点中 9/12，第二下手指偏了 3 px 落到 9/13 或 9/19，就换成那天的提示框、计数重来，永远跳不走。
// 现在第二下只要落在第一下周围 TAP_SLOP_PX 之内——不管落在别的格子上、没花钱的空格上、还是提示框上
// （提示框不接点击，点它等于点它底下的东西）——都按第一下选中的那天跳。离得远才算「改看另一天」。

export interface TapItem {
  seriesIndex: number
  dataIndex: number
}

/** 第一下点中的那一格，和第一下点在哪（图里的像素坐标） */
export interface ArmedTap extends TapItem {
  x: number
  y: number
}

/** 手指的误差：大约日历上下各一格、左右各一两格 */
export const TAP_SLOP_PX = 10

export type TapStep = { go: TapItem } | { arm: ArmedTap } | null

/**
 * @param armed 第一下选中的；null = 还没点过
 * @param hit   这一下点中的数据图形；null = 点在空白处（没花钱的日子、格子缝、提示框底下没东西的地方）
 * @returns go = 跳去 armed 那一格；arm = 改选这一格（弹它的提示框）；null = 什么都不做
 */
export function itemTapStep(armed: ArmedTap | null, hit: TapItem | null, x: number, y: number, slop = TAP_SLOP_PX): TapStep {
  if (armed) {
    const same = hit !== null && hit.seriesIndex === armed.seriesIndex && hit.dataIndex === armed.dataIndex
    if (same || Math.hypot(x - armed.x, y - armed.y) <= slop) return { go: { seriesIndex: armed.seriesIndex, dataIndex: armed.dataIndex } }
  }
  return hit ? { arm: { ...hit, x, y } } : null
}

// ---------- 「点绘图区」按哪根轴取下标（Chart.tsx 的 onAxisClick） ----------

type AxisLike = { type?: string; data?: unknown[] }
const firstAxis = (a: AxisLike | AxisLike[] | undefined): AxisLike | undefined => (Array.isArray(a) ? a[0] : a)

/**
 * 点绘图区时，按哪根轴换算成第几根柱子 / 第几个点：dim 是 convertFromPixel 返回值里取第几个（0 = x、1 = y），
 * count 是那根类目轴上有几项（下标夹在 [0, count − 1] 里）。
 *
 * 竖着的柱子、折线：x 是类目轴 → 取 x。横着的条形图（环比涨跌榜）：x 是金额轴、y 是类目轴 → 取 y。
 * 原来一律取 x：横条图上拿到的是「点在哪个金额上」，四舍五入再夹一下永远是 0——
 * 不管点哪一行，提示框都被拉回最上面那一行（2026-09-29 整合第二批时发现）。
 *
 * 认类目轴：x 带 data 就是它（ECharts 的 xAxis 不写 type 默认就是类目轴，统计页的图都这么写）；
 * 否则 y 明写 type: 'category' 且带 data 才算。两根都不是 → 按 x、0 项（和原来的行为一样）。
 */
export function categoryAxisOf(option: unknown): { dim: 0 | 1; count: number } {
  const o = (option ?? {}) as { xAxis?: AxisLike | AxisLike[]; yAxis?: AxisLike | AxisLike[] }
  const x = firstAxis(o.xAxis)
  if (x && Array.isArray(x.data)) return { dim: 0, count: x.data.length }
  const y = firstAxis(o.yAxis)
  if (y && y.type === 'category' && Array.isArray(y.data)) return { dim: 1, count: y.data.length }
  return { dim: 0, count: 0 }
}

/**
 * 提示框改成「点一下才弹」：ECharts 的 tooltip 默认 triggerOn 是 'mousemove|click'，手机上 touchmove 被当成 mousemove，
 * 上下滑页面时手指从图上经过，数字就一个个蹦出来（用户 2026-09-29：「钱的流向…我滑动的时候，他好像太敏感了」）。
 * 进阶分析页的图一律走这个（ChartMore 传 tapOnly）。option 原样不动，返回改过的新对象；没有 tooltip 就原样返回。
 * 程序里喊的 showTip（点两下跳流水的第一下）不受 triggerOn 影响，照常弹。
 */
export function tapOnlyTooltip<T>(option: T): T {
  const o = option as { tooltip?: unknown } | null
  if (!o || typeof o !== 'object' || !o.tooltip) return option
  const fix = (t: unknown) => (t && typeof t === 'object' ? { ...(t as object), triggerOn: 'click' } : t)
  return { ...(o as object), tooltip: Array.isArray(o.tooltip) ? o.tooltip.map(fix) : fix(o.tooltip) } as T
}
