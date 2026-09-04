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
import { centsFromDb, centsToDb } from './money'

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

/** 对应 api.ts 的 importAll：按 id 合并，父分类先于子分类，金额过 centsToDb */
async function importAll(db: PGlite, snap: Snap): Promise<void> {
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
  for (const t of snap.transactions) {
    await db.query(
      `insert into transactions (id,date,type,amount,account_id,to_account_id,category_id,note,created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (id) do update set date=excluded.date,type=excluded.type,amount=excluded.amount,account_id=excluded.account_id,to_account_id=excluded.to_account_id,category_id=excluded.category_id,note=excluded.note`,
      [t.id, t.date, t.type, centsToDb(t.amount as number), t.account_id, t.to_account_id, t.category_id, t.note, t.created_at],
    )
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
