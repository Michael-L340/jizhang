// 所有余额与统计的纯函数。不依赖任何其他模块（date.ts 除外），方便单测。
import type { Account, Category, Transaction, TxType } from '../types'
import { addDays, dayInMonth, lastMonths, monthOf, monthRange, shiftMonth, today } from './date'

/** 收支统计只看这两种类型；transfer / adjust 永远不进收支 */
export function isFlow(t: Transaction): t is Transaction & { type: 'expense' | 'income' } {
  return t.type === 'expense' || t.type === 'income'
}

export function inMonth(t: Transaction, ym: string): boolean {
  return monthOf(t.date) === ym
}

/** 每个账户的当前余额（分） */
/** 把一笔流水累加进余额表。未指定账户的流水计入收支统计，但不影响任何账户余额。 */
export function applyTx(t: Transaction, out: Record<string, number>): void {
  if (!t.account_id) return
  switch (t.type) {
    case 'income':
    case 'adjust':
      out[t.account_id] = (out[t.account_id] ?? 0) + t.amount
      break
    case 'expense':
      out[t.account_id] = (out[t.account_id] ?? 0) - t.amount
      break
    case 'transfer':
      out[t.account_id] = (out[t.account_id] ?? 0) - t.amount
      if (t.to_account_id) out[t.to_account_id] = (out[t.to_account_id] ?? 0) + t.amount
      break
  }
}

export function balances(txs: Transaction[], accounts: Account[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const a of accounts) out[a.id] = 0
  for (const t of txs) applyTx(t, out)
  return out
}

export function totalOf(b: Record<string, number>): number {
  return Object.values(b).reduce((s, v) => s + v, 0)
}

export interface MonthSummary {
  income: number
  expense: number
  net: number
  /** 储蓄率 0-1；收入为 0 时 null */
  savingRate: number | null
}

export function monthSummary(txs: Transaction[], ym: string): MonthSummary {
  let income = 0
  let expense = 0
  for (const t of txs) {
    if (!isFlow(t) || !inMonth(t, ym)) continue
    if (t.type === 'income') income += t.amount
    else expense += t.amount
  }
  const net = income - expense
  return { income, expense, net, savingRate: income > 0 ? net / income : null }
}

/**
 * 分类查不到时用的兜底桶。
 *
 * 每笔账存的是分类编号不是名字，画饼图时要拿编号去分类表里查。查不到就跳过的话，
 * 这笔钱在「本月支出」里算了、在饼图里却没了，两个数字对不上而且毫无提示。
 * 数据库有外键挡着，正常情况下不会出现孤儿记录；但正确性不该押在别处，
 * 万一出现（手改过的备份、内存里短暂不一致、以后新增的写入路径），
 * 要让用户一眼看见「有一笔钱没归类」，而不是钱悄悄少了。
 */
export const UNCATEGORIZED_ID = '__uncategorized__'
export const UNCATEGORIZED_NAME = '未分类'

export interface CatAgg {
  id: string
  name: string
  icon: string | null
  amount: number
  count: number
  children: { id: string; name: string; amount: number; count: number }[]
}

/** 某月某类型按一级分类汇总（二级挂在 children），按金额降序 */
export function byCategory(
  txs: Transaction[],
  cats: Category[],
  ym: string,
  type: 'expense' | 'income',
): CatAgg[] {
  const byId = new Map(cats.map((c) => [c.id, c]))
  const agg = new Map<string, CatAgg>()
  const ensure = (id: string, name: string, icon: string | null): CatAgg => {
    let a = agg.get(id)
    if (!a) {
      a = { id, name, icon, amount: 0, count: 0, children: [] }
      agg.set(id, a)
    }
    return a
  }
  const addTo = (a: CatAgg, childId: string, childName: string, amount: number) => {
    a.amount += amount
    a.count += 1
    let ch = a.children.find((x) => x.id === childId)
    if (!ch) {
      ch = { id: childId, name: childName, amount: 0, count: 0 }
      a.children.push(ch)
    }
    ch.amount += amount
    ch.count += 1
  }
  for (const t of txs) {
    if (t.type !== type || !inMonth(t, ym)) continue
    // 分类查不到就归入「未分类」，绝不能 continue 当它不存在——
    // 那样这笔钱在「本月支出」里算了、在饼图里却没有，两个数字对不上且没有任何提示。
    // 这条等式必须无条件成立：本月支出 = 饼图各块之和。
    const c = t.category_id ? byId.get(t.category_id) : undefined
    if (!c) {
      addTo(ensure(UNCATEGORIZED_ID, UNCATEGORIZED_NAME, null), UNCATEGORIZED_ID, UNCATEGORIZED_NAME, t.amount)
      continue
    }
    const parent = c.parent_id ? byId.get(c.parent_id) ?? c : c
    const a = ensure(parent.id, parent.name, parent.icon)
    // 直接记在一级上（没选二级）的，归入「未细分」，否则下钻时会漏掉这部分钱
    const childId = c.id !== parent.id ? c.id : `${parent.id}:none`
    const childName = c.id !== parent.id ? c.name : '未细分'
    addTo(a, childId, childName, t.amount)
  }
  const list = [...agg.values()]
  for (const a of list) a.children.sort((x, y) => y.amount - x.amount)
  return list.sort((x, y) => y.amount - x.amount)
}

/** 某月每天的累计支出，返回长度 = 当月天数（未来的日子为 null） */
export function dailyCumulative(txs: Transaction[], ym: string, ref: string = today()): (number | null)[] {
  const { start, end } = monthRange(ym)
  const perDay = new Map<string, number>()
  for (const t of txs) {
    if (t.type !== 'expense' || !inMonth(t, ym)) continue
    perDay.set(t.date, (perDay.get(t.date) ?? 0) + t.amount)
  }
  const out: (number | null)[] = []
  let cum = 0
  for (let d = start; d <= end; d = addDays(d, 1)) {
    if (d > ref) {
      out.push(null)
      continue
    }
    cum += perDay.get(d) ?? 0
    out.push(cum)
  }
  return out
}

export type Unit = 'day' | 'month'

/** 生成时间桶：day 用 YYYY-MM-DD，month 用 YYYY-MM */
export function bucketKeys(start: string, end: string, unit: Unit): string[] {
  const out: string[] = []
  if (unit === 'day') {
    if (start > end) return [end]
    for (let d = start; d <= end; d = addDays(d, 1)) out.push(d)
  } else {
    const s0 = monthOf(start)
    const e0 = monthOf(end)
    if (s0 > e0) return [e0]
    for (let m = s0; m <= e0; m = shiftMonth(m, 1)) out.push(m)
  }
  return out
}

function keyOf(t: Transaction, unit: Unit): string {
  return unit === 'day' ? t.date : monthOf(t.date)
}

/** 每个时间桶的收入或支出合计 */
export function seriesTotals(txs: Transaction[], keys: string[], unit: Unit, type: 'expense' | 'income' = 'expense'): number[] {
  const idx = new Map(keys.map((k, i) => [k, i]))
  const out = new Array(keys.length).fill(0)
  for (const t of txs) {
    if (t.type !== type) continue
    const at = idx.get(keyOf(t, unit))
    if (at === undefined) continue
    out[at] += t.amount
  }
  return out
}

/** 每个时间桶、按一级分类拆分的合计；只返回区间内有金额的分类，按总额降序 */
export function seriesByCategory(
  txs: Transaction[],
  cats: Category[],
  keys: string[],
  unit: Unit,
  type: 'expense' | 'income' = 'expense',
): { id: string; name: string; total: number; data: number[] }[] {
  const byId = new Map(cats.map((c) => [c.id, c]))
  const idx = new Map(keys.map((k, i) => [k, i]))
  const acc = new Map<string, { name: string; data: number[]; total: number }>()
  for (const t of txs) {
    if (t.type !== type) continue
    const at = idx.get(keyOf(t, unit))
    if (at === undefined) continue
    // 同 byCategory：分类查不到归入「未分类」，不能让这笔钱从趋势图里静默消失
    const c = t.category_id ? byId.get(t.category_id) : undefined
    const rootId = c ? (c.parent_id ? byId.get(c.parent_id)?.id ?? c.id : c.id) : UNCATEGORIZED_ID
    const rootName = c ? (c.parent_id ? byId.get(c.parent_id)?.name ?? c.name : c.name) : UNCATEGORIZED_NAME
    let e = acc.get(rootId)
    if (!e) {
      e = { name: rootName, data: new Array(keys.length).fill(0), total: 0 }
      acc.set(rootId, e)
    }
    e.data[at] += t.amount
    e.total += t.amount
  }
  return [...acc.entries()]
    .map(([id, e]) => ({ id, name: e.name, total: e.total, data: e.data }))
    .sort((a, b) => b.total - a.total)
}

/** 最早一笔收支的日期，没有记录时返回今天 */
export function firstFlowDate(txs: Transaction[], ref: string = today()): string {
  let min: string | null = null
  for (const t of txs) if (isFlow(t) && (!min || t.date < min)) min = t.date
  return min ?? ref
}

/** 每个月的收入/支出合计，供月份选择器显示 */
export function monthTotals(txs: Transaction[]): Map<string, { expense: number; income: number }> {
  const m = new Map<string, { expense: number; income: number }>()
  for (const t of txs) {
    if (!isFlow(t)) continue
    const ym = monthOf(t.date)
    let e = m.get(ym)
    if (!e) {
      e = { expense: 0, income: 0 }
      m.set(ym, e)
    }
    if (t.type === 'expense') e.expense += t.amount
    else e.income += t.amount
  }
  return m
}

/** 有收支记录的月份，升序 */
export function monthsWithFlow(txs: Transaction[]): string[] {
  const set = new Set<string>()
  for (const t of txs) if (isFlow(t)) set.add(monthOf(t.date))
  return [...set].sort()
}

/** 最近 n 个月的收入/支出序列（含空月） */
export function monthlySeries(txs: Transaction[], endYm: string, n = 12): { ym: string; income: number; expense: number }[] {
  const months = lastMonths(n, endYm)
  const map = new Map(months.map((ym) => [ym, { ym, income: 0, expense: 0 }]))
  for (const t of txs) {
    if (!isFlow(t)) continue
    const row = map.get(monthOf(t.date))
    if (!row) continue
    if (t.type === 'income') row.income += t.amount
    else row.expense += t.amount
  }
  return months.map((ym) => map.get(ym)!)
}

/** 时间桶的结束日期：按日就是当天，按月是当月最后一天 */
export function bucketEnd(key: string, unit: Unit): string {
  return unit === 'day' ? key : monthRange(key).end
}

/**
 * 每个时间桶结束时的各账户余额与总额（从有记录以来累计，不受区间起点影响）。
 *
 * 合计**只加 accounts 里的账户**。别改回 totalOf(running)：applyTx 会给清单之外的
 * 账户也建一个键，统计页只传资产账户进来，白条的欠款就会悄悄混进「合计」，
 * 和首页「总资产」差出一个白条待还（2026-09-08 实测差 81.77，v1.1.0 白条上线就在了）。
 */
export function balanceSeries(
  txs: Transaction[],
  accounts: Account[],
  keys: string[],
  unit: Unit,
): { total: number[]; byAccount: Record<string, number[]> } {
  const sorted = [...txs].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const running: Record<string, number> = {}
  const byAccount: Record<string, number[]> = {}
  for (const a of accounts) {
    running[a.id] = 0
    byAccount[a.id] = []
  }
  const total: number[] = []
  let i = 0
  for (const k of keys) {
    const end = bucketEnd(k, unit)
    while (i < sorted.length && sorted[i].date <= end) {
      applyTx(sorted[i], running)
      i++
    }
    let sum = 0
    for (const a of accounts) {
      const v = running[a.id] ?? 0
      byAccount[a.id].push(v)
      sum += v
    }
    total.push(sum)
  }
  return { total, byAccount }
}

/** 某个一级分类下的二级，按最近使用倒序，从未用过的按 sort */
/**
 * 某个一级分类下的二级，按**用得多少**排，不是按最近用过谁。
 *
 * 原来按最近使用排，用户的反馈是「上一次用了一个不常用的，这一次那个就排第一」——
 * 偶尔记一笔夜宵，第二天早餐就被挤到后面去了，每次都要重新找。
 * 按次数排就稳定：一笔只让次数 +1，蹿不到用了几十次的前面。
 *
 * 三级排序，都能一句话说清：
 *   1. 用得多的在前
 *   2. 用得一样多的，最近用过的在前
 *   3. 一次都没用过的，按分类管理页里的原有顺序
 *
 * 注意不看日期只看条数：补记一笔上个月的账，和今天记一笔，对顺序的影响是一样的。
 */
export function childOrderByUse(txs: Transaction[], cats: Category[], parentId: string): Category[] {
  const children = cats.filter((c) => c.parent_id === parentId && !c.is_archived)
  const uses = new Map<string, number>()
  const lastUse = new Map<string, string>()
  for (const t of txs) {
    if (!t.category_id) continue
    uses.set(t.category_id, (uses.get(t.category_id) ?? 0) + 1)
    const key = `${t.date}T${t.created_at}`
    const prev = lastUse.get(t.category_id)
    if (!prev || key > prev) lastUse.set(t.category_id, key)
  }
  return children.sort((a, b) => {
    const na = uses.get(a.id) ?? 0
    const nb = uses.get(b.id) ?? 0
    if (na !== nb) return nb - na
    // 走到这里两边次数相同。次数相同就意味着「都用过」或「都没用过」，
    // 所以不必再判断「一个用过一个没用过」——那种情况上面一行已经分出胜负了。
    const ua = lastUse.get(a.id)
    const ub = lastUse.get(b.id)
    if (ua && ub && ua !== ub) return ua < ub ? 1 : -1
    return a.sort - b.sort
  })
}

/** 账户最近一次核对/校准的时间（ISO），没有则 null */
export function lastCheck(txs: Transaction[], accountId: string): string | null {
  let best: string | null = null
  for (const t of txs) {
    if (t.type === 'adjust' && t.account_id === accountId && (!best || t.created_at > best)) best = t.created_at
  }
  return best
}

/** 流水按日期分组（降序），附每日收支小计 */
export function groupByDay(txs: Transaction[]): { date: string; items: Transaction[]; expense: number; income: number }[] {
  const map = new Map<string, Transaction[]>()
  for (const t of txs) {
    const arr = map.get(t.date)
    if (arr) arr.push(t)
    else map.set(t.date, [t])
  }
  const days = [...map.keys()].sort().reverse()
  return days.map((date) => {
    const items = map.get(date)!.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    let expense = 0
    let income = 0
    for (const t of items) {
      if (t.type === 'expense') expense += t.amount
      if (t.type === 'income') income += t.amount
    }
    return { date, items, expense, income }
  })
}

/** 排序：日期降序，同日按创建时间降序 */
export function sortTxs(txs: Transaction[]): Transaction[] {
  return [...txs].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    return a.created_at < b.created_at ? 1 : -1
  })
}

export function typeSign(type: TxType): 1 | -1 | 0 {
  if (type === 'income') return 1
  if (type === 'expense') return -1
  return 0
}

/**
 * 记一笔页面「此刻该选中哪个分类」的兜底判断。支出大类、支出二级、收入分类三处共用。
 *
 * 规则：当前值仍在可选列表里就原样保留 → 否则退回记忆值（记忆值也得在列表里）→
 * 再不行取列表第一个 → 列表为空返回 null。
 * 归档掉一个大类后，页面上那排按钮一个都不高亮、下面挂的还是它的二级、点保存还能存进去，
 * 就是因为以前只判断「值为空才兜底」，没判断「值不为空但已经不在列表里」。
 *
 * ⚠️ editing 为 true 时原样返回 current，一个字都不许改。
 * 编辑一条旧记录时，分类是从那条记录本身回填的，而它用的分类完全可能已经被归档、
 * 不在列表里；这里要是「顺手纠正」一下，用户点「更新」就把这条历史记录的分类
 * 换成了另一个分类，而且毫不知情。和「新设备上编辑旧账把钱挪到中国银行」是同一类事故：
 * 兜底只许在新增时生效。
 */
export function pickCategoryId(o: {
  options: readonly { id: string }[]
  current: string | null
  remembered?: string | null
  editing: boolean
  /** 当前值和记忆值都用不了时，选列表第一个还是留空。留空 = 逼用户自己点一下 */
  fallbackFirst?: boolean
}): string | null {
  if (o.editing) return o.current
  const has = (id: string | null | undefined): id is string => !!id && o.options.some((c) => c.id === id)
  if (has(o.current)) return o.current
  if (has(o.remembered)) return o.remembered
  return o.fallbackFirst ? o.options[0]?.id ?? null : null
}

/**
 * 每个账户「本月进出多少、几笔」。给账户页每张卡的副标题用。
 *
 * 转账两头都算：从中行转到微信，中行是流出、微信是流入，两边都动了这个月的余额。
 * 校准（adjust）也算——它同样改变了余额，用户看到「本月 -1,271」应该能和余额变化对上。
 */
export function monthByAccount(txs: Transaction[], ym: string): Map<string, { delta: number; count: number }> {
  const out = new Map<string, { delta: number; count: number }>()
  const add = (id: string | null, delta: number): void => {
    if (!id) return
    const cur = out.get(id) ?? { delta: 0, count: 0 }
    out.set(id, { delta: cur.delta + delta, count: cur.count + 1 })
  }
  for (const t of txs) {
    if (!inMonth(t, ym)) continue
    if (t.type === 'income') add(t.account_id, t.amount)
    else if (t.type === 'expense') add(t.account_id, -t.amount)
    else if (t.type === 'adjust') add(t.account_id, t.amount)
    else if (t.type === 'transfer') {
      add(t.account_id, -t.amount)
      add(t.to_account_id, t.amount)
    }
  }
  return out
}

/** 各账户占总额的比例，只算正余额的部分（负余额画不进占比条）。合计为 0 时返回空数组。 */
export function balanceShares(bal: Record<string, number>, ids: string[]): { id: string; ratio: number }[] {
  const positives = ids.map((id) => ({ id, v: Math.max(0, bal[id] ?? 0) }))
  const total = positives.reduce((s, x) => s + x.v, 0)
  if (total <= 0) return []
  return positives.map(({ id, v }) => ({ id, ratio: v / total }))
}

// ---------- 白条 ----------

/** 白条账户：余额为负表示欠平台的钱 */
export function isCredit(a: Account): boolean {
  return a.kind === 'credit'
}

/** 资产账户和白条分开：账户页分两栏、记账页分两级、首页只把资产铺成卡 */
export function splitAccounts(accounts: Account[]): { assets: Account[]; credits: Account[] } {
  return { assets: accounts.filter((a) => !isCredit(a)), credits: accounts.filter(isCredit) }
}

/** 白条欠款合计（正数）。某个白条余额为正（多还了）不抵别家的欠款 */
export function debtOf(bal: Record<string, number>, credits: Account[]): number {
  return credits.reduce((s, a) => s + Math.max(0, -(bal[a.id] ?? 0)), 0)
}

export interface Installment {
  /** 第几期，从 1 起 */
  seq: number
  /** 共几期 */
  of: number
  /** 到期月 YYYY-MM */
  ym: string
  /** 到期日 YYYY-MM-DD */
  date: string
  /** 这一期的金额（分） */
  amount: number
}

/**
 * 一笔白条支出第 seq 期的到期日（seq 从 1 起）。
 *
 * 第 1 期 = 下单日之后最近的那个还款日，之后每期往后推一个月。
 * 京东还款日 17 号：9/6 下单 → 9/17 到期；9/20 下单 → 10/17。
 * **正好在还款日当天下单算下一个月的**——当天出账当天还不现实。
 *
 * repayDay 为空 = 这个账户没有固定还款日（拼多多先用后付，确认收货后几天逐笔扣）。
 * 这种不按月排期，到期日就是下单日本身；「还没还」由勾选结清来判定，
 * 见 dueOfTxInMonth。
 */
export function dueDateOf(date: string, repayDay: number | null, seq = 1): string {
  if (repayDay === null) return date
  const start = monthOf(date)
  // 先把还款日在下单那个月落实（填 31 时 2 月要落到 28），再和下单日比大小
  const first = date < dayInMonth(start, repayDay) ? start : shiftMonth(start, 1)
  return dayInMonth(shiftMonth(first, seq - 1), repayDay)
}

/**
 * 一笔白条支出的还款表。每期均分，除不尽的零头进最后一期。
 * installments 为空按 1 期算。到期日由 dueDateOf 按账户的还款日算。
 */
export function installmentPlan(
  t: Pick<Transaction, 'date' | 'amount' | 'installments'>,
  repayDay: number | null,
  /** 整单顺延一个还款日（本期已经还过款，平台把这单算进下一期）。见 paidThisCycle */
  defer = false,
): Installment[] {
  const n = Math.max(1, t.installments ?? 1)
  const base = Math.floor(t.amount / n)
  const rem = t.amount - base * n
  return Array.from({ length: n }, (_, i) => {
    const date = dueDateOf(t.date, repayDay, i + 1 + (defer && repayDay !== null ? 1 : 0))
    return { seq: i + 1, of: n, ym: monthOf(date), date, amount: base + (i === n - 1 ? rem : 0) }
  })
}

/**
 * 已经被某笔还款「勾选结清」的支出 id。
 * settles 挂在还款那一侧，所以删掉还款记录，这里自然就不再包含它了。
 */
export function settledIds(txs: Transaction[], ignoreRepayId?: string): Set<string> {
  const out = new Set<string>()
  for (const t of txs) {
    if (!t.settles || t.id === ignoreRepayId) continue
    for (const id of t.settles) out.add(id)
  }
  return out
}

/**
 * 「本期」的到期日 = 今天之后最近的那个还款日，**还款日当天算本期**。
 *
 * 和 dueDateOf 差一个等号：下单当天算下一期（当天出账当天还不现实），
 * 但还款日当天打开 App，你面对的正是今天要扣的这一笔。
 *
 * 这条把账单窗口从「日历月」换成「上一个还款日 → 下一个还款日」。旧口径下花呗
 * （还款日 1 号）9 月下的单第 1 期落在 10/1，于是「9 月账单」永远是空的——
 * 用户 2026-09-08 实测：面板整块空白，金额栏兜底填了全部欠款，看着像在催一次还清。
 *
 * repayDay 为 null（拼多多先用后付逐笔扣）没有「周期」这回事，返回 null。
 */
export function currentDueDate(todayStr: string, repayDay: number | null): string | null {
  if (repayDay === null) return null
  const d = dayInMonth(monthOf(todayStr), repayDay)
  return todayStr <= d ? d : dayInMonth(shiftMonth(monthOf(todayStr), 1), repayDay)
}

/**
 * 这笔白条支出下单时，它本来该归的那一期**是不是已经还过款了**。
 *
 * 是的话平台已经出了账单、这单只能进下一期，到期日整单顺延一个还款日。
 * 用户 2026-09-09 实测：9/9 还清 9/17 那期，当天再打白条，京东算的是 10/17。
 *
 * 判据只看**原始流水**——「(上一个还款日, 下单日] 之间有没有转进来过钱」，
 * 不看还款分配结果，所以不会和 creditBill 的「往前顶」互相咬：先定到期日，再分配。
 *
 * 同一天算「已还过」，不看录入先后：能还这期的账单说明账单早出了，当天买的东西
 * 平台本来就算下期；而录入顺序是可以补记的，不该拿它当业务判据。
 *
 * 只对开了 `defer_after_repay` 的账户生效（用户说只有京东这样），
 * 没有还款日的账户没有「周期」这回事，一律返回 false。
 *
 * 两条边界，都是这条规则拿「有没有还过款」当账单日的代价：
 * 1. App 读不到平台账单，只认你自己记的那笔转账。在平台还了钱却没记进来，规则不生效。
 * 2. **逾期还款会误伤**：8/17 那期拖到 8/20 才还，8/25 再下单会被推到 10/17，
 *    而平台那边多半还是 9/17——判据分不出这笔钱在还哪一期。按时或提前还款碰不到。
 */
export function paidThisCycle(t: Pick<Transaction, 'date'>, acc: Account, txs: Transaction[], ignoreRepayId?: string): boolean {
  if (!acc.defer_after_repay || acc.repay_day === null) return false
  const due = dueDateOf(t.date, acc.repay_day)
  const prevDue = dayInMonth(shiftMonth(monthOf(due), -1), acc.repay_day)
  return txs.some(
    (x) => x.type === 'transfer' && x.to_account_id === acc.id && x.id !== ignoreRepayId && x.date > prevDue && x.date <= t.date,
  )
}

/** 一期相对「本期」的位置 */
export type DueState = 'overdue' | 'current' | 'upcoming'

export interface BillRow {
  /** 这一行对应的那笔支出 */
  tx: Transaction
  /** 落在这一行的那一期（没有还款日的账户，seq/of 都是 1，到期日就是下单日） */
  due: Installment
  /** 能不能勾选结清：只有「一次还清」的订单能勾，分期按账单走 */
  selectable: boolean
  /** 逾期 / 本期 / 往后 */
  state: DueState
  /** 这一期被还款抵掉了多少（从最早一期往后顶算出来的），0 ≤ paid ≤ due.amount */
  paid: number
  /**
   * 本期还过一次款之后才下的单。
   *
   * 平台有账单周期，App 不知道那个截止日。还款日 17 号、13 号还完款、14 号又下一单，
   * 按「下单后最近的还款日」算它归本期，但实际上多半已经进了下一期账单——
   * 于是 App 显示「还差 ¥X」而平台那边其实已经结清了。
   * 逻辑不改（改了要引入账单日，那是另一个数据），只把这种行标出来让人自己判断。
   */
  afterRepay: boolean
}

export interface CreditBill {
  /** 本期该还的行 = 到期日正好是本期的 ＋ 之前逾期没还完的。逾期的排在前面 */
  rows: BillRow[]
  /** 往后还没到期的期，按到期日从近到远。灰色只读，勾上就是提前还 */
  upcoming: BillRow[]
  /** 本期到期日；null = 这个账户没有固定还款日 */
  dueDate: string | null
  /** rows 各行金额之和 */
  total: number
  /** 其中已经逾期的部分 */
  overdueTotal: number
  /** 分配到 rows 上的还款 */
  paid: number
  /** 还差多少，最少 0 */
  left: number
  /** 已经顶到 upcoming 上的钱，也就是提前还的部分 */
  prepaid: number
  /** rows 里「本期还过款之后才下的单」合计，可能实际上要下期才还 */
  afterRepayTotal: number
}

/**
 * 某个白条账户此刻的账单。面板按它来画：**一行 = 一期**，
 * 分期订单每期各占一行，所以各行加起来正好等于「本期该还」。
 *
 * 还款**从最早一期往后顶**，不再按「转账发生在哪个月」对账。旧口径漏了三种情况，
 * 都是 2026-09-08 实测出来的：提前还清之后每个月还继续要钱（而分期不能勾选结清，
 * 消都消不掉）、拼多多跨月还款不算数、京东逾期那一期下个月直接从账单里消失。
 *
 * 「勾选结清」优先于往前顶：settles 指名的那几单整单排除，剩下的钱才进队列，
 * 否则同一笔钱会扣两次。
 *
 * @param ignoreRepayId 正在修改的那笔还款。它的金额和它结清的订单都当作不存在，
 * 否则改勾选时那几单根本不显示、金额也预填不对。
 */
export function creditBill(txs: Transaction[], acc: Account, todayStr: string, ignoreRepayId?: string): CreditBill {
  const settled = settledIds(txs, ignoreRepayId)
  const dueDate = currentDueDate(todayStr, acc.repay_day)
  const amountOf = new Map(txs.map((t) => [t.id, t.amount]))
  // 本期窗口的起点，只用来判 afterRepay：上一个还款日之后、本期到期日之前的还款才算数
  const prevDue = dueDate === null || acc.repay_day === null ? null : dayInMonth(shiftMonth(monthOf(dueDate), -1), acc.repay_day)

  const flat: { tx: Transaction; due: Installment; selectable: boolean }[] = []
  const repayDates: string[] = []
  /** 没指明结清哪几单的还款，排队从最早一期往后顶 */
  let pool = 0
  for (const t of txs) {
    if (t.type === 'transfer' && t.to_account_id === acc.id) {
      if (t.id === ignoreRepayId) continue
      const allocated = (t.settles ?? []).reduce((s, id) => s + (amountOf.get(id) ?? 0), 0)
      pool += Math.max(0, t.amount - allocated)
      if (prevDue !== null && t.date > prevDue && t.date <= dueDate!) repayDates.push(t.date)
      continue
    }
    if (t.type !== 'expense' || t.account_id !== acc.id || settled.has(t.id)) continue
    const selectable = Math.max(1, t.installments ?? 1) === 1
    // 到期日先定死（只看原始流水），再去做还款往前顶，两步不互相咬
    // ignoreRepayId 也要传进去：点一笔还款进去改勾选时，看到的必须是「当它不存在」的账单，
    // 到期日同样得当它不存在——否则「改」和「删了再看」两条路会给出不同的排期
    for (const due of installmentPlan(t, acc.repay_day, paidThisCycle(t, acc, txs, ignoreRepayId))) flat.push({ tx: t, due, selectable })
  }

  // 到期日从早到晚排队，同一天按下单先后。往前顶就是按这个顺序发钱
  flat.sort((a, b) => (a.due.date === b.due.date ? (a.tx.created_at < b.tx.created_at ? -1 : 1) : a.due.date < b.due.date ? -1 : 1))

  const rows: BillRow[] = []
  const upcoming: BillRow[] = []
  for (const f of flat) {
    const paid = Math.min(pool, f.due.amount)
    pool -= paid
    const state: DueState =
      dueDate === null
        ? f.due.date <= todayStr
          ? 'current'
          : 'upcoming'
        : f.due.date < dueDate
          ? 'overdue'
          : f.due.date === dueDate
            ? 'current'
            : 'upcoming'
    // 只对有还款日的账户判：先用后付逐笔扣，没有「账单周期」这回事
    const afterRepay = state !== 'upcoming' && f.due.seq === 1 && repayDates.some((d) => d < f.tx.date)
    const row: BillRow = { ...f, state, paid, afterRepay }
    if (state === 'upcoming') upcoming.push(row)
    // 逾期但已经还完的不再列出来，否则拖过一年账单里会堆着十二行早就还清的历史。
    // 本期那一行还完了照样留着，「本期该还 6.66 / 已还 6.66」要看得见才知道自己没漏还
    else if (state === 'current' || paid < f.due.amount) rows.push(row)
  }

  // 逾期的排在本期前面；组内先按到期日（欠得最久的在最上面），同一天再按下单日期倒序，
  // 和流水页一致。比较器必须**自洽**：一张分期订单的每一期 tx.date / created_at 全都相同，
  // 拿「相等就返回 -1」那种写法排会被 sort 打乱（2026-09-08 实测第 3 期跑到了第 1 期前面）。
  const rank = (r: BillRow) => (r.state === 'overdue' ? 0 : 1)
  const cmp = (a: BillRow, b: BillRow) =>
    rank(a) - rank(b) ||
    (a.due.date < b.due.date ? -1 : a.due.date > b.due.date ? 1 : 0) ||
    (a.tx.date > b.tx.date ? -1 : a.tx.date < b.tx.date ? 1 : 0) ||
    (a.tx.created_at > b.tx.created_at ? -1 : a.tx.created_at < b.tx.created_at ? 1 : 0) ||
    a.due.seq - b.due.seq
  rows.sort(cmp)
  upcoming.sort(cmp)

  const total = rows.reduce((s, r) => s + r.due.amount, 0)
  const paid = rows.reduce((s, r) => s + r.paid, 0)
  return {
    rows,
    upcoming,
    dueDate,
    total,
    overdueTotal: rows.reduce((s, r) => s + (r.state === 'overdue' ? r.due.amount : 0), 0),
    paid,
    left: Math.max(0, total - paid),
    prepaid: upcoming.reduce((s, r) => s + r.paid, 0),
    afterRepayTotal: rows.reduce((s, r) => s + (r.afterRepay ? r.due.amount : 0), 0),
  }
}

/** 此刻各白条账户还差多少。还清了的不列出来 */
export function dueNow(txs: Transaction[], credits: Account[], todayStr: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const a of credits) {
    const left = creditBill(txs, a, todayStr).left
    if (left > 0) out.set(a.id, left)
  }
  return out
}

/**
 * 预告「再还这么多钱会抵到哪几期」。面板上跟着输入框实时变，
 * 让用户在按下「记这笔还款」之前就知道钱的去向，不用先记一笔再看。
 *
 * 分配规则和 creditBill 里的一模一样：从最早一期往后顶，跳过已经还完的。
 * 返回的最后一项若是 `null` 期，表示这笔钱比欠款还多，多出来的部分列在 extra。
 */
export function previewRepay(bill: CreditBill, cents: number): { hits: { due: Installment; amount: number }[]; extra: number } {
  const hits: { due: Installment; amount: number }[] = []
  let left = Math.max(0, cents)
  for (const r of [...bill.rows, ...bill.upcoming]) {
    if (left <= 0) break
    const need = r.due.amount - r.paid
    if (need <= 0) continue
    const amount = Math.min(left, need)
    left -= amount
    hits.push({ due: r.due, amount })
  }
  return { hits, extra: left }
}

/**
 * 把账单行按到期日分组。面板上「往后还有 N 期」一长条列下来，
 * 分期多了之后 11/1 和 12/1 的行混在一起看不出断点（用户 2026-09-08 反馈）。
 * 已经排好序，这里只是切段，不再排一次。
 */
export function groupByDue(rows: BillRow[]): { date: string; rows: BillRow[]; total: number }[] {
  const out: { date: string; rows: BillRow[]; total: number }[] = []
  for (const r of rows) {
    const last = out[out.length - 1]
    if (last && last.date === r.due.date) {
      last.rows.push(r)
      last.total += r.due.amount
    } else out.push({ date: r.due.date, rows: [r], total: r.due.amount })
  }
  return out
}
