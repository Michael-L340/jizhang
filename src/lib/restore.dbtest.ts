// 备份与恢复的数据库集成测试。
//
// 这里跑的是**真的 Postgres**（PGlite 把 Postgres 编译成 WASM，跑在内存里），
// 真的执行 supabase/migrations/ 下的建表脚本，真的受那些外键、唯一索引和触发器约束。
// 不联网，不碰任何真实数据。
//
// 为什么非要这样测：备份能不能恢复，取决于数据库的约束怎么反应——
// 「同名不同 id 会不会撞唯一索引」「删除顺序反了会不会被拒绝」这类事，
// 用假的 api 层怎么测都测不出来，只有真的跑一遍才知道。而这条路一旦是断的，
// 只会在真出事那天暴露。跑法：npm run test:db
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'
import mig0001 from '../../supabase/migrations/0001_init.sql?raw'
import mig0002 from '../../supabase/migrations/0002_optional_account.sql?raw'
import mig0003 from '../../supabase/migrations/0003_category_note.sql?raw'
import type { Snapshot } from '../types'
import { centsFromDb, centsToDb } from './money'
import { validateImport } from './validate'

// Supabase 才有的东西，本地补一份最小替身。被测的是我们自己的表结构与约束。
const SHIM = `
create role authenticated;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now());
insert into auth.users default values;
create function auth.uid() returns uuid language sql stable as $$ select id from auth.users order by created_at limit 1 $$;
`

async function freshDb(): Promise<PGlite> {
  const db = new PGlite()
  await db.exec(SHIM)
  await db.exec(mig0001)
  await db.exec(mig0002)
  await db.exec(mig0003)
  return db
}

type Row = Record<string, unknown>
const q = async (db: PGlite, sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows as Row[]
const count = async (db: PGlite, table: string): Promise<number> => Number((await q(db, `select count(*)::int as n from ${table}`))[0].n)

interface Snap {
  accounts: Row[]
  categories: Row[]
  transactions: Row[]
}

/** 对应 csv.ts 的 buildJson：库里存的是「元」，备份文件里是整数「分」 */
async function exportBackup(db: PGlite): Promise<Snap> {
  return {
    accounts: await q(db, 'select id,name,kind,sort,is_archived from accounts'),
    categories: await q(db, 'select id,kind,parent_id,name,icon,sort,is_archived,note from categories'),
    transactions: (await q(db, 'select id,date::text as date,type,amount,account_id,to_account_id,category_id,note,created_at from transactions')).map((t) => ({
      ...t,
      amount: centsFromDb(t.amount as string),
    })),
  }
}

/** 对应 api.ts 的 importAll 的前半段：账户 → 一级分类 → 二级分类 */
async function importRefs(db: PGlite, snap: Snap): Promise<void> {
  for (const a of snap.accounts) {
    await db.query(
      `insert into accounts (id,name,kind,sort,is_archived) values ($1,$2,$3,$4,$5)
       on conflict (id) do update set name=excluded.name,kind=excluded.kind,sort=excluded.sort,is_archived=excluded.is_archived`,
      [a.id, a.name, a.kind, a.sort, a.is_archived],
    )
  }
  const ordered = [...snap.categories.filter((c) => !c.parent_id), ...snap.categories.filter((c) => c.parent_id)]
  for (const c of ordered) {
    await db.query(
      `insert into categories (id,kind,parent_id,name,icon,sort,is_archived,note) values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (id) do update set kind=excluded.kind,parent_id=excluded.parent_id,name=excluded.name,icon=excluded.icon,sort=excluded.sort,is_archived=excluded.is_archived,note=excluded.note`,
      [c.id, c.kind, c.parent_id, c.name, c.icon, c.sort, c.is_archived, c.note],
    )
  }
}

async function insertTx(db: PGlite, t: Row): Promise<void> {
  await db.query(
    `insert into transactions (id,date,type,amount,account_id,to_account_id,category_id,note,created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (id) do update set date=excluded.date,type=excluded.type,amount=excluded.amount,account_id=excluded.account_id,to_account_id=excluded.to_account_id,category_id=excluded.category_id,note=excluded.note`,
    [t.id, t.date, t.type, centsToDb(t.amount as number), t.account_id, t.to_account_id, t.category_id, t.note, t.created_at],
  )
}

/** 对应 api.ts 的 importAll：按 id 合并，父分类先于子分类，金额过 centsToDb */
async function importAll(db: PGlite, snap: Snap): Promise<void> {
  await importRefs(db, snap)
  for (const t of snap.transactions) await insertTx(db, t)
}

/** api.ts 的 importAll 每 500 条流水提交一批，不是事务。这里让第 failAt 批开头断网 */
async function importFailingAtBatch(db: PGlite, snap: Snap, failAt: number, batch = 500): Promise<void> {
  await importRefs(db, snap)
  for (let i = 0, n = 1; i < snap.transactions.length; i += batch, n++) {
    if (n === failAt) throw new Error('网络不通')
    for (const t of snap.transactions.slice(i, i + batch)) await insertTx(db, t)
  }
}

/** 对应 api.ts 的 wipeAll：流水 → 二级分类 → 一级分类 → 账户 */
async function wipeAll(db: PGlite): Promise<void> {
  await db.exec('delete from transactions where id is not null')
  await db.exec('delete from categories where parent_id is not null')
  await db.exec('delete from categories where parent_id is null')
  await db.exec('delete from accounts where id is not null')
}

/** 塞几笔覆盖各种边界的流水：大额小数、最小单位 1 分、负数校准、转账、不指定账户 */
async function seed(db: PGlite): Promise<void> {
  const id = async (t: string, n: string) => (await q(db, `select id from ${t} where name=$1`, [n]))[0].id
  const [wx, boc] = [await id('accounts', '微信'), await id('accounts', '中国银行')]
  const [lunch, food, salary] = [await id('categories', '午餐'), await id('categories', '日常餐饮'), await id('categories', '工资/实习')]
  const mk = (d: string, type: string, cents: number, acc: unknown, cat: unknown, to: unknown = null, note: string | null = null) =>
    db.query('insert into transactions (date,type,amount,account_id,to_account_id,category_id,note) values ($1,$2,$3,$4,$5,$6,$7)', [
      d, type, centsToDb(cents), acc, to, cat, note,
    ])
  await mk('2026-09-01', 'expense', 1800, wx, lunch)
  await mk('2026-09-02', 'expense', 484642, boc, food)
  await mk('2026-09-02', 'expense', 5, wx, lunch)
  await mk('2026-09-02', 'expense', 3300, null, lunch)
  await mk('2026-09-03', 'income', 1300000, boc, salary)
  await mk('2026-09-03', 'transfer', 30000, boc, null, wx)
  await mk('2026-09-03', 'adjust', -1084, wx, null, null, '余额校准')
  await mk('2026-09-04', 'adjust', 214874, boc, null, null, '余额校准')
}

const byId = (rows: Row[]) => [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)))

let backup: Snap

beforeAll(async () => {
  const live = await freshDb()
  await seed(live)
  backup = await exportBackup(live)
})

describe('整库恢复', () => {
  it('换新数据库后直接「合并导入」必然失败——这是修复前唯一的路', async () => {
    // 建表脚本会预置 4 个账户和全套分类，用的是新 id；备份里是旧 id 但同名。
    // upsert(onConflict:'id') 不认 unique(user_id,name) 这个索引，第一句就抛 23505。
    const db = await freshDb()
    await expect(importAll(db, backup)).rejects.toMatchObject({ code: '23505' })
  })

  it('先清空再导入能一字不差地还原', async () => {
    const db = await freshDb()
    await wipeAll(db)
    expect(await count(db, 'accounts')).toBe(0)
    expect(await count(db, 'categories')).toBe(0)
    expect(await count(db, 'transactions')).toBe(0)

    await importAll(db, backup)
    const back = await exportBackup(db)
    // 按 id 排序后比较：导出没有稳定排序，行序不同不算差异，逐行逐字段必须相同
    expect(byId(back.accounts)).toEqual(byId(backup.accounts))
    expect(byId(back.categories)).toEqual(byId(backup.categories))
    expect(byId(back.transactions)).toEqual(byId(backup.transactions))
  })

  it('金额往返零误差：大额小数、1 分、负数校准都不能变', async () => {
    const db = await freshDb()
    await wipeAll(db)
    await importAll(db, backup)
    const back = await exportBackup(db)
    const before = new Map(backup.transactions.map((t) => [t.id as string, t.amount]))
    for (const t of back.transactions) expect(t.amount, `id=${t.id}`).toBe(before.get(t.id as string))
    expect([...before.values()]).toEqual(expect.arrayContaining([484642, 5, -1084, 1300000]))
  })
})

describe('清空的顺序', () => {
  it('先删账户会被外键拒绝', async () => {
    const db = await freshDb()
    await seed(db)
    await expect(db.exec('delete from accounts where id is not null')).rejects.toThrow(/RESTRICT|foreign key/i)
  })

  it('只删一级分类、留着二级，会被外键拒绝', async () => {
    const db = await freshDb()
    await seed(db)
    await db.exec('delete from transactions where id is not null')
    await expect(db.exec('delete from categories where parent_id is null')).rejects.toThrow(/RESTRICT|foreign key/i)
  })

  it('二级先于一级删就没问题', async () => {
    const db = await freshDb()
    await seed(db)
    await wipeAll(db)
    expect(await count(db, 'categories')).toBe(0)
  })
})

describe('部分恢复（合并导入）', () => {
  it('找回误删的几笔，同时不动备份之后新记的账，也不产生重复', async () => {
    const db = await freshDb()
    await seed(db)
    const snap = await exportBackup(db)
    const n0 = snap.transactions.length

    // 备份之后又记了一笔
    const wx = (await q(db, "select id from accounts where name='微信'"))[0].id
    const lunch = (await q(db, "select id from categories where name='午餐'"))[0].id
    await db.query(
      'insert into transactions (date,type,amount,account_id,category_id,note) values ($1,$2,$3,$4,$5,$6)',
      ['2026-09-05', 'expense', centsToDb(999), wx, lunch, '备份之后新记的'],
    )
    // 误删两笔
    const victims = (await q(db, "select id from transactions where note is null order by date limit 2")).map((r) => r.id)
    await db.query('delete from transactions where id = any($1)', [victims])
    expect(await count(db, 'transactions')).toBe(n0 - 1)

    await importAll(db, snap)

    expect(await count(db, 'transactions')).toBe(n0 + 1) // 误删的回来了，新记的还在
    for (const v of victims) expect((await q(db, 'select id from transactions where id=$1', [v])).length).toBe(1)
    expect((await q(db, "select id from transactions where note='备份之后新记的'")).length).toBe(1)
    expect((await q(db, 'select id from (select id from transactions group by id having count(*)>1) x')).length).toBe(0)
  })

  it('重复导入同一个文件是安全的（幂等）', async () => {
    const db = await freshDb()
    await wipeAll(db)
    await importAll(db, backup)
    await importAll(db, backup)
    await importAll(db, backup)
    expect(await count(db, 'transactions')).toBe(backup.transactions.length)
    expect(await count(db, 'accounts')).toBe(backup.accounts.length)
  })
})

describe('导入时数据库自己的防线', () => {
  it('支出记到收入分类上会被触发器拒绝', async () => {
    const db = await freshDb()
    const wx = (await q(db, "select id from accounts where name='微信'"))[0].id
    const salary = (await q(db, "select id from categories where name='工资/实习'"))[0].id
    await expect(
      db.query('insert into transactions (date,type,amount,account_id,category_id) values ($1,$2,$3,$4,$5)', ['2026-09-01', 'expense', '10.00', wx, salary]),
    ).rejects.toThrow(/不匹配/)
  })

  it('转账两边是同一个账户会被 check 约束拒绝', async () => {
    const db = await freshDb()
    const wx = (await q(db, "select id from accounts where name='微信'"))[0].id
    await expect(
      db.query('insert into transactions (date,type,amount,account_id,to_account_id) values ($1,$2,$3,$4,$5)', ['2026-09-01', 'transfer', '10.00', wx, wx]),
    ).rejects.toThrow(/tx_shape/)
  })

  it('分类不能有第三级', async () => {
    const db = await freshDb()
    const lunch = (await q(db, "select id from categories where name='午餐'"))[0].id
    await expect(
      db.query('insert into categories (kind,parent_id,name) values ($1,$2,$3)', ['expense', lunch, '第三级']),
    ).rejects.toThrow(/最多两级/)
  })
})

// ══════════════════════════════════════════════════════════════════════
// 落地前校验（lib/validate.ts）
//
// 这一节要证明的性质只有两条，但它们是整条恢复路上最要紧的两条：
//   A. 凡是校验放行的文件，都能真的写进 Postgres——不会出现「清空了，导不回来」
//   B. 凡是校验拦下的文件，wipeAll 根本不会被调用，云端一行都没动；
//      而且那些文件如果硬导，数据库自己也确实会拒收（证明规则不是编的）
//
// 修复前的真实事故长这样：某条流水的分类 id 在文件里不存在 → 校验只看
// version/id/日期/金额，放行 → 云端清空 → 外键把那条流水拒了 → 最后库里
// categories=1、transactions=0。账本没了。下面 BAD_CASES 里第一条就是它。
// ══════════════════════════════════════════════════════════════════════

const asSnap = (s: Snapshot): Snap => ({
  accounts: s.accounts as unknown as Row[],
  categories: s.categories as unknown as Row[],
  transactions: s.transactions as unknown as Row[],
})

/** 完整走一遍 store.ts 的 restoreSnapshot：**先校验**，不过就一个字节都不动云端；过了才 wipe→import */
async function restore(db: PGlite, file: RawFile): Promise<void> {
  const snap = validateImport(file)
  await wipeAll(db)
  await importAll(db, asSnap(snap))
}

interface RawFile {
  accounts: unknown[]
  categories: unknown[]
  transactions: unknown[]
}

const uid = (n: number): string => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`

/**
 * 手工造的一份合法备份，专挑边界：
 * 1 分钱、numeric(12,2) 的上限、负数校准、0 元校准、不指定账户的收支、转账、
 * 二级分类、两个大类下同名的二级分类、支出「其他」与收入「其他」并存、
 * 归档过的账户与分类、smallint 上限的 sort、中文 + emoji + 逗号引号换行的备注、闰年那一天。
 */
function legalBackup(): RawFile {
  const A = { wx: uid(1), boc: uid(2), gone: uid(3) }
  const C = { food: uid(11), lunch: uid(12), fun: uid(13), lunch2: uid(14), salary: uid(15), otherE: uid(16), otherI: uid(17), breakfast: uid(18) }
  const t = (n: number, over: Record<string, unknown>): Record<string, unknown> => ({
    id: uid(100 + n),
    date: '2026-09-04',
    type: 'expense',
    amount: 1800,
    account_id: A.wx,
    to_account_id: null,
    category_id: C.lunch,
    note: null,
    created_at: '2026-09-04T02:00:00.000Z',
    ...over,
  })
  return {
    accounts: [
      { id: A.wx, name: '微信', kind: 'wallet', sort: 1, is_archived: false },
      { id: A.boc, name: '中国银行', kind: 'bank', sort: 2, is_archived: false },
      { id: A.gone, name: '已注销的卡', kind: 'bank', sort: 32767, is_archived: true },
    ],
    categories: [
      { id: C.food, kind: 'expense', parent_id: null, name: '日常餐饮', icon: '🍚', sort: 1, is_archived: false, note: '正常校园吃饭消费' },
      { id: C.lunch, kind: 'expense', parent_id: C.food, name: '午餐', icon: null, sort: 1, is_archived: false, note: null },
      { id: C.breakfast, kind: 'expense', parent_id: C.food, name: '早餐', icon: null, sort: 2, is_archived: true, note: null },
      { id: C.fun, kind: 'expense', parent_id: null, name: '娱乐消费', icon: '🎮', sort: 2, is_archived: false, note: null },
      { id: C.lunch2, kind: 'expense', parent_id: C.fun, name: '午餐', icon: null, sort: 1, is_archived: false, note: '和上面同名但父不同，cat_child_uniq 允许' },
      { id: C.otherE, kind: 'expense', parent_id: null, name: '其他', icon: null, sort: 3, is_archived: false, note: null },
      { id: C.salary, kind: 'income', parent_id: null, name: '工资/实习', icon: '💰', sort: 1, is_archived: false, note: null },
      { id: C.otherI, kind: 'income', parent_id: null, name: '其他', icon: null, sort: 2, is_archived: false, note: null },
    ],
    transactions: [
      t(1, { amount: 1, note: '最小单位 1 分' }),
      t(2, { amount: 999999999999, category_id: C.otherE, note: 'numeric(12,2) 的上限' }),
      t(3, { account_id: null, note: '不指定账户的支出（0002 放开的）' }),
      t(4, { type: 'income', category_id: C.salary, amount: 1300000, account_id: A.boc, note: '实习工资 🎉' }),
      t(5, { type: 'income', category_id: C.otherI, amount: 500, account_id: null, note: '不指定账户的收入' }),
      t(6, { type: 'transfer', category_id: null, account_id: A.boc, to_account_id: A.wx, amount: 30000, note: '转账' }),
      t(7, { type: 'adjust', category_id: null, account_id: A.wx, amount: -1084, note: '余额校准（负数）' }),
      t(8, { type: 'adjust', category_id: null, account_id: A.boc, amount: 0, note: '校准 0 元也是合法的' }),
      t(9, { category_id: C.lunch2, amount: 4500, note: '中文、emoji 🍜🥢、逗号, 引号" 和\n换行都要原样回来' }),
      t(10, { category_id: C.breakfast, amount: 300, note: '记在归档分类上的历史流水' }),
      t(11, { date: '2024-02-29', amount: 250, note: '闰年那一天' }),
      t(12, { account_id: A.gone, amount: 99, note: '记在归档账户上的历史流水' }),
    ],
  }
}

const clone = (f: RawFile): RawFile => JSON.parse(JSON.stringify(f)) as RawFile

/** 「硬导」那一组共用的库：每次用之前清干净，上一条留下的半截数据不会串味 */
let hardDb: PGlite | null = null
async function hardImportDb(): Promise<PGlite> {
  hardDb ??= await freshDb()
  await wipeAll(hardDb)
  return hardDb
}

/** created_at 在 PGlite 里回来是 Date 对象，比较前统一成 ISO 字符串 */
const isoTx = (rows: Row[]): Row[] => byId(rows).map((r) => ({ ...r, created_at: new Date(r.created_at as string).toISOString() }))

interface BadCase {
  name: string
  mutate: (f: RawFile) => void
  msg: RegExp
  /** 这条规则是不是数据库自己也会拒（逐行 upsert 能复现的那种） */
  dbRejects: boolean
}

const BAD_CASES: BadCase[] = [
  {
    name: '流水的分类 id 在文件里不存在（压测复现的那个）',
    mutate: (f) => ((f.transactions[0] as Row).category_id = uid(90)),
    msg: /分类在这个文件里找不到/,
    dbRejects: true,
  },
  { name: '流水的账户 id 在文件里不存在', mutate: (f) => ((f.transactions[0] as Row).account_id = uid(91)), msg: /账户在这个文件里找不到/, dbRejects: true },
  { name: '日期是 2025-02-30', mutate: (f) => ((f.transactions[0] as Row).date = '2025-02-30'), msg: /这一天不存在/, dbRejects: true },
  { name: '日期是 2025-13-45', mutate: (f) => ((f.transactions[0] as Row).date = '2025-13-45'), msg: /这一天不存在/, dbRejects: true },
  { name: '日期是 0000-00-00', mutate: (f) => ((f.transactions[0] as Row).date = '0000-00-00'), msg: /这一天不存在/, dbRejects: true },
  { name: '支出没有分类（tx_shape）', mutate: (f) => ((f.transactions[0] as Row).category_id = null), msg: /但没有分类/, dbRejects: true },
  {
    name: '支出填了转入账户（tx_shape）',
    mutate: (f) => ((f.transactions[0] as Row).to_account_id = uid(2)),
    msg: /却填了转入账户/,
    dbRejects: true,
  },
  { name: '支出金额是 0（tx_shape）', mutate: (f) => ((f.transactions[0] as Row).amount = 0), msg: /必须大于 0/, dbRejects: true },
  {
    name: '转账两边是同一个账户（tx_shape）',
    mutate: (f) => ((f.transactions[5] as Row).to_account_id = (f.transactions[5] as Row).account_id),
    msg: /转出和转入却是同一个账户/,
    dbRejects: true,
  },
  { name: '转账没有转入账户（tx_shape）', mutate: (f) => ((f.transactions[5] as Row).to_account_id = null), msg: /没有转入账户/, dbRejects: true },
  { name: '校准没有账户（0002 的 tx_shape）', mutate: (f) => ((f.transactions[6] as Row).account_id = null), msg: /但没有账户/, dbRejects: true },
  {
    name: '支出记在收入分类上（tx_category_kind_guard）',
    mutate: (f) => ((f.transactions[0] as Row).category_id = uid(15)),
    msg: /这个收入分类上/,
    dbRejects: true,
  },
  {
    name: '分类有第三级（categories_depth_guard）',
    mutate: (f) => f.categories.push({ id: uid(19), kind: 'expense', parent_id: uid(12), name: '食堂', icon: null, sort: 1, is_archived: false, note: null }),
    msg: /最多两级/,
    dbRejects: true,
  },
  {
    name: '父子分类的 kind 不一致（categories_depth_guard）',
    mutate: (f) => ((f.categories[1] as Row).kind = 'income'),
    msg: /父子必须一致/,
    dbRejects: true,
  },
  {
    name: '两个同 kind 的一级分类重名（cat_root_uniq）',
    mutate: (f) => f.categories.push({ id: uid(20), kind: 'expense', parent_id: null, name: '日常餐饮', icon: null, sort: 9, is_archived: false, note: null }),
    msg: /重名/,
    dbRejects: true,
  },
  {
    name: '同一个上级下两个二级分类重名（cat_child_uniq）',
    mutate: (f) => f.categories.push({ id: uid(21), kind: 'expense', parent_id: uid(11), name: '午餐', icon: null, sort: 9, is_archived: false, note: null }),
    msg: /同一个上级/,
    dbRejects: true,
  },
  {
    name: '两个同名账户（accounts unique(user_id,name)）',
    mutate: (f) => f.accounts.push({ id: uid(4), name: '微信', kind: 'bank', sort: 9, is_archived: false }),
    msg: /同名账户/,
    dbRejects: true,
  },
  { name: '金额超出 numeric(12,2)', mutate: (f) => ((f.transactions[0] as Row).amount = 1_000_000_000_000), msg: /超出数据库能存的范围/, dbRejects: true },
  { name: '金额写成「元」（12.5 而不是 1250）', mutate: (f) => ((f.transactions[0] as Row).amount = 12.5), msg: /整数分/, dbRejects: true },
  { name: 'id 不是 UUID', mutate: (f) => ((f.transactions[0] as Row).id = 't1'), msg: /UUID/, dbRejects: true },
  { name: 'sort 超出 smallint', mutate: (f) => ((f.accounts[0] as Row).sort = 40000), msg: /排序值/, dbRejects: true },
  { name: 'created_at 不是时间', mutate: (f) => ((f.transactions[0] as Row).created_at = '刚才'), msg: /记录时间/, dbRejects: true },
  {
    // 逐行 upsert 复现不了（第二行会把第一行覆盖掉），真实的批量 upsert 会报 21000，
    // 下面「重复 id」那条用一句真的多行 insert 单独证明
    name: '同一个 id 在文件里出现两次',
    mutate: (f) => f.transactions.push({ ...(f.transactions[0] as Row) }),
    msg: /重复/,
    dbRejects: false,
  },
]

describe('落地前校验：凡是通过的都能真的导进去', () => {
  // 两个 describe 内共用的库：起一个 PGlite（跑三份 migration）要两三秒，
  // 四十多个用例各起一个就是三分钟。校验拦下的用例根本不写库，共用完全安全；
  // 硬导那一组每次先 wipeAll 清干净再开始。
  let shared: PGlite
  let seeded: { a: number; c: number; t: number }

  beforeAll(async () => {
    shared = await freshDb()
    await seed(shared)
    seeded = { a: await count(shared, 'accounts'), c: await count(shared, 'categories'), t: await count(shared, 'transactions') }
  })

  it('一批覆盖边界的合法样本：校验放行，wipe→import 之后一条不少、一分不差', async () => {
    const db = await freshDb()
    const file = legalBackup()
    const snap = validateImport(file) // 不抛错 = 放行
    await restore(db, file)

    expect(await count(db, 'accounts')).toBe(3)
    expect(await count(db, 'categories')).toBe(8)
    expect(await count(db, 'transactions')).toBe(12)

    const back = await exportBackup(db)
    expect(byId(back.accounts)).toEqual(byId(snap.accounts as unknown as Row[]))
    expect(byId(back.categories)).toEqual(byId(snap.categories as unknown as Row[]))
    expect(isoTx(back.transactions)).toEqual(isoTx(snap.transactions as unknown as Row[]))
  })

  it('金额边界逐个核对：1 分、上限、负数校准、0 元校准都不能变样', async () => {
    const db = await freshDb()
    await restore(db, legalBackup())
    const amounts = (await exportBackup(db)).transactions.map((t) => t.amount)
    expect(amounts).toEqual(expect.arrayContaining([1, 999999999999, -1084, 0, 1300000]))
  })

  it('中文、emoji、引号、换行的备注原样回来', async () => {
    const db = await freshDb()
    await restore(db, legalBackup())
    const notes = (await exportBackup(db)).transactions.map((t) => t.note)
    expect(notes).toContain('中文、emoji 🍜🥢、逗号, 引号" 和\n换行都要原样回来')
  })

  it.each(BAD_CASES.map((c) => [c.name, c] as const))('非法样本「%s」：校验就拦下了，wipeAll 根本没被调用', async (_name, c) => {
    const file = clone(legalBackup())
    c.mutate(file)
    await expect(restore(shared, file)).rejects.toThrow(c.msg)

    // 云端一行都没动。修复前这里会是 0 / 0 / 0
    expect(await count(shared, 'accounts')).toBe(seeded.a)
    expect(await count(shared, 'categories')).toBe(seeded.c)
    expect(await count(shared, 'transactions')).toBe(seeded.t)
  })

  it.each(BAD_CASES.filter((c) => c.dbRejects).map((c) => [c.name, c] as const))('非法样本「%s」硬导进去，Postgres 自己也会拒收', async (_name, c) => {
    // 这条是在证明上面那些规则不是我编的，而是数据库真的会拒。
    // 哪天 migrations 放宽了某条约束，这里会红，提醒回去把校验一起放宽
    const db = await hardImportDb()
    const file = clone(legalBackup())
    c.mutate(file)
    await expect(importAll(db, file as unknown as Snap)).rejects.toThrow()
  })

  it('同一个 id 在文件里出现两次：真实的批量 upsert 会被 Postgres 拒绝', async () => {
    const db = await hardImportDb()
    await expect(
      db.query(
        `insert into accounts (id,name,kind,sort,is_archived) values ($1,$2,'bank',1,false),($1,$3,'bank',2,false)
         on conflict (id) do update set name=excluded.name`,
        [uid(1), '微信', '微信2'],
      ),
    ).rejects.toThrow(/second time/i)
  })

  it('回滚用的那份快照本来就合法：云端自己导出来的东西，喂给校验器是过得去的', async () => {
    // 「失败就退回操作前」靠的是内存里那份快照。它来自云端，所以理论上一定合法——这里把它验掉。
    // 真正的风险不在合法性，而在完整性：本次会话没同步成功过的话，那份快照可能比云端少几条。
    // 那是缺陷 B 的战场（导出前的提醒 + Settings 恢复确认框里的第二条提示）。
    const db = await freshDb()
    await seed(db)
    const snap = await exportBackup(db)
    const asFile: RawFile = { ...snap, transactions: snap.transactions.map((t) => ({ ...t, created_at: new Date(t.created_at as string).toISOString() })) }
    expect(() => validateImport(asFile)).not.toThrow()
  })
})

describe('导入中途断网的回滚', () => {
  it('第二批就断网：拿操作前的快照回滚，条数与内容一分不差地回到操作前', async () => {
    const db = await freshDb()
    await seed(db)
    // 造够 600 条，让导入真的走到第二批（api.ts 是 500 条一批，不是事务）
    const wx = (await q(db, "select id from accounts where name='微信'"))[0].id
    const lunch = (await q(db, "select id from categories where name='午餐'"))[0].id
    await db.query(
      `insert into transactions (id,date,type,amount,account_id,category_id,note)
       select gen_random_uuid(), date '2026-01-01' + (i % 300), 'expense', ((i % 5000) + 1)::numeric / 100, $1, $2, '第 ' || i || ' 笔'
       from generate_series(1, 600) i`,
      [wx, lunch],
    )

    // 操作前的样子。store.ts 在 wipeAll 之前留在内存里的就是这一份
    const before = await exportBackup(db)
    const n0 = before.transactions.length

    // 要恢复的文件：同一批 id，但金额全都不一样（模拟「回到备份那一刻」）
    const file: Snap = { ...before, transactions: before.transactions.map((t) => ({ ...t, amount: (t.amount as number) + 7 })) }

    await wipeAll(db)
    await expect(importFailingAtBatch(db, file, 2)).rejects.toThrow('网络不通')
    // 断网时的现场：第一批 500 条已经进去了，剩下的没了。修复前用户就停在这里
    expect(await count(db, 'transactions')).toBe(500)

    // ── 回滚：照 store.ts 做的，用操作前的快照 upsert 一遍（只覆盖，不删任何东西）──
    await importAll(db, before)

    const after = await exportBackup(db)
    expect(after.transactions).toHaveLength(n0)
    expect(byId(after.accounts)).toEqual(byId(before.accounts))
    expect(byId(after.categories)).toEqual(byId(before.categories))
    expect(isoTx(after.transactions)).toEqual(isoTx(before.transactions))
  })

  it('回滚连已经被写坏的那 500 条也一起改回来，不是只补上缺的', async () => {
    const db = await freshDb()
    await seed(db)
    const before = await exportBackup(db)
    const file: Snap = { ...before, transactions: before.transactions.map((t) => ({ ...t, amount: 999, note: '被写坏的' })) }

    await wipeAll(db)
    // 8 条流水，batch=4，第二批断网 → 前 4 条已经被写成错的
    await expect(importFailingAtBatch(db, file, 2, 4)).rejects.toThrow('网络不通')
    expect(await count(db, 'transactions')).toBe(4)
    expect((await q(db, "select id from transactions where note='被写坏的'")).length).toBe(4)

    await importAll(db, before)
    expect((await q(db, "select id from transactions where note='被写坏的'")).length).toBe(0)
    expect(isoTx((await exportBackup(db)).transactions)).toEqual(isoTx(before.transactions))
  })
})
