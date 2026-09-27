// 里外页面。外页面显示的是修饰过的账（outerBook），里页面显示原始流水（真实）。
//
// 2026-09-27 起的模型（里外校准分家）：
//
//   外页面那本账 = 真实流水 − 藏掉的（transactions.hidden）− 非白条账户的真实校准 + 外页面校准记录（facade_adjusts）
//
// 外页面校准记录是一条有日期的记录：从那天起外页面这个账户的余额加 cents，以前的点不动——
// 和里页面的真实校准一个脾气。真实校准外页面一律看不见；里页面校准时默认顺手给外页面记一条
// 同样的（Accounts.tsx），所以不特意改「对外显示」的话外页面照常跟着动。
//
// 老模型（0007 的 accounts.facade_offset）把「对外显示」存成一个固定差值：外页面 = 真实 + 差值，
// 一改整条曲线上下移，能藏多少还被历史最低点封顶（用户 2026-09-27：「时点前的不动，时点之后的才会变动」）。
// 老偏移量由 migrateFacade 换算成一条记在 FACADE_EPOCH 的记录，曲线上每个点都含着它，
// 和「整条平移」逐点相同——迁移前后屏幕上一个数都不变（facade.book.test.ts 拿随机账本对过）。
// 老列留在库里不再读：回退旧版本时旧代码照常用它。
//
// 只有余额和曲线被修饰：分类统计、月收支、储蓄率、白条、导入导出全是真的（校准从来不进收支统计）。
// 白条不参与（用户 2026-09-07 定）：欠款金额两边一样，它的真实校准照旧算、照旧列。
import { isCredit } from './compute'
import type { Account, FacadeAdjust, Transaction } from '../types'
import { balances } from './compute'

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

/**
 * 老偏移量迁移出来的那条记录记在这一天。要早于曲线可能画到的任何一天（自定义区间能选到
 * 很早），这样每一个点都含着它，和以前「整条平移」逐点相同。latestFacadeAdjust 会跳过它。
 */
export const FACADE_EPOCH = '2000-01-01'
const EPOCH_AT = '2000-01-01T00:00:00.000Z'

/**
 * 外页面校准记录 → 一条只有外页面看得见的校准流水。
 * type 必须是 adjust：balances / balanceSeries 按 adjust 加进余额，isFlow 不把它当收支。
 */
export function facadeAsTx(f: FacadeAdjust): Transaction {
  return {
    id: f.id,
    date: f.date,
    type: 'adjust',
    amount: f.cents,
    account_id: f.account_id,
    to_account_id: null,
    category_id: null,
    note: null,
    installments: null,
    settles: null,
    hidden: null,
    created_at: f.created_at,
  }
}

/**
 * 外页面看得见的真实流水：藏掉的不要，非白条账户的真实校准不要（白条不分里外，照旧）。
 * 什么都不用去掉时返回同一个数组，页面的 useMemo 不重算。
 *
 * 藏真实校准的原因（2026-09-08 用户截到的那一幕）：里页面校准支付宝 +6,391 之后，外页面余额是
 * 修饰过的 0.00，而这条 +6,391 会同时出现在首页最近流水、流水页、账户页的「本月 ±」里——
 * 余额 0.00 配一行「本月 +6,391.00」，一眼就露馅。
 */
function stripForOuter(txs: Transaction[], accounts: Account[]): Transaction[] {
  const credit = new Set(accounts.filter(isCredit).map((a) => a.id))
  const drop = (t: Transaction): boolean => Boolean(t.hidden) || (t.type === 'adjust' && t.account_id !== null && !credit.has(t.account_id))
  return txs.some(drop) ? txs.filter((t) => !drop(t)) : txs
}

/**
 * 外页面的流水列表：外页面那本账去掉外页面校准记录（用户 2026-09-27 定：外页面流水里不出现校准行）。
 * 里模式原样返回同一个数组。
 */
export function outerList(txs: Transaction[], accounts: Account[], mode: Mode): Transaction[] {
  if (mode === 'inner') return txs
  return stripForOuter(txs, accounts)
}

/**
 * 外页面那本账。**外页面所有算钱的地方只准吃它**：余额、总资产、本月收支、储蓄率、饼图、
 * 趋势、月份选择器、余额曲线（facade.test.ts 有源码守卫；facade.book.test.ts 有随机不变量：
 * 账户页 ≡ 曲线末点 ≡ 列表之和 + 外页面校准合计）。列表走 outerList。
 *
 * 「外面隐藏」的记录在外模式下**当不存在**——2026-09-16 第一版做成「只藏列表那一行、钱照算」，
 * 首页「本月支出 5,000」、流水页顶上「4,700」，两套账本必然对不上，当天推翻。
 * 里模式原样返回同一个数组。
 */
export function outerBook(txs: Transaction[], accounts: Account[], fadj: FacadeAdjust[], mode: Mode): Transaction[] {
  if (mode === 'inner') return txs
  const base = stripForOuter(txs, accounts)
  return fadj.length ? [...base, ...fadj.map(facadeAsTx)] : base
}

/**
 * 一条外页面校准该记多少：你填的「对外显示」− 外页面现在显示的数。
 * 界面上填的永远是「外面显示多少」，不是「加减多少」——差值要人心算。
 */
export function facadeDelta(displayCents: number, currentOuterCents: number): number {
  return displayCents - currentOuterCents
}

/**
 * 每个账户最近一次外页面校准（按日期，同一天按记录时间）。里页面校准弹层那行
 * 「外页面上次校准 9/27」用它。迁移出来的 FACADE_EPOCH 那条不算——那不是人做的校准。
 */
export function latestFacadeAdjust(fadj: FacadeAdjust[]): Map<string, FacadeAdjust> {
  const m = new Map<string, FacadeAdjust>()
  for (const f of fadj) {
    if (f.date === FACADE_EPOCH) continue
    const cur = m.get(f.account_id)
    if (!cur || f.date > cur.date || (f.date === cur.date && f.created_at > cur.created_at)) m.set(f.account_id, f)
  }
  return m
}

/**
 * 迁移记录的 id 由来源 id 推出来，两边（这里的 TS、一次性跑的 scripts/migrate-facade.sql）算出来一样，
 * 所以重复跑、或者把老备份「合并导入」进已经迁移过的库，都是同一批 id 的 upsert，不会翻倍。
 * 规则：把来源 uuid 的前四个十六进制位换成标记（offset → fa01，twin → fa00），其余 32 位照抄。
 */
export function facadeIdFor(kind: 'offset' | 'twin', srcId: string): string {
  return (kind === 'offset' ? 'fa01' : 'fa00') + srcId.slice(4)
}

/**
 * 老模型 → 新模型的换算。**只加记录，不改任何现有数据**。
 *
 * - 修饰过的账户（facade_offset 不为 null）：一条记在 FACADE_EPOCH 的记录，
 *   cents = 偏移量 + 该账户没藏掉的真实校准合计。老模型的曲线正是「摘掉校准的真实曲线 +
 *   （偏移量 + 校准合计）整条平移」，所以逐点相同；今天那个数也一个字不变。
 * - 没修饰的账户：每条没藏掉的真实校准配一条同日期同金额的「孪生」记录。老模型下这些
 *   账户的真实校准在外页面是算的；新模型真实校准一律不算，孪生把它补回来，逐点相同。
 * - 白条不参与；合计为 0 的记录不写（0 对曲线没影响，表里也不用留）。
 *
 * 一次性 SQL 按同样的规则写库（scripts/migrate-facade.sql，restore.dbtest.ts 在真 Postgres 上和这里逐行对过）。
 * 导入没有 facade_adjusts 这一节的老备份时也走它（csv.ts parseImport），否则整库恢复完外页面就不修饰了。
 */
export function migrateFacade(accounts: Account[], txs: Transaction[]): FacadeAdjust[] {
  const out: FacadeAdjust[] = []
  for (const a of accounts) {
    if (isCredit(a)) continue
    const adjusts = txs.filter((t) => t.type === 'adjust' && t.account_id === a.id && !t.hidden)
    if (a.facade_offset !== null) {
      const cents = a.facade_offset + adjusts.reduce((s, t) => s + t.amount, 0)
      if (cents) out.push({ id: facadeIdFor('offset', a.id), account_id: a.id, date: FACADE_EPOCH, cents, created_at: EPOCH_AT })
    } else {
      for (const t of adjusts) {
        if (t.amount) out.push({ id: facadeIdFor('twin', t.id), account_id: a.id, date: t.date, cents: t.amount, created_at: t.created_at })
      }
    }
  }
  return out
}

/**
 * 每个账户被「外面隐藏」的记录加起来对余额的影响（分）和笔数。
 * 只给里页面校准弹层那一行「隐藏金额汇总 · n 笔 −¥X」用，**纯展示，不进任何计算**
 * （用户 2026-09-18：「单纯告诉我罢了，又不是影响表里余额」）。
 * 用 balances 同一套规则算影响（收入 +、支出 −、转账两头、校准 +）；笔数按「这一笔碰到这个账户」数。
 */
export function hiddenSummary(txs: Transaction[], accounts: Account[]): Record<string, { cents: number; count: number }> {
  const hidden = txs.filter((t) => t.hidden)
  if (!hidden.length) return {}
  const eff = balances(hidden, accounts)
  const out: Record<string, { cents: number; count: number }> = {}
  for (const a of accounts) {
    const count = hidden.filter((t) => t.account_id === a.id || t.to_account_id === a.id).length
    if (count) out[a.id] = { cents: eff[a.id] ?? 0, count }
  }
  return out
}

/**
 * 每个账户最近一次真实校准的时间（created_at）。账户页副标题「上次校准 9/3 20:15」用它。
 *
 * 要拿**全量** txs 来算，两种模式都一样——这是 2026-09-16 用户指出的露馅点：
 * 外页面藏掉了校准记录之后，那些账户的副标题退回成「点此输入实际余额核对」，
 * 而没藏的账户照常显示日期，四个账户两种字，一眼看出哪两个动过手脚。
 * 只取时间不取金额，金额那条记录本身仍由 outerList 藏着。
 * 已知代价：外页面点「校准」记的是外页面校准记录、不产生真实校准，所以这个时间不会跟着刷新。
 *
 * adjust 只在「有差额」时才写，所以得到的是「上次校准」而不是「上次核对」。
 */
export function lastAdjustAt(txs: Transaction[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const t of txs) {
    if (t.type !== 'adjust' || !t.account_id) continue
    const cur = m.get(t.account_id)
    if (!cur || t.created_at > cur) m.set(t.account_id, t.created_at)
  }
  return m
}
