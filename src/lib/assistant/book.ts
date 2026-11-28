// 助手看账本用的几个小工具：分类、账户按名字找回来，某一笔归哪个一级 / 二级。纯函数。
import type { Account, Category, CatKind, Transaction } from '../../types'

export interface Book {
  txs: readonly Transaction[]
  cats: readonly Category[]
  accounts: readonly Account[]
}

export interface CatPath {
  parent: Category
  child: Category | null
}

/** 这一笔的分类落在哪个一级 / 二级（直接记在一级上的 child = null）；没分类或分类找不到 = null */
export function catPathOf(t: Pick<Transaction, 'category_id'>, catById: ReadonlyMap<string, Category>): CatPath | null {
  const c = t.category_id ? catById.get(t.category_id) : undefined
  if (!c) return null
  if (!c.parent_id) return { parent: c, child: null }
  const p = catById.get(c.parent_id)
  return p ? { parent: p, child: c } : null
}

export const catMapOf = (cats: readonly Category[]) => new Map(cats.map((c) => [c.id, c]))

/** 「一级 · 二级」的名字（给AI看、给卡片显示） */
export function catLabel(p: CatPath | null): string {
  if (!p) return '未分类'
  return p.child ? `${p.parent.name}·${p.child.name}` : p.parent.name
}

export type CatFind =
  /** 对上了。child = null 时：needChild 表示这个一级下面有二级、AI 没给（或给的对不上），卡片上要让用户挑 */
  | { ok: true; parent: Category; child: Category | null; needChild: boolean }
  /** 一级没给、给了对不上、或者只给二级但二级名字在这一边有好几个：让用户自己选一级 */
  | { ok: false; reason: 'none' | 'nomatch' | 'ambiguous' }

/**
 * AI 说的一级 / 二级名字 → 分类。只在没归档的、这一边（支出 / 收入）的分类里找，名字原样对上。
 * - 一级给了：必须对上，对不上就是 nomatch（不拿二级去反推，免得「娱乐·交通」被改成别的一级）。
 * - 一级没给、二级给了：二级名字在这一边唯一时反推一级；不唯一是 ambiguous。
 * - 二级给了但在这个一级下面找不到：一级照用，needChild = true（让用户挑），**不悄悄记在一级上**。
 */
export function findCat(cats: readonly Category[], kind: CatKind, parentName: unknown, childName: unknown): CatFind {
  const live = cats.filter((c) => c.kind === kind && !c.is_archived)
  const roots = live.filter((c) => !c.parent_id)
  const pn = typeof parentName === 'string' ? parentName.trim() : ''
  const cn = typeof childName === 'string' ? childName.trim() : ''
  let parent: Category | null = null
  if (pn) {
    parent = roots.find((r) => r.name === pn) ?? null
    if (!parent) return { ok: false, reason: 'nomatch' }
  } else if (cn) {
    const hits = live.filter((c) => c.parent_id && c.name === cn)
    if (hits.length > 1) return { ok: false, reason: 'ambiguous' }
    if (hits.length === 1) parent = roots.find((r) => r.id === hits[0].parent_id) ?? null
    if (!parent) return { ok: false, reason: 'nomatch' }
  } else return { ok: false, reason: 'none' }
  const kids = childrenOf(cats, parent.id)
  const child = cn ? kids.find((c) => c.name === cn) ?? null : null
  return { ok: true, parent, child, needChild: !child && kids.length > 0 }
}

/** 一级下面的二级（没归档的，按 sort） */
export function childrenOf(cats: readonly Category[], parentId: string): Category[] {
  return cats.filter((c) => c.parent_id === parentId && !c.is_archived).sort((a, b) => a.sort - b.sort)
}

/**
 * 用户口头说的账户缩写（2026-11-28 用户给的）→ 账户全称里的关键词，按顺序试。招商银行不要缩写。
 * 键一律小写，比的时候不分大小写（「VX」「Vx」一样）。
 */
export const ACCOUNT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  vx: ['微信'],
  v: ['微信'],
  zfb: ['支付宝'],
  zh: ['中国银行', '中行'],
  pdd: ['拼多多'],
  jd: ['京东'],
  tb: ['淘宝'],
}

/** 发给 AI 的缩写对照：只列在这本账里对得上账户的（「vx=微信」），对不上的不列 */
export function aliasesOf(accounts: readonly Account[]): string[] {
  return Object.keys(ACCOUNT_ALIASES).flatMap((k) => {
    const a = findAccount(accounts, k)
    return a ? [`${k}=${a.name}`] : []
  })
}

/**
 * AI 说的账户名 → 账户。先整名对上；再按「/」拆开的别名对（「花呗」→「花呗/淘宝」）；
 * 最后才是包含关系，而且只认唯一的那一个（「银行」两个都包含，不猜）。
 */
export function findAccount(accounts: readonly Account[], name: unknown): Account | null {
  const n = typeof name === 'string' ? name.trim() : ''
  if (!n) return null
  const live = accounts.filter((a) => !a.is_archived)
  const exact = live.find((a) => a.name === n)
  if (exact) return exact
  const keys = ACCOUNT_ALIASES[n.toLowerCase()]
  if (keys) {
    for (const k of keys) {
      const hit = findAccount(accounts, k)
      if (hit) return hit
    }
    return null
  }
  const alias = live.filter((a) => a.name.split('/').some((p) => p.trim() === n))
  if (alias.length === 1) return alias[0]
  const loose = live.filter((a) => a.name.includes(n) || n.includes(a.name))
  return loose.length === 1 ? loose[0] : null
}

/** 每个一级分类最近一次用的账户（用户没说账户时的默认）。只看收支 */
export function lastAccountByParent(txs: readonly Transaction[], cats: readonly Category[]): Map<string, string> {
  const byId = catMapOf(cats)
  const out = new Map<string, { date: string; created: string; acc: string }>()
  for (const t of txs) {
    if ((t.type !== 'expense' && t.type !== 'income') || !t.account_id) continue
    const p = catPathOf(t, byId)
    if (!p) continue
    const cur = out.get(p.parent.id)
    if (!cur || t.date > cur.date || (t.date === cur.date && t.created_at > cur.created)) out.set(p.parent.id, { date: t.date, created: t.created_at, acc: t.account_id })
  }
  return new Map([...out].map(([k, v]) => [k, v.acc]))
}
