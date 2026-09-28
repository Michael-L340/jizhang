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
