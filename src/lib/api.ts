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

/** 把各种错误翻译成能给用户看的中文 */
export function friendlyError(e: unknown): string {
  const msg = (e as { message?: string })?.message ?? String(e)
  const code = (e as { code?: string })?.code
  if (/Invalid login credentials/i.test(msg)) return '邮箱或密码错误'
  if (/Email not confirmed/i.test(msg)) return '邮箱未确认，请联系管理员'
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(msg)) return '网络不通，请稍后再试'
  if (code === '23505' || /duplicate key/i.test(msg)) return '已有同名分类'
  if (code === '23514' || /violates check constraint/i.test(msg)) return '数据不合法（类型与字段不匹配）'
  if (/New password should be different/i.test(msg)) return '新密码不能和旧密码相同'
  if (/Password should be at least/i.test(msg)) return '密码太短，至少 6 位'
  if (/JWT|session|refresh_token|401/i.test(msg)) return '登录已过期，请重新登录'
  return msg || '未知错误'
}

// ---------- 读取 ----------

export async function fetchAll(): Promise<Snapshot> {
  const [a, c] = await Promise.all([
    supabase.from('accounts').select(ACC_COLS).order('sort'),
    supabase.from('categories').select(CAT_COLS).order('sort'),
  ])
  if (a.error) throw a.error
  if (c.error) throw c.error
  const transactions: Transaction[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('transactions')
      .select(TX_COLS)
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })
      .range(from, from + PAGE - 1)
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

// ---------- 导入（备份恢复 / 换库迁移） ----------

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
