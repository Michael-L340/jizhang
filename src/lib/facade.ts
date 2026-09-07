// 里外页面。外页面显示的账户余额 = 真实余额 + 偏移量，里页面显示真实余额。
//
// 「偏移量」而不是「写死的对外余额」：偏移量固定，两边就同幅波动——在外页面记一笔，
// 外面那个数跟着动，看起来是活的；写死一个数则一个月后还是原样，一眼假。
//
// 偏移量存在 accounts.facade_offset（整数「分」，null = 不修饰）。
// 只有余额被修饰：流水、分类统计、月度收支、储蓄率、白条全都是真的，
// 所以外页面里「本月支出」这类数字一个字都没变。
//
// 白条不参与（用户 2026-09-07 定）：欠款金额两边一样。这里挡一道，
// 就算数据里某个白条账户莫名带了偏移量，也不会显示出来。
import { isCredit } from './compute'
import type { Account } from '../types'

/** outer = 平时用的外页面（修饰过），inner = 只有本人知道的里页面（真实） */
export type Mode = 'outer' | 'inner'

/** 切走 App 超过这么久再回来，自动退回外页面（用户 2026-09-07 定 60 秒） */
export const INNER_TTL_MS = 60_000

/** 长按 ＋ 多久算切换（用户 2026-09-07 定 2.5 秒；2 秒嫌容易按住出神误切） */
export const HOLD_MS = 2500

/** 这个账户的偏移量（分）。白条和没设过的都是 0 */
export function offsetOf(a: Account): number {
  if (isCredit(a)) return 0
  return a.facade_offset ?? 0
}

/**
 * 把真实余额换成当前模式该显示的余额。
 * 里模式原样返回**同一个对象**，不做多余的拷贝——页面把它放进 useMemo，
 * 引用不变就少一轮重算。
 */
export function applyFacade(bal: Record<string, number>, accounts: Account[], mode: Mode): Record<string, number> {
  if (mode === 'inner') return bal
  const out: Record<string, number> = { ...bal }
  for (const a of accounts) {
    const d = offsetOf(a)
    if (d) out[a.id] = (out[a.id] ?? 0) + d
  }
  return out
}

/** 所有偏移量之和（分）。给「总资产」和统计页那条余额曲线整体平移用 */
export function facadeShift(accounts: Account[], mode: Mode): number {
  if (mode === 'inner') return 0
  return accounts.reduce((s, a) => s + offsetOf(a), 0)
}

/**
 * 统计页那条余额曲线：外模式整条平移。
 *
 * 平移而不是重算——偏移量不随时间变，所以曲线的形状、涨跌、拐点全都是真的，
 * 只有高度不同。里模式原样返回同一个对象。
 */
export function shiftSeries<T extends { total: number[]; byAccount: Record<string, number[]> }>(
  series: T,
  accounts: Account[],
  mode: Mode,
): { total: number[]; byAccount: Record<string, number[]> } {
  if (mode === 'inner') return series
  const shift = facadeShift(accounts, mode)
  const byAccount: Record<string, number[]> = {}
  for (const a of accounts) {
    const d = offsetOf(a)
    const arr = series.byAccount[a.id] ?? []
    byAccount[a.id] = d ? arr.map((v) => v + d) : arr
  }
  return { total: shift ? series.total.map((v) => v + shift) : series.total, byAccount }
}

/**
 * 由「想让外面显示多少」反推偏移量。
 *
 * 界面上你填的永远是「外面显示多少」，不是「加减多少」——差值要人心算，
 * 而且真实余额一变，想让外面是个整数又得重算一次。
 */
export function offsetFor(displayCents: number, realCents: number): number {
  return displayCents - realCents
}

/** 偏移量为 0 时存 null，别在数据库里留一堆没意义的 0 */
export function normalizeOffset(cents: number): number | null {
  return cents === 0 ? null : cents
}
