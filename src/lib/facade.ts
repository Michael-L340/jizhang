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
import type { Account, Transaction } from '../types'

/** outer = 平时用的外页面（修饰过），inner = 只有本人知道的里页面（真实） */
export type Mode = 'outer' | 'inner'

/** 切走 App 超过这么久再回来，自动退回外页面（用户 2026-09-07 定 60 秒） */
export const INNER_TTL_MS = 60_000

/**
 * 长按 ＋ 多久算切换。用户 2026-09-07 试过 2.5 秒嫌久，定 1.5 秒。
 * 按短了误触概率会升——但手指移动超过 10px 就取消，加上离开 60 秒自动回外页面，
 * 真按住出神切进去了也兜得住。
 */
export const HOLD_MS = 1500

/** 这个账户的偏移量（分）。白条和没设过的都是 0 */
export function offsetOf(a: Account): number {
  if (isCredit(a)) return 0
  return a.facade_offset ?? 0
}

/**
 * 「被修饰过的账户」= 设过偏移量的资产账户。
 *
 * 和 offsetOf 差一点：偏移量正好是 0 的账户 offsetOf 也返回 0，但 `facade_offset !== null`
 * 说明用户确实动过它。判断「要不要藏校准」用这个，判断「余额加多少」用 offsetOf。
 */
export function isDecorated(a: Account): boolean {
  return !isCredit(a) && a.facade_offset !== null
}

/**
 * 外模式下看得见的流水：**被修饰账户的「余额校准」整条隐身**。
 *
 * 为什么必须藏：里页面校准支付宝 +6,391 之后，外页面余额是修饰过的 0.00，
 * 而这条 +6,391 会同时出现在首页最近流水、流水页、账户页的「本月 ±」和「上次校准」里——
 * 余额 0.00 配一行「本月 +6,391.00」，一眼就露馅。
 *
 * 只藏被修饰的账户：`facade_offset = null` 就是「不修饰」，那种账户一个字都不该改。
 *
 * 这是对「只有余额被修饰、流水全是真的」开的唯一一个口子。代价可控——校准从来不进
 * 收入/支出/储蓄率/饼图（compute.ts 的 isFlow），所以两边任何一个统计数字都不会变，
 * 变的只是列表里少一行。导出、导入、备份走的是 store 里的原始数组，不经过这里。
 */
export function visibleTxs(txs: Transaction[], accounts: Account[], mode: Mode): Transaction[] {
  if (mode === 'inner') return txs
  const hidden = new Set(accounts.filter(isDecorated).map((a) => a.id))
  if (!hidden.size) return txs
  return txs.filter((t) => !(t.type === 'adjust' && t.account_id !== null && hidden.has(t.account_id)))
}

/**
 * 每个被修饰账户的校准合计（分）。只给外模式的余额曲线用。
 *
 * 注意要拿**全量** txs 来算，不能拿 visibleTxs 的结果——那里面校准已经被摘掉了。
 */
export function adjustTotals(txs: Transaction[], accounts: Account[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const a of accounts) if (isDecorated(a)) out[a.id] = 0
  for (const t of txs) {
    if (t.type !== 'adjust' || t.account_id === null) continue
    if (t.account_id in out) out[t.account_id] += t.amount
  }
  return out
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

/**
 * 所有偏移量之和（分）。给「总资产」这类**当前余额**的合计用。
 *
 * 曲线不要用它：曲线的平移量还得加上校准合计，见 shiftSeries。
 */
export function facadeShift(accounts: Account[], mode: Mode): number {
  if (mode === 'inner') return 0
  return accounts.reduce((s, a) => s + offsetOf(a), 0)
}

/**
 * 统计页那条余额曲线：外模式整条平移。
 *
 * 平移量 = 偏移量 + 该账户的校准合计，而 series 必须是拿 visibleTxs 算出来的
 * （校准已经摘掉）。两件事必须配对，单做一件都是错的：
 *
 *   支付宝真实余额 9/7 之前是 0，那天校准 +6,391 变成 6,391，偏移量 −6,391。
 *   只平移不摘校准 → 9/7 之前显示 −6,391，趴一整年再弹回 0，一眼就是坏的。
 *   摘了校准不补平移量 → 今天显示 −6,391，比上面更糟。
 *   两件一起做 → 0 − 0 + (−6,391 + 6,391) = 0，整条平的，而今天那个数一个字没变。
 *
 * 「今天那个数不变」是这个改法的关键：不用动数据库里已经存好的偏移量。
 *
 * 里模式原样返回同一个对象。
 */
export function shiftSeries<T extends { total: number[]; byAccount: Record<string, number[]> }>(
  series: T,
  accounts: Account[],
  mode: Mode,
  adjusts: Record<string, number> = {},
): { total: number[]; byAccount: Record<string, number[]> } {
  if (mode === 'inner') return series
  const byAccount: Record<string, number[]> = {}
  let shift = 0
  for (const a of accounts) {
    const d = offsetOf(a) + (adjusts[a.id] ?? 0)
    shift += d
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
