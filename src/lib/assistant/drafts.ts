// 记账卡片：AI 说的名字 → 真实的分类 / 账户 id，再校验成 App 能存的一笔 Transaction。纯函数。
// 规矩和记一笔页（Entry.tsx 的 validate / save）一致：金额 > 0、转账两头都要且不同、
// 分期只给白条上的支出、期数 1–60 且不超过金额的分数、抵消的分类用另一边的。
import { childrenOf, findAccount, findCat } from './book'
import type { DraftInput } from './protocol'
import { categoryKindOf } from '../compute'
import { parseAiYuan } from '../money'
import type { Account, Category, CatKind, Transaction } from '../../types'

export type DraftStatus = 'pending' | 'saving' | 'saved' | 'void'

export interface Draft {
  /** 对话里的代号（d1、d2…），AI 改卡片时用它指名 */
  key: string
  /** 存进去时用的流水 id：建卡时就定下，重试保存还是同一个，不会变两条 */
  txId: string
  kind: 'expense' | 'income' | 'transfer'
  offset: boolean
  parentId: string | null
  childId: string | null
  /** 这个一级下面有二级、还没选（AI 没给或给的对不上）：卡片上让用户挑，挑之前不能存 */
  needChild: boolean
  /** 用户明确选了「不细分」 */
  noChild: boolean
  amount: number | null
  accountId: string | null
  toAccountId: string | null
  installments: number
  date: string
  note: string
  status: DraftStatus
}

export interface DraftCtx {
  cats: readonly Category[]
  accounts: readonly Account[]
  /** 一级分类 id → 最近一次用的账户 id（book.lastAccountByParent） */
  lastAcc: ReadonlyMap<string, string>
  todayYmd: string
}

/** 这张卡的分类该从哪一边选：普通收支 = 自己那边，抵消 = 另一边，转账没有分类 */
export const catSideOf = (d: Pick<Draft, 'kind' | 'offset'>): CatKind | null => (d.kind === 'transfer' ? null : categoryKindOf({ type: d.kind, is_offset: d.offset }))

const isCredit = (accounts: readonly Account[], id: string | null) => Boolean(id && accounts.find((a) => a.id === id)?.kind === 'credit')

export function makeDraft(input: DraftInput, ctx: DraftCtx, key: string, txId: string): Draft {
  const base: Draft = {
    key,
    txId,
    kind: input.kind,
    offset: input.offset,
    parentId: null,
    childId: null,
    needChild: false,
    noChild: false,
    amount: parseAiYuan(input.amount),
    accountId: null,
    toAccountId: null,
    installments: 1,
    date: input.date && input.date <= ctx.todayYmd ? input.date : ctx.todayYmd,
    note: input.note,
    status: 'pending',
  }
  if (input.kind === 'transfer') {
    base.accountId = findAccount(ctx.accounts, input.account)?.id ?? null
    const to = findAccount(ctx.accounts, input.toAccount)?.id ?? null
    base.toAccountId = to && to !== base.accountId ? to : null
    return base
  }
  const side = catSideOf(base)!
  const c = findCat(ctx.cats, side, input.parent, input.child)
  if (c.ok) {
    base.parentId = c.parent.id
    base.childId = c.child?.id ?? null
    base.needChild = c.needChild
  }
  base.accountId = findAccount(ctx.accounts, input.account)?.id ?? (base.parentId ? ctx.lastAcc.get(base.parentId) ?? null : null)
  // 默认账户可能已经归档了
  if (base.accountId && !ctx.accounts.some((a) => a.id === base.accountId && !a.is_archived)) base.accountId = null
  if (base.kind === 'expense' && !base.offset && isCredit(ctx.accounts, base.accountId)) base.installments = input.installments
  return base
}

/** 能不能存；不能就说为什么（显示在卡片上，「记上」灰着） */
export function draftProblem(d: Draft, ctx: Pick<DraftCtx, 'accounts' | 'cats' | 'todayYmd'>): string | null {
  if (d.amount === null || d.amount <= 0) return '金额不对，点开改一下'
  if (d.date > ctx.todayYmd) return '日期不能晚于今天'
  if (d.kind === 'transfer') {
    if (!d.accountId || !d.toAccountId) return '选一下从哪转到哪'
    if (d.accountId === d.toAccountId) return '转出和转入不能是同一个账户'
    return null
  }
  if (!d.parentId) return '选一下分类'
  const side = catSideOf(d)
  const parent = ctx.cats.find((c) => c.id === d.parentId)
  if (!parent || parent.kind !== side || parent.is_archived) return '选一下分类'
  if (d.childId) {
    const child = ctx.cats.find((c) => c.id === d.childId)
    if (!child || child.parent_id !== d.parentId || child.is_archived) return '选一下分类'
  } else if (d.needChild && !d.noChild && childrenOf(ctx.cats, d.parentId).length) return '选一下二级分类'
  if (d.installments > 1) {
    if (d.kind !== 'expense' || d.offset || !isCredit(ctx.accounts, d.accountId)) return '只有白条上的支出能分期'
    if (d.installments > 60 || d.installments > d.amount) return '期数不对'
  }
  return null
}

/** 卡片 → 一笔流水（和记一笔页拼出来的字段一模一样；hidden 永远不打，「外面隐藏」只在记一笔页里设） */
export function draftToTx(d: Draft, accounts: readonly Account[], createdAt: string): Transaction {
  const transfer = d.kind === 'transfer'
  return {
    id: d.txId,
    date: d.date,
    type: d.kind,
    amount: d.amount ?? 0,
    account_id: d.accountId,
    to_account_id: transfer ? d.toAccountId : null,
    category_id: transfer ? null : d.childId ?? d.parentId,
    note: d.note.trim() || null,
    installments: !transfer && isCredit(accounts, d.accountId) ? d.installments : null,
    settles: null,
    hidden: null,
    is_offset: !transfer && d.offset ? true : null,
    created_at: createdAt,
  }
}
