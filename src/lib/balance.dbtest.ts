// 「修改账户余额」这条链路的数据库集成测试。
//
// 用户的核心需求就这一条：随时把某个账户改成实际余额，之后的收支继续在这个数上加减，
// 发现不对了再改一次。前端算余额靠 compute.ts 的 balances()，数据库里还有一份
// 0001/0002 建的 account_balances 视图，两套算法各写各的。
// **两套对不上就是账不对**，而这种事在手机上只会表现成「余额少了几毛钱」，
// 肉眼根本查不出是谁算错了。所以这里每走一步都拿视图和 balances() 逐个账户对一次。
//
// 跑的是真的 Postgres（PGlite，Postgres 编译成 WASM，在内存里）：真的执行
// supabase/migrations/ 下的脚本，真的受 tx_shape 这些约束管。
// 不联网，不碰任何真实数据。跑法：npm run test:db
import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'
import mig0001 from '../../supabase/migrations/0001_init.sql?raw'
import mig0002 from '../../supabase/migrations/0002_optional_account.sql?raw'
import mig0003 from '../../supabase/migrations/0003_category_note.sql?raw'
import type { Account, Transaction } from '../types'
import { balances, totalOf } from './compute'
import { centsFromDb, centsToDb } from './money'

// Supabase 才有的东西，本地补一份最小替身（和 restore.dbtest.ts 一致）
const SHIM = `
create role authenticated;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now());
insert into auth.users default values;
create function auth.uid() returns uuid language sql stable as $$ select id from auth.users order by created_at limit 1 $$;
`

type Row = Record<string, unknown>
const q = async (db: PGlite, sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows as Row[]

async function freshDb(): Promise<PGlite> {
  const db = new PGlite()
  await db.exec(SHIM)
  await db.exec(mig0001)
  await db.exec(mig0002)
  await db.exec(mig0003)
  return db
}

/** 账户名 → id。建表脚本预置的就是用户那四个账户 */
async function accountIds(db: PGlite): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const r of await q(db, 'select id,name from accounts')) out[r.name as string] = r.id as string
  return out
}

async function catId(db: PGlite, name: string): Promise<string> {
  return (await q(db, 'select id from categories where name=$1 limit 1', [name]))[0].id as string
}

/** 写一笔流水。amount 传的是整数「分」，过 centsToDb 变成 numeric —— 和 api.ts 的 txToRow 同一条路 */
async function mk(
  db: PGlite,
  p: { date: string; type: string; cents: number; account?: string | null; to?: string | null; cat?: string | null; note?: string | null },
): Promise<void> {
  await db.query(
    'insert into transactions (date,type,amount,account_id,to_account_id,category_id,note) values ($1,$2,$3,$4,$5,$6,$7)',
    [p.date, p.type, centsToDb(p.cents), p.account ?? null, p.to ?? null, p.cat ?? null, p.note ?? null],
  )
}

/** 数据库那一套：0001 建的 account_balances 视图，返回「分」 */
async function viewBalances(db: PGlite): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const r of await q(db, 'select account_id, balance from account_balances')) {
    out[r.account_id as string] = centsFromDb(r.balance as string)
  }
  return out
}

/** 前端那一套：把库里的行读成 Transaction[]，交给 compute.ts 的 balances() */
async function frontBalances(db: PGlite): Promise<Record<string, number>> {
  const accounts = (await q(db, 'select id,name,kind,sort,is_archived from accounts order by sort')) as unknown as Account[]
  const txs = (await q(
    db,
    'select id,date::text as date,type,amount,account_id,to_account_id,category_id,note,created_at from transactions',
  )).map((r) => ({ ...r, amount: centsFromDb(r.amount as string) })) as unknown as Transaction[]
  return balances(txs, accounts)
}

/** 每走一步都要对一次：数据库视图和前端 compute.ts 必须一分不差 */
async function agreed(db: PGlite): Promise<Record<string, number>> {
  const [view, front] = [await viewBalances(db), await frontBalances(db)]
  expect(view, '数据库视图和前端 compute.balances() 算出来的余额必须完全一致').toEqual(front)
  return front
}

/**
 * 复刻 Accounts.tsx 的 confirm()：
 *   推算余额 = 前端 balances()[账户]；差额 = 实际余额 − 推算余额；
 *   写一条 adjust，金额就是差额。
 *   注：2026-09-04 起，差额为 0 时界面上不再写记录（用户嫌流水里碍眼），
 *   只弹一句「核对无差异」。但数据库仍然允许 0 元的 adjust——历史数据里有这种记录，
 *   下面「场景5」验的就是这个兼容性，不是当前的界面行为。
 * 返回差额（分），方便断言。
 */
async function calibrate(db: PGlite, accountId: string, realCents: number, date = '2026-09-10'): Promise<number> {
  const computed = (await frontBalances(db))[accountId] ?? 0
  const delta = realCents - computed
  await mk(db, { date, type: 'adjust', cents: delta, account: accountId, note: delta === 0 ? '余额核对' : '余额校准' })
  return delta
}

describe('修改账户余额（真数据库）', () => {
  it('场景1 基本四步：录 5000 → 花 80 → 4920 → 录 4800（生成 −120）→ 收 20 → 4820', async () => {
    const db = await freshDb()
    const acc = await accountIds(db)
    const boc = acc['中国银行']
    const [lunch, salary] = [await catId(db, '午餐'), await catId(db, '工资/实习')]

    expect((await agreed(db))[boc]).toBe(0) // 一条记录都没有 → 0

    expect(await calibrate(db, boc, 500000, '2026-09-01')).toBe(500000)
    expect((await agreed(db))[boc]).toBe(500000)

    await mk(db, { date: '2026-09-02', type: 'expense', cents: 8000, account: boc, cat: lunch })
    expect((await agreed(db))[boc]).toBe(492000)

    expect(await calibrate(db, boc, 480000, '2026-09-03')).toBe(-12000) // 系统自己算出 −120
    expect((await agreed(db))[boc]).toBe(480000)

    await mk(db, { date: '2026-09-04', type: 'income', cents: 2000, account: boc, cat: salary })
    expect((await agreed(db))[boc]).toBe(482000)

    // 校准记录真的落库了，金额和备注都对
    const adjusts = await q(db, "select amount::text as amount, note from transactions where type='adjust' order by date")
    expect(adjusts.map((r) => r.amount)).toEqual(['5000.00', '-120.00'])
    expect(adjusts.map((r) => r.note)).toEqual(['余额校准', '余额校准'])
  })

  it('场景2 反复改：三次校准夹着收支，每一步视图和前端都对得上', async () => {
    const db = await freshDb()
    const wx = (await accountIds(db))['微信']
    const [lunch, game, salary] = [await catId(db, '午餐'), await catId(db, '游戏充值'), await catId(db, '工资/实习')]

    expect(await calibrate(db, wx, 100000, '2026-09-01')).toBe(100000)
    expect((await agreed(db))[wx]).toBe(100000)

    await mk(db, { date: '2026-09-02', type: 'expense', cents: 350, account: wx, cat: lunch })
    await mk(db, { date: '2026-09-02', type: 'income', cents: 12000, account: wx, cat: salary })
    expect((await agreed(db))[wx]).toBe(111650)

    expect(await calibrate(db, wx, 120000, '2026-09-03')).toBe(8350) // 改大
    expect((await agreed(db))[wx]).toBe(120000)

    await mk(db, { date: '2026-09-04', type: 'expense', cents: 99999, account: wx, cat: game })
    expect((await agreed(db))[wx]).toBe(20001)

    expect(await calibrate(db, wx, 15050, '2026-09-05')).toBe(-4951) // 改小
    expect((await agreed(db))[wx]).toBe(15050)

    await mk(db, { date: '2026-09-06', type: 'income', cents: 4950, account: wx, cat: salary })
    expect((await agreed(db))[wx]).toBe(20000)

    // Σadjust 就是统计页那个「未记录差额」
    const sum = (await q(db, "select coalesce(sum(amount),0)::text as s from transactions where type='adjust'"))[0].s
    expect(centsFromDb(sum as string)).toBe(100000 + 8350 - 4951)
  })

  it('场景4a 改成 0：清空之后还能继续记账，余额可以变负', async () => {
    const db = await freshDb()
    const boc = (await accountIds(db))['中国银行']
    const lunch = await catId(db, '午餐')

    await calibrate(db, boc, 500000, '2026-09-01')
    expect(await calibrate(db, boc, 0, '2026-09-02')).toBe(-500000)
    expect((await agreed(db))[boc]).toBe(0)

    await mk(db, { date: '2026-09-03', type: 'expense', cents: 1500, account: boc, cat: lunch })
    expect((await agreed(db))[boc]).toBe(-1500)
  })

  it('场景4b 改成负数：信用卡欠款 −1500.75，再刷 200，再校准回 −1000', async () => {
    const db = await freshDb()
    const cmb = (await accountIds(db))['招商银行']
    const lunch = await catId(db, '午餐')

    expect(await calibrate(db, cmb, -150075, '2026-09-01')).toBe(-150075)
    expect((await agreed(db))[cmb]).toBe(-150075)

    await mk(db, { date: '2026-09-02', type: 'expense', cents: 20000, account: cmb, cat: lunch })
    expect((await agreed(db))[cmb]).toBe(-170075)

    expect(await calibrate(db, cmb, -100000, '2026-09-03')).toBe(70075)
    const b = await agreed(db)
    expect(b[cmb]).toBe(-100000)
    expect(totalOf(b)).toBe(-100000) // 其他三个账户都是 0，总额就是这个负数

    // 负数确实是以负数存进 numeric(12,2) 的，不是被截成 0 或取了绝对值
    const raw = await q(db, "select amount::text as a from transactions where type='adjust' order by date")
    expect(raw.map((r) => r.a)).toEqual(['-1500.75', '700.75'])
  })

  it('场景5 历史遗留的 0 元核对记录：库里存得住，余额一分不变', async () => {
    const db = await freshDb()
    const boc = (await accountIds(db))['中国银行']

    await calibrate(db, boc, 500000, '2026-09-01')
    const before = await agreed(db)

    expect(await calibrate(db, boc, 500000, '2026-09-02')).toBe(0)
    expect(await agreed(db)).toEqual(before) // 余额完全没动

    const zero = await q(db, "select amount::text as a, note from transactions where type='adjust' and amount = 0")
    expect(zero).toHaveLength(1)
    expect(zero[0]).toMatchObject({ a: '0.00', note: '余额核对' })
    // 界面现在不再产生这种记录，但 2026-09-04 之前记下的还在库里，不能让它们变成非法数据
    expect((await q(db, "select count(*)::int as n from transactions where type='adjust'"))[0].n).toBe(2)
  })

  it('场景6 转账不影响这条链路：转完两边各自对，各自再校准一次仍然对', async () => {
    const db = await freshDb()
    const acc = await accountIds(db)
    const [boc, cmb] = [acc['中国银行'], acc['招商银行']]

    await calibrate(db, boc, 500000, '2026-09-01')
    await calibrate(db, cmb, 100000, '2026-09-01')
    expect(totalOf(await agreed(db))).toBe(600000)

    await mk(db, { date: '2026-09-02', type: 'transfer', cents: 80000, account: boc, to: cmb })
    let b = await agreed(db)
    expect(b[boc]).toBe(420000)
    expect(b[cmb]).toBe(180000)
    expect(totalOf(b)).toBe(600000) // 转账不改变总额

    expect(await calibrate(db, boc, 415000, '2026-09-03')).toBe(-5000)
    b = await agreed(db)
    expect(b[boc]).toBe(415000)
    expect(b[cmb]).toBe(180000) // 校准转出方，转入方不动

    expect(await calibrate(db, cmb, 185000, '2026-09-04')).toBe(5000)
    b = await agreed(db)
    expect(b[cmb]).toBe(185000)
    expect(b[boc]).toBe(415000)
    expect(totalOf(b)).toBe(600000)
  })

  it('场景7 不指定账户的收支：视图和前端都当它不存在', async () => {
    const db = await freshDb()
    const boc = (await accountIds(db))['中国银行']
    const [lunch, salary] = [await catId(db, '午餐'), await catId(db, '工资/实习')]

    await calibrate(db, boc, 500000, '2026-09-01')
    await mk(db, { date: '2026-09-02', type: 'expense', cents: 8000, account: null, cat: lunch })
    await mk(db, { date: '2026-09-02', type: 'income', cents: 3000, account: null, cat: salary })

    const b = await agreed(db)
    expect(b[boc]).toBe(500000)
    expect(totalOf(b)).toBe(500000)

    // 再核对一次 5000，差额必须是 0
    expect(await calibrate(db, boc, 500000, '2026-09-03')).toBe(0)
    expect((await agreed(db))[boc]).toBe(500000)
  })

  it('场景8 多账户互不干扰：给中国银行校准，微信一分不变', async () => {
    const db = await freshDb()
    const acc = await accountIds(db)
    const [boc, wx, cmb, ali] = [acc['中国银行'], acc['微信'], acc['招商银行'], acc['支付宝']]

    await calibrate(db, boc, 500000, '2026-09-01')
    await calibrate(db, wx, 20000, '2026-09-01')
    await calibrate(db, boc, 432109, '2026-09-02')

    const b = await agreed(db)
    expect(b[boc]).toBe(432109)
    expect(b[wx]).toBe(20000) // 一分没动
    expect(b[cmb]).toBe(0) // 从没校准过的账户还是 0
    expect(b[ali]).toBe(0)
    expect(Object.keys(b)).toHaveLength(4) // 四个账户都在，没有多也没有少
  })

  it('场景9 金额边界：0.01 / 4846.42 / 负数，经过 numeric(12,2) 往返一分不差', async () => {
    const db = await freshDb()
    const wx = (await accountIds(db))['微信']
    const lunch = await catId(db, '午餐')

    expect(await calibrate(db, wx, 1, '2026-09-01')).toBe(1) // 1 分
    expect((await agreed(db))[wx]).toBe(1)

    expect(await calibrate(db, wx, 484642, '2026-09-02')).toBe(484641) // 4846.42
    expect((await agreed(db))[wx]).toBe(484642)

    await mk(db, { date: '2026-09-03', type: 'expense', cents: 1084, account: wx, cat: lunch })
    expect((await agreed(db))[wx]).toBe(483558)

    expect(await calibrate(db, wx, 480000, '2026-09-04')).toBe(-3558) // 负差额
    expect((await agreed(db))[wx]).toBe(480000)

    // 每一条 adjust 的金额，写进 numeric 再读回来必须还是原来那个整数分
    const rows = await q(db, "select amount::text as a from transactions where type='adjust' order by date")
    expect(rows.map((r) => centsFromDb(r.a as string))).toEqual([1, 484641, -3558])
    expect(rows.map((r) => r.a)).toEqual(['0.01', '4846.41', '-35.58'])
  })

  it('tx_shape 不会拦住负数和 0 的校准；但收支金额必须大于 0', async () => {
    const db = await freshDb()
    const wx = (await accountIds(db))['微信']
    const lunch = await catId(db, '午餐')

    // 校准：正、负、0 都必须放行——这正是「改小余额」和「核对无差异」赖以工作的前提
    await expect(mk(db, { date: '2026-09-01', type: 'adjust', cents: 12345, account: wx })).resolves.toBeUndefined()
    await expect(mk(db, { date: '2026-09-01', type: 'adjust', cents: -12345, account: wx })).resolves.toBeUndefined()
    await expect(mk(db, { date: '2026-09-01', type: 'adjust', cents: 0, account: wx })).resolves.toBeUndefined()
    expect((await agreed(db))[wx]).toBe(0)

    // 收支不允许 0 或负数（负支出这种记法会让统计页彻底算不明白）
    await expect(mk(db, { date: '2026-09-01', type: 'expense', cents: 0, account: wx, cat: lunch })).rejects.toThrow(/tx_shape/)
    await expect(mk(db, { date: '2026-09-01', type: 'expense', cents: -100, account: wx, cat: lunch })).rejects.toThrow(/tx_shape/)
  })

  it('校准记录的形状被数据库锁死：必须有账户，不能带分类，不能带转入账户', async () => {
    const db = await freshDb()
    const acc = await accountIds(db)
    const [wx, boc] = [acc['微信'], acc['中国银行']]
    const lunch = await catId(db, '午餐')

    // 没有账户的校准 = 这笔钱不知道加到谁头上，余额无从算起
    await expect(mk(db, { date: '2026-09-01', type: 'adjust', cents: 100, account: null })).rejects.toThrow(/tx_shape/)
    // 带分类的校准会污染收支统计。
    // 注意报错来自触发器而不是 tx_shape：trg_tx_cat_kind 是 before insert 触发器，
    // 先于 check 约束执行，而分类的 kind 只有 expense/income，永远等不到 'adjust'，
    // 所以拦下来的信息是「分类类型不匹配」。两道防线都在，先撞上哪道无所谓。
    await expect(mk(db, { date: '2026-09-01', type: 'adjust', cents: 100, account: wx, cat: lunch })).rejects.toThrow(/不匹配/)
    // 带转入账户的校准会被视图算两遍
    await expect(mk(db, { date: '2026-09-01', type: 'adjust', cents: 100, account: wx, to: boc })).rejects.toThrow(/tx_shape/)
  })

  it('数据库视图和前端 compute.balances() 在一个塞满边界的库上完全一致', async () => {
    const db = await freshDb()
    const acc = await accountIds(db)
    const [boc, cmb, ali, wx] = [acc['中国银行'], acc['招商银行'], acc['支付宝'], acc['微信']]
    const [lunch, food, salary] = [await catId(db, '午餐'), await catId(db, '日常餐饮'), await catId(db, '工资/实习')]

    await calibrate(db, boc, 500000, '2026-09-01') // 正校准
    await calibrate(db, cmb, -150075, '2026-09-01') // 负余额（信用卡）
    await calibrate(db, wx, 1, '2026-09-01') // 1 分
    await calibrate(db, ali, 0, '2026-09-01') // 差额 0，写一条 0 元
    await mk(db, { date: '2026-09-02', type: 'expense', cents: 484642, account: boc, cat: food })
    await mk(db, { date: '2026-09-02', type: 'expense', cents: 5, account: wx, cat: lunch })
    await mk(db, { date: '2026-09-02', type: 'expense', cents: 3300, account: null, cat: lunch }) // 无账户
    await mk(db, { date: '2026-09-03', type: 'income', cents: 1300000, account: boc, cat: salary })
    await mk(db, { date: '2026-09-03', type: 'transfer', cents: 30000, account: boc, to: wx })
    await mk(db, { date: '2026-09-03', type: 'transfer', cents: 700, account: wx, to: ali })
    await calibrate(db, boc, 1000000, '2026-09-04') // 校准夹在转账后面
    await calibrate(db, wx, 0, '2026-09-05') // 校准到 0

    const b = await agreed(db) // ← 这一行就是「两套算法必须对得上」的断言
    expect(b[boc]).toBe(1000000)
    expect(b[cmb]).toBe(-150075)
    expect(b[wx]).toBe(0)
    expect(b[ali]).toBe(700)
    expect(totalOf(b)).toBe(1000000 - 150075 + 0 + 700)

    // 视图的总额也要等于前端的总额
    const viewTotal = (await q(db, 'select coalesce(sum(balance),0)::text as s from account_balances'))[0].s
    expect(centsFromDb(viewTotal as string)).toBe(totalOf(b))
  })
})
