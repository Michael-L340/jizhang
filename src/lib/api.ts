// ★ 全项目唯一接触 Supabase 的文件。换数据库只改这里。
// 对外只暴露业务函数；金额在这里完成 分 ↔ numeric 的转换。
import type { Account, Category, CatKind, Snapshot, Transaction, TxType } from '../types'
import { centsFromDb, centsToDb } from './money'
import { supabase } from './supabase'

interface TxRow {
  id: string
  date: string
  type: TxType
  amount: number | string
  account_id: string | null
  to_account_id: string | null
  category_id: string | null
  note: string | null
  created_at: string
}

const TX_COLS = 'id,date,type,amount,account_id,to_account_id,category_id,note,created_at'
const ACC_COLS = 'id,name,kind,sort,is_archived'
const CAT_COLS = 'id,kind,parent_id,name,icon,sort,is_archived,note'

function rowToTx(r: TxRow): Transaction {
  return { ...r, amount: centsFromDb(r.amount), note: r.note ?? null, account_id: r.account_id ?? null, to_account_id: r.to_account_id ?? null, category_id: r.category_id ?? null }
}

function txToRow(t: Transaction): TxRow {
  return {
    id: t.id,
    date: t.date,
    type: t.type,
    amount: centsToDb(t.amount),
    account_id: t.account_id,
    to_account_id: t.to_account_id,
    category_id: t.category_id,
    note: t.note,
    created_at: t.created_at,
  }
}

/**
 * 唯一索引冲突：同名的账户或分类已经存在（Postgres 23505）。
 * store.ts 靠它把「连点两次确定，第二次被数据库挡下」认成「已经建好了」而不是失败。
 */
export function isDuplicateName(e: unknown): boolean {
  const msg = (e as { message?: string })?.message ?? String(e)
  return (e as { code?: string })?.code === '23505' || /duplicate key/i.test(msg)
}

/** 把各种错误翻译成能给用户看的中文 */
export function friendlyError(e: unknown): string {
  const msg = (e as { message?: string })?.message ?? String(e)
  const code = (e as { code?: string })?.code
  if (/Invalid login credentials/i.test(msg)) return '邮箱或密码错误'
  if (/Email not confirmed/i.test(msg)) return '邮箱未确认，请联系管理员'
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(msg)) return '网络不通，请稍后再试'
  // 同步超时走的是 AbortError，message 是英文的 "The operation was aborted."，
  // 不翻译的话首次打开就超时时用户会看到一句英文报错
  if ((e as { name?: string })?.name === 'AbortError' || /abort/i.test(msg)) return '网络太慢，同步超时'
  if (isDuplicateName(e)) return '已有同名的账户或分类'
  if (code === '23514' || /violates check constraint/i.test(msg)) return '数据不合法（类型与字段不匹配）'
  if (/New password should be different/i.test(msg)) return '新密码不能和旧密码相同'
  if (/Password should be at least/i.test(msg)) return '密码太短，至少 6 位'
  if (/JWT|session|refresh_token|401/i.test(msg)) return '登录已过期，请重新登录'
  return msg || '未知错误'
}

// ---------- 读取 ----------

/**
 * 拉全量快照。signal 用于超时中止：supabase-js 默认的 fetch 没有超时，
 * iOS 在后台冻结页面时飞在路上的请求可能永远不 settle，不中止的话
 * store 里那把「正在同步」的锁就再也放不开了。三处查询都要挂 signal，
 * 尤其是分页循环里那个——最容易卡住的恰恰是它。
 */
export async function fetchAll(signal?: AbortSignal): Promise<Snapshot> {
  const withSignal = <T extends { abortSignal: (s: AbortSignal) => T }>(q: T): T => (signal ? q.abortSignal(signal) : q)
  const [a, c] = await Promise.all([
    withSignal(supabase.from('accounts').select(ACC_COLS).order('sort')),
    withSignal(supabase.from('categories').select(CAT_COLS).order('sort')),
  ])
  if (a.error) throw a.error
  if (c.error) throw c.error
  const transactions: Transaction[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await withSignal(
      supabase
        .from('transactions')
        .select(TX_COLS)
        .order('date', { ascending: false })
        .order('created_at', { ascending: false })
        // (date, created_at) 不唯一：导入的数据可能造出同值，跨页边界会重复或漏行。
        // 主键做 tiebreaker 构成全序，分页才稳定。
        .order('id', { ascending: false })
        .range(from, from + PAGE - 1),
    )
    if (error) throw error
    transactions.push(...(data as TxRow[]).map(rowToTx))
    if (data.length < PAGE) break
  }
  return { accounts: a.data as Account[], categories: c.data as Category[], transactions }
}

// ---------- 流水 ----------

export async function insertTx(t: Transaction): Promise<void> {
  const { error } = await supabase.from('transactions').insert(txToRow(t))
  if (error) throw error
}

export async function updateTx(t: Transaction): Promise<void> {
  const { id, created_at: _c, ...rest } = txToRow(t)
  const { error } = await supabase.from('transactions').update(rest).eq('id', id)
  if (error) throw error
}

export async function deleteTx(id: string): Promise<void> {
  const { error } = await supabase.from('transactions').delete().eq('id', id)
  if (error) throw error
}

// ---------- 分类 ----------

export async function addCategory(input: { kind: CatKind; parent_id: string | null; name: string; sort: number }): Promise<Category> {
  const { data, error } = await supabase.from('categories').insert(input).select(CAT_COLS).single()
  if (error) throw error
  return data as Category
}

export async function updateCategory(id: string, patch: Partial<Pick<Category, 'name' | 'icon' | 'sort' | 'is_archived' | 'note' | 'parent_id'>>): Promise<void> {
  const { error } = await supabase.from('categories').update(patch).eq('id', id)
  if (error) throw error
}

// ---------- 账户 ----------

export async function updateAccount(id: string, patch: Partial<Pick<Account, 'name' | 'sort' | 'is_archived'>>): Promise<void> {
  const { error } = await supabase.from('accounts').update(patch).eq('id', id)
  if (error) throw error
}

// ---------- 导入与恢复（备份还原 / 换库迁移） ----------

/**
 * 危险：清空当前登录账号的全部数据。只给「整库恢复」用，调用方必须先拿到完整备份。
 *
 * 顺序不能反（以下都由 npm run test:db 在真的 Postgres 上实测过）：
 * - transactions.account_id / category_id 都是 on delete restrict，先删账户或分类会被拒绝。
 * - categories.parent_id 也是 restrict，只删一级、留着二级同样会被拒绝。
 *
 * 二级和一级分两步删，是因为 PostgREST 每次调用只发一条带过滤条件的 DELETE，
 * 顺序必须由我们显式写出来。（注：restrict 的检查发生在**语句结束时**，所以
 * 一条不带过滤的 `delete from categories` 把父子一起删其实是能成功的；
 * 它和 no action 的区别是能否延迟到**事务**结束，不是语句结束。分两步更保险也更好读。）
 *
 * PostgREST 不允许无条件 delete，每条都带一个「匹配全部」的过滤条件；RLS 保证只删自己的行。
 */
export async function wipeAll(): Promise<void> {
  const tx = await supabase.from('transactions').delete().not('id', 'is', null)
  if (tx.error) wipeFailed('transactions', tx.error)
  const child = await supabase.from('categories').delete().not('parent_id', 'is', null)
  if (child.error) wipeFailed('child_categories', child.error)
  const root = await supabase.from('categories').delete().is('parent_id', null)
  if (root.error) wipeFailed('root_categories', root.error)
  const acc = await supabase.from('accounts').delete().not('id', 'is', null)
  if (acc.error) wipeFailed('accounts', acc.error)
}

/**
 * wipeAll 抛的错会挂上 step，指出是删到哪一步炸的。
 * 用处只有一个但很要紧：step === 'transactions' 表示**第一句就失败了，云端一行都没删**，
 * 调用方据此可以老实告诉用户「账本原封不动」，而不是吓人的「可能只剩一半」。
 * 这四个删除不是一个事务，别的 step 都意味着已经删掉了一部分。
 */
export type WipeStep = 'transactions' | 'child_categories' | 'root_categories' | 'accounts'
export interface WipeFailure extends Error {
  step: WipeStep
}

function wipeFailed(step: WipeStep, cause: unknown): never {
  const e = new Error(friendlyError(cause)) as WipeFailure
  e.step = step
  e.cause = cause
  throw e
}

/**
 * 按 id 合并写入（同 id 覆盖，不删任何东西）。不是事务：每 500 条一批逐批提交，
 * 中途失败前面的批次已经在云端，重跑同一个文件是安全的（upsert 幂等）。
 * 金额在 txToRow 里过 centsToDb，整数「分」→ numeric 字符串，这是全项目唯一的转换点。
 */
export async function importAll(snap: Snapshot): Promise<void> {
  const acc = await supabase.from('accounts').upsert(snap.accounts, { onConflict: 'id' })
  if (acc.error) throw acc.error
  const parents = snap.categories.filter((c) => !c.parent_id)
  const children = snap.categories.filter((c) => c.parent_id)
  const p = await supabase.from('categories').upsert(parents, { onConflict: 'id' })
  if (p.error) throw p.error
  if (children.length) {
    const ch = await supabase.from('categories').upsert(children, { onConflict: 'id' })
    if (ch.error) throw ch.error
  }
  const rows = snap.transactions.map(txToRow)
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from('transactions').upsert(rows.slice(i, i + 500), { onConflict: 'id' })
    if (error) throw error
  }
}

// ---------- 登录 ----------

export async function signIn(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw error
}

/** 修改当前登录账号的密码 */
export async function changePassword(newPassword: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password: newPassword })
  if (error) throw error
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut()
}

export async function hasSession(): Promise<boolean> {
  const { data } = await supabase.auth.getSession()
  return Boolean(data.session)
}

export function onAuthChange(cb: (signedIn: boolean) => void): () => void {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => cb(Boolean(session)))
  return () => data.subscription.unsubscribe()
}

export { configured } from './supabase'
