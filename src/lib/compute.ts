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
export function installmentPlan(t: Pick<Transaction, 'date' | 'amount' | 'installments'>, repayDay: number | null): Installment[] {
  const n = Math.max(1, t.installments ?? 1)
  const base = Math.floor(t.amount / n)
  const rem = t.amount - base * n
  return Array.from({ length: n }, (_, i) => {
    const date = dueDateOf(t.date, repayDay, i + 1)
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
 * 一笔白条支出在 ym 这个月该还多少（0 = 这个月不用还）。
 *
 * 两种账户两套判据：
 * - 有还款日（京东/花呗/美团）：按 installmentPlan 排期，落在这个月的那一期
 * - 没有还款日（拼多多先用后付）：不排期，只要没被勾选结清，从下单那个月起一直算欠着
 */
function dueOfTxInMonth(t: Transaction, acc: Account, ym: string, settled: ReadonlySet<string>): number {
  if (settled.has(t.id)) return 0
  if (acc.repay_day === null) return monthOf(t.date) <= ym ? t.amount : 0
  return installmentPlan(t, acc.repay_day).find((p) => p.ym === ym)?.amount ?? 0
}

/**
 * 某月各白条账户还应还多少。
 *
 * = 该月到期且未结清的各期之和 − 该月转进这个白条、但**没指明结清哪几单**的钱。
 *
 * 后半截那个「没指明」是关键：整体还账单时转账不带 settles，全额都要减，否则还完一笔
 * 再打开弹层仍会预填整月账单，再点一次就多还一笔；而勾选结清时那几单已经被前半截
 * 排除掉了，转账里对应的部分不能再减一遍，否则同一笔钱扣两次。
 *
 * 还清（或多还）的不再列出来。
 */
export function dueInMonth(txs: Transaction[], credits: Account[], ym: string): Map<string, number> {
  const byId = new Map(credits.map((a) => [a.id, a]))
  const settled = settledIds(txs)
  const amountOf = new Map(txs.map((t) => [t.id, t.amount]))
  const planned = new Map<string, number>()
  const paid = new Map<string, number>()
  for (const t of txs) {
    if (t.type === 'transfer' && t.to_account_id && byId.has(t.to_account_id) && monthOf(t.date) === ym) {
      const allocated = (t.settles ?? []).reduce((s, id) => s + (amountOf.get(id) ?? 0), 0)
      const rest = Math.max(0, t.amount - allocated)
      paid.set(t.to_account_id, (paid.get(t.to_account_id) ?? 0) + rest)
      continue
    }
    if (t.type !== 'expense' || !t.account_id) continue
    const acc = byId.get(t.account_id)
    if (!acc) continue
    const due = dueOfTxInMonth(t, acc, ym, settled)
    if (due > 0) planned.set(acc.id, (planned.get(acc.id) ?? 0) + due)
  }
  const out = new Map<string, number>()
  for (const [id, v] of planned) {
    const left = v - (paid.get(id) ?? 0)
    if (left > 0) out.set(id, left)
  }
  return out
}

export interface BillRow {
  /** 这一行对应的那笔支出 */
  tx: Transaction
  /** 落在这个月的那一期（没有还款日的账户，seq/of 都是 1，到期日就是下单日） */
  due: Installment
  /** 能不能勾选：只有「一次还清」的订单能勾，分期按账单走 */
  selectable: boolean
  /**
   * 本月已经还过一次款之后才下的单。
   *
   * 平台有账单周期，App 不知道那个截止日。还款日 17 号、13 号还完款、14 号又下一单，
   * 按「下单后最近的还款日」算它归本月，但实际上多半已经进了下一期账单——
   * 于是 App 显示「这个月还差 ¥X」而平台那边其实已经结清了。
   * 逻辑不改（改了要引入账单日，那是另一个数据），只把这种行标出来让人自己判断。
   */
  afterRepay: boolean
}

export interface MonthBill {
  rows: BillRow[]
  /** 本月该还合计 = rows 的金额之和 */
  total: number
  /** 其中「本月还过款之后才下单」的金额，可能实际上要下期才还 */
  afterRepayTotal: number
  /** 本月已经转进这个白条的钱（全额，含已指明结清的部分） */
  paid: number
  /** 还差多少，最少 0 */
  left: number
}

/**
 * 某个白条账户在 ym 这个月的账单。面板按它来画：**一行 = 这个月该还的一笔**，
 * 分期订单只出本期那一份，所以各行加起来正好等于「本月该还」。
 * 一行 = 一整个订单的话，分期订单显示整单金额，勾选加总就和本月应还对不上了。
 */
/**
 * @param ignoreRepayId 正在修改的那笔还款。它结清的订单要重新出现在账单里，
 * 否则改勾选时那几单根本不显示，想取消都取消不了。
 */
export function monthBill(txs: Transaction[], acc: Account, ym: string, ignoreRepayId?: string): MonthBill {
  const settled = settledIds(txs, ignoreRepayId)
  const rows: Omit<BillRow, 'afterRepay'>[] = []
  const repayDates: string[] = []
  let paid = 0
  for (const t of txs) {
    if (t.type === 'transfer' && t.to_account_id === acc.id && monthOf(t.date) === ym) {
      paid += t.amount
      repayDates.push(t.date)
      continue
    }
    if (t.type !== 'expense' || t.account_id !== acc.id || settled.has(t.id)) continue
    const n = Math.max(1, t.installments ?? 1)
    if (acc.repay_day === null) {
      if (monthOf(t.date) <= ym) rows.push({ tx: t, due: { seq: 1, of: 1, ym, date: t.date, amount: t.amount }, selectable: true })
      continue
    }
    const hit = installmentPlan(t, acc.repay_day).find((p) => p.ym === ym)
    if (hit) rows.push({ tx: t, due: hit, selectable: n === 1 })
  }
  // 只对有还款日的账户判：先用后付逐笔扣，没有「账单周期」这回事
  const marked: BillRow[] = rows.map((r) => ({
    ...r,
    afterRepay: acc.repay_day !== null && r.due.seq === 1 && repayDates.some((d) => d < r.tx.date),
  }))
  marked.sort((a, b) => (a.tx.date === b.tx.date ? (a.tx.created_at < b.tx.created_at ? 1 : -1) : a.tx.date < b.tx.date ? 1 : -1))
  const total = marked.reduce((s, r) => s + r.due.amount, 0)
  const afterRepayTotal = marked.reduce((s, r) => s + (r.afterRepay ? r.due.amount : 0), 0)
  return { rows: marked, total, afterRepayTotal, paid, left: Math.max(0, total - paid) }
}

export interface ActivePlan {
  tx: Transaction
  plan: Installment[]
  /** 本月到期的那一期，没有则 null */
  current: Installment | null
  /** 本月之前已到期的期数 */
  done: number
}

/** 某个白条账户上还没还完的分期（最后一期到期月 ≥ 本月），按下单日期倒序。已勾选结清的不再列出 */
export function activePlans(txs: Transaction[], acc: Account, ym: string): ActivePlan[] {
  const settled = settledIds(txs)
  const out: ActivePlan[] = []
  for (const t of txs) {
    if (t.type !== 'expense' || t.account_id !== acc.id || settled.has(t.id)) continue
    const plan = installmentPlan(t, acc.repay_day)
    if (plan[plan.length - 1].ym < ym) continue
    out.push({ tx: t, plan, current: plan.find((p) => p.ym === ym) ?? null, done: plan.filter((p) => p.ym < ym).length })
  }
  return out.sort((a, b) => (a.tx.date === b.tx.date ? (a.tx.created_at < b.tx.created_at ? 1 : -1) : a.tx.date < b.tx.date ? 1 : -1))
}
