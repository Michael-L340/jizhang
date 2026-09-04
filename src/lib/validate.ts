// 导入文件的「落地前校验」。纯函数，不联网，node 里能直接跑。
//
// 为什么非要有这一层：「整库恢复」的顺序是 wipeAll() → importAll()，云端**先被清空**，
// 再按文件重建。文件里只要有一行数据库不接受，导入就会在半路抛错——而账本已经没了。
// 数据库自己的外键、唯一索引、check、触发器都只在写入那一刻才说话，那时已经晚了。
// 所以这里把 supabase/migrations/ 里的约束在内存里先跑一遍，一条不过就整份拒绝、一个字节都不往云端发。
//
// 每条规则都对应一句真实的 SQL。改了 supabase/migrations/ 就要回来同步，并跑 npm run test:db——
// 那里有一条测试专门证明「凡是这里放行的文件，都能真的写进 Postgres」。
//   accounts      unique(user_id,name)、kind check、sort smallint、id 是 uuid 列
//   categories    cat_root_uniq、cat_child_uniq、categories_depth_guard、kind check
//   transactions  tx_shape（0002 版）、tx_category_kind_guard、三个外键、numeric(12,2)、date
//
// 报错必须是人话，还要指出第几条、哪个字段、什么问题：真出事那天，用户是一个人
// 举着手机看着这句话决定下一步怎么办的。只报第一个错，报一串没人看得完。
import type { Account, CatKind, Category, Snapshot, Transaction, TxType } from '../types'
import { TX_TYPE_LABEL } from '../types'

const KIND_LABEL: Record<CatKind, string> = { expense: '支出', income: '收入' }
const TX_TYPES = ['expense', 'income', 'transfer', 'adjust']
const CAT_KINDS = ['expense', 'income']
const ACC_KINDS = ['bank', 'wallet']

/** accounts.sort / categories.sort 都是 smallint */
const SORT_MIN = -32768
const SORT_MAX = 32767
/** transactions.amount 是 numeric(12,2)：小数点前最多 10 位，也就是 ±9,999,999,999.99 元 */
export const MAX_CENTS = 999_999_999_999

type Raw = Record<string, unknown>

function asRow(v: unknown): Raw | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null
}

/** 三张表的 id 都是 uuid 列，'a1' 这种字符串进不去（Postgres 报 22P02） */
function isUuid(v: unknown): v is string {
  return typeof v === 'string' && (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) || /^[0-9a-f]{32}$/i.test(v))
}

function daysIn(y: number, m: number): number {
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
}

/** 正则通过不等于这一天存在：2025-02-30、2025-13-45、0000-00-00 全都能过日期正则 */
function isRealDate(s: string): boolean {
  const y = Number(s.slice(0, 4))
  const m = Number(s.slice(5, 7))
  const d = Number(s.slice(8, 10))
  if (y < 1 || m < 1 || m > 12 || d < 1) return false
  return d <= daysIn(y, m)
}

/** created_at 是 timestamptz not null，写进去的必须是数据库认得的时间 */
function isTimestamp(v: unknown): v is string {
  if (typeof v !== 'string') return false
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2}?)?$/.test(v)) return false
  return isRealDate(v.slice(0, 10)) && !Number.isNaN(Date.parse(v))
}

type Fail = (why: string) => never

const failer =
  (prefix: string): Fail =>
  (why) => {
    throw new Error(`${prefix}${why}`)
  }

/** sort 缺省按数据库默认值 0；给了就必须是 smallint 装得下的整数 */
function sortOf(v: unknown, fail: Fail): number {
  const n: unknown = v ?? 0
  if (typeof n !== 'number' || !Number.isInteger(n) || n < SORT_MIN || n > SORT_MAX) {
    fail(`的排序值不对（读到 ${JSON.stringify(v)}），只能是 ${SORT_MIN} 到 ${SORT_MAX} 之间的整数`)
  }
  return n
}

/** is_archived 缺省按数据库默认值 false */
function archivedOf(v: unknown, fail: Fail): boolean {
  const b: unknown = v ?? false
  if (typeof b !== 'boolean') fail(`的归档标记不是 true 或 false（读到 ${JSON.stringify(v)}）`)
  return b as boolean
}

/** 可空文本列：缺失和 null 一样，都写 null */
function textOf(v: unknown, name: string, fail: Fail): string | null {
  const s: unknown = v ?? null
  if (s !== null && typeof s !== 'string') fail(`的${name}不是文字（读到 ${JSON.stringify(v)}）`)
  return s as string | null
}

/** 可空的外键列：缺失和 null 一样 */
function refOf(v: unknown, name: string, fail: Fail): string | null {
  const s: unknown = v ?? null
  if (s === null) return null
  if (!isUuid(s)) fail(`的${name}「${String(s)}」不是合法的 UUID，数据库不接受`)
  return s as string
}

// ── 逐行：把一行原始 JSON 收成本程序认识的形状，顺便查掉所有单行就能查的约束 ──
// 只挑数据库真有的那几列（等同 api.ts 里的 ACC_COLS / CAT_COLS / TX_COLS）：
// 多出来的键会让 PostgREST 报「column ... does not exist」，缺掉的键在批量 upsert 里会被写成 NULL。

function readAccount(v: unknown, i: number): Account {
  const fail: Fail = failer(`备份文件第 ${i + 1} 个账户`)
  const r = asRow(v)
  if (!r) fail('不是一条记录，文件可能已损坏')
  if (typeof r.id !== 'string' || typeof r.name !== 'string') fail('缺少 id 或名称，文件可能已损坏')
  if (!isUuid(r.id)) fail(`的 id「${String(r.id)}」不是合法的 UUID，数据库不接受`)
  const kind: unknown = r.kind ?? 'bank'
  if (typeof kind !== 'string' || !ACC_KINDS.includes(kind)) fail(`的种类「${String(r.kind)}」不认识，只能是 bank 或 wallet`)
  return {
    id: r.id as string,
    name: r.name as string,
    kind: kind as Account['kind'],
    sort: sortOf(r.sort, fail),
    is_archived: archivedOf(r.is_archived, fail),
  }
}

function readCategory(v: unknown, i: number): Category {
  const fail: Fail = failer(`备份文件第 ${i + 1} 个分类`)
  const r = asRow(v)
  if (!r) fail('不是一条记录，文件可能已损坏')
  if (typeof r.id !== 'string' || typeof r.name !== 'string') fail('缺少 id 或名称，文件可能已损坏')
  if (!isUuid(r.id)) fail(`的 id「${String(r.id)}」不是合法的 UUID，数据库不接受`)
  const kind: unknown = r.kind
  if (typeof kind !== 'string' || !CAT_KINDS.includes(kind)) fail(`「${String(r.name)}」的类型「${String(kind)}」不认识，只能是 expense 或 income`)
  return {
    id: r.id as string,
    kind: kind as CatKind,
    parent_id: refOf(r.parent_id, '上级分类 id', fail),
    name: r.name as string,
    icon: textOf(r.icon, '图标', fail),
    sort: sortOf(r.sort, fail),
    is_archived: archivedOf(r.is_archived, fail),
    note: textOf(r.note, '说明', fail),
  }
}

function readTransaction(v: unknown, i: number): Transaction {
  const fail: Fail = failer(`备份文件第 ${i + 1} 条流水`)
  const r = asRow(v)
  if (!r) fail('不是一条记录，文件可能已损坏')
  if (typeof r.id !== 'string') fail('缺少 id，文件可能已损坏')
  if (!isUuid(r.id)) fail(`的 id「${String(r.id)}」不是合法的 UUID，数据库不接受`)
  const date: unknown = r.date
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`的日期格式不对（读到 ${JSON.stringify(r.date)}），应该长得像 2026-09-04`)
  if (!isRealDate(date as string)) fail(`的日期是 ${String(date)}，这一天不存在`)
  const type: unknown = r.type
  if (typeof type !== 'string' || !TX_TYPES.includes(type)) fail(`的类型不认识（读到 ${JSON.stringify(r.type)}），只能是 expense / income / transfer / adjust`)
  const amount: unknown = r.amount
  if (!Number.isInteger(amount)) fail(`的金额不是整数分（读到 ${String(amount)}）。备份里 12.50 元要写成 1250`)
  if (Math.abs(amount as number) > MAX_CENTS) fail(`的金额 ${String(amount)} 分超出数据库能存的范围（最多 ±9,999,999,999.99 元）`)
  if (!isTimestamp(r.created_at)) fail(`的记录时间不是合法的时间（读到 ${JSON.stringify(r.created_at)}）`)
  return {
    id: r.id as string,
    date: date as string,
    type: type as TxType,
    amount: amount as number,
    account_id: refOf(r.account_id, '账户 id', fail),
    to_account_id: refOf(r.to_account_id, '转入账户 id', fail),
    category_id: refOf(r.category_id, '分类 id', fail),
    note: textOf(r.note, '备注', fail),
    created_at: r.created_at as string,
  }
}

// ── 跨行：外键、唯一索引、触发器，这些都要看过整份文件才知道 ──

function checkAccounts(accounts: Account[]): void {
  const ids = new Set<string>()
  const names = new Set<string>()
  accounts.forEach((a, i) => {
    const fail: Fail = failer(`备份文件第 ${i + 1} 个账户`)
    if (ids.has(a.id)) fail(`的 id 和前面某个账户重复了（${a.id}）`)
    // accounts unique(user_id, name)：同名账户建不出第二个，归档了也算
    if (names.has(a.name)) fail(`「${a.name}」的名字和前面的账户重复了，数据库不允许两个同名账户`)
    ids.add(a.id)
    names.add(a.name)
  })
}

function checkCategories(categories: Category[]): void {
  const byId = new Map(categories.map((c) => [c.id, c]))
  const ids = new Set<string>()
  const roots = new Set<string>()
  const children = new Set<string>()
  categories.forEach((c, i) => {
    const fail: Fail = failer(`备份文件第 ${i + 1} 个分类`)
    if (ids.has(c.id)) fail(`的 id 和前面某个分类重复了（${c.id}）`)
    ids.add(c.id)
    if (c.parent_id === null) {
      // cat_root_uniq (user_id, kind, name) where parent_id is null
      const key = `${c.kind} ${c.name}`
      if (roots.has(key)) fail(`「${c.name}」和前面另一个${KIND_LABEL[c.kind]}一级分类重名了，数据库不允许`)
      roots.add(key)
      return
    }
    // categories_depth_guard：父分类要存在、父分类自己不能再有父、父子 kind 必须一致
    if (c.parent_id === c.id) fail(`「${c.name}」的上级分类填的是它自己`)
    const p = byId.get(c.parent_id)
    if (!p) fail(`「${c.name}」的上级分类在这个文件里找不到（id=${c.parent_id}）`)
    if (p.parent_id !== null) fail(`「${c.name}」的上级分类「${p.name}」自己还有上级，分类最多两级`)
    if (p.kind !== c.kind) fail(`「${c.name}」是${KIND_LABEL[c.kind]}分类，上级「${p.name}」却是${KIND_LABEL[p.kind]}分类，父子必须一致`)
    // cat_child_uniq (user_id, parent_id, name) where parent_id is not null
    const key = `${c.parent_id} ${c.name}`
    if (children.has(key)) fail(`「${c.name}」在同一个上级分类「${p.name}」下面重名了，数据库不允许`)
    children.add(key)
  })
}

function checkTransactions(tx: Transaction[], accounts: Account[], categories: Category[]): void {
  const accIds = new Set(accounts.map((a) => a.id))
  const catById = new Map(categories.map((c) => [c.id, c]))
  const ids = new Set<string>()
  tx.forEach((t, i) => {
    const fail: Fail = failer(`备份文件第 ${i + 1} 条流水`)
    const label = TX_TYPE_LABEL[t.type]
    if (ids.has(t.id)) fail(`的 id 和前面某一条流水重复了（${t.id}）`)
    ids.add(t.id)

    // tx_shape（0002 版）：每种类型该填哪几个字段，是 check 约束逐字写死的
    if (t.type === 'expense' || t.type === 'income') {
      if (t.category_id === null) fail(`是${label}，但没有分类。${label}必须有分类`)
      if (t.to_account_id !== null) fail(`是${label}，却填了转入账户。只有转账才有转入账户`)
      if (t.amount <= 0) fail(`是${label}，金额却是 ${t.amount} 分。${label}的金额必须大于 0`)
    } else if (t.type === 'transfer') {
      if (t.category_id !== null) fail('是转账，却填了分类。转账不进收支统计，不能有分类')
      if (t.account_id === null) fail('是转账，但没有转出账户')
      if (t.to_account_id === null) fail('是转账，但没有转入账户')
      if (t.account_id === t.to_account_id) fail('是转账，转出和转入却是同一个账户')
      if (t.amount <= 0) fail(`是转账，金额却是 ${t.amount} 分，必须大于 0`)
    } else {
      if (t.account_id === null) fail('是余额校准，但没有账户。校准就是把某个账户改成实际余额，不能不指定账户')
      if (t.category_id !== null) fail('是余额校准，却填了分类')
      if (t.to_account_id !== null) fail('是余额校准，却填了转入账户')
    }

    // 三个外键。整库恢复是先清空再重建，云端不会有别的行兜着，引用的东西必须在同一个文件里
    if (t.account_id !== null && !accIds.has(t.account_id)) fail(`用的账户在这个文件里找不到（id=${t.account_id}），恢复时会被外键拒绝`)
    if (t.to_account_id !== null && !accIds.has(t.to_account_id)) fail(`转入的账户在这个文件里找不到（id=${t.to_account_id}），恢复时会被外键拒绝`)
    if (t.category_id !== null) {
      const c = catById.get(t.category_id)
      if (!c) fail(`用的分类在这个文件里找不到（id=${t.category_id}），恢复时会被外键拒绝`)
      // tx_category_kind_guard：分类的 kind 必须等于流水的 type
      if (c.kind !== t.type) fail(`是${label}，却记在「${c.name}」这个${KIND_LABEL[c.kind]}分类上，类型对不上`)
    }
  })
}

/**
 * 校验并归一化一份备份文件的三张表。任何一条不合法都抛错，抛错时调用方一个字节都还没往云端发。
 * 返回的对象只含数据库真有的那几列，字段齐全（缺的按数据库默认值补），可以直接交给 importAll。
 */
export function validateImport(raw: { accounts: unknown[]; categories: unknown[]; transactions: unknown[] }): Snapshot {
  const accounts = raw.accounts.map(readAccount)
  checkAccounts(accounts)
  const categories = raw.categories.map(readCategory)
  checkCategories(categories)
  const transactions = raw.transactions.map(readTransaction)
  checkTransactions(transactions, accounts, categories)
  return { accounts, categories, transactions }
}
