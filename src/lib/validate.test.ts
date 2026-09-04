// 落地前校验的逐条测试。
//
// 这一层的意义只有一句话：**整库恢复会先把云端删光**，所以文件里任何一行数据库不收，
// 都必须在删之前就被拦下来。下面每一个用例都对应 supabase/migrations/ 里的一条真约束，
// 「这条规则漏了会发生什么」写在用例名里——漏一条就是一个能把账本删光的洞。
//
// 规则真不真、拦得对不对，由 restore.dbtest.ts 在真 Postgres 上兜底：
// 那里会证明「凡是这里放行的文件都导得进去」「凡是这里拦下的，数据库也确实不收」。
import { describe, expect, it } from 'vitest'
import { MAX_CENTS, validateImport } from './validate'

type Raw = Record<string, unknown>
interface Fixture {
  accounts: Raw[]
  categories: Raw[]
  transactions: Raw[]
}

const uuid = (n: number): string => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
const [A1, A2] = [uuid(1), uuid(2)]
const [C1, C2, CI] = [uuid(11), uuid(12), uuid(13)]
const [T1, T2] = [uuid(21), uuid(22)]

/** 一份最小的合法备份：两个账户、一级+二级支出分类、一个收入分类、一笔支出 */
function base(): Fixture {
  return {
    accounts: [
      { id: A1, name: '微信', kind: 'wallet', sort: 1, is_archived: false },
      { id: A2, name: '中国银行', kind: 'bank', sort: 2, is_archived: false },
    ],
    categories: [
      { id: C1, kind: 'expense', parent_id: null, name: '日常餐饮', icon: '🍚', sort: 1, is_archived: false, note: '正常校园吃饭消费' },
      { id: C2, kind: 'expense', parent_id: C1, name: '午餐', icon: null, sort: 1, is_archived: false, note: null },
      { id: CI, kind: 'income', parent_id: null, name: '工资/实习', icon: null, sort: 1, is_archived: false, note: null },
    ],
    transactions: [
      { id: T1, date: '2026-09-04', type: 'expense', amount: 1800, account_id: A1, to_account_id: null, category_id: C2, note: '午饭', created_at: '2026-09-04T02:00:00.000Z' },
    ],
  }
}

/** 改第 i 条流水（默认第一条） */
function tx(over: Raw, i = 0): Fixture {
  const f = base()
  f.transactions[i] = { ...f.transactions[i], ...over }
  return f
}

/** 再加一条流水 */
function addTx(over: Raw): Fixture {
  const f = base()
  f.transactions.push({ ...f.transactions[0], id: T2, ...over })
  return f
}

function acc(over: Raw, i = 0): Fixture {
  const f = base()
  f.accounts[i] = { ...f.accounts[i], ...over }
  return f
}

function cat(over: Raw, i = 1): Fixture {
  const f = base()
  f.categories[i] = { ...f.categories[i], ...over }
  return f
}

const run = (f: Fixture) => (): unknown => validateImport(f)

describe('底稿本身是合法的', () => {
  it('不改任何东西就能通过，并且原样返回', () => {
    const out = validateImport(base())
    expect(out.accounts).toHaveLength(2)
    expect(out.categories).toHaveLength(3)
    expect(out.transactions[0].amount).toBe(1800)
  })
})

// ══════════════════════════════════════════════════════════════
// accounts
// ══════════════════════════════════════════════════════════════
describe('账户', () => {
  it('缺 id 或名称就拒绝', () => {
    expect(run({ ...base(), accounts: [{ id: A1 }] })).toThrow(/第 1 个账户.*缺少 id 或名称/)
  })

  it('id 不是 UUID 就拒绝——uuid 列不收「a1」这种字符串（22P02）', () => {
    expect(run(acc({ id: 'a1' }))).toThrow(/第 1 个账户.*a1.*UUID/)
  })

  it('kind 只能是 bank / wallet（accounts_kind_check）', () => {
    expect(run(acc({ kind: 'crypto' }, 1))).toThrow(/第 2 个账户.*crypto.*bank 或 wallet/)
  })

  it('sort 超出 smallint 就拒绝——超了数据库直接报 numeric field overflow', () => {
    expect(run(acc({ sort: 40000 }))).toThrow(/第 1 个账户.*排序值.*40000/)
  })

  it('is_archived 不是 true/false 就拒绝', () => {
    expect(run(acc({ is_archived: '否' }))).toThrow(/第 1 个账户.*归档标记/)
  })

  it('文件内部 id 重复就拒绝——批量 upsert 一次改不了同一行两遍（21000）', () => {
    expect(run(acc({ id: A1 }, 1))).toThrow(/第 2 个账户.*id.*重复/)
  })

  it('两个同名账户就拒绝——accounts 有 unique(user_id,name)', () => {
    expect(run(acc({ name: '微信' }, 1))).toThrow(/第 2 个账户.*微信.*同名/)
  })
})

// ══════════════════════════════════════════════════════════════
// categories
// ══════════════════════════════════════════════════════════════
describe('分类', () => {
  it('缺 id 或名称就拒绝', () => {
    const f = base()
    f.categories[0] = { id: C1, kind: 'expense' }
    expect(run(f)).toThrow(/第 1 个分类.*缺少 id 或名称/)
  })

  it('id 不是 UUID 就拒绝', () => {
    expect(run(cat({ id: 'c9' }))).toThrow(/第 2 个分类.*c9.*UUID/)
  })

  it('kind 只能是 expense / income', () => {
    expect(run(cat({ kind: 'transfer' }))).toThrow(/第 2 个分类.*transfer.*expense 或 income/)
  })

  it('parent_id 不是 UUID 就拒绝', () => {
    expect(run(cat({ parent_id: '上级' }))).toThrow(/第 2 个分类.*上级分类 id/)
  })

  it('icon / note 不是文字就拒绝', () => {
    expect(run(cat({ icon: 123 }))).toThrow(/第 2 个分类.*图标/)
    expect(run(cat({ note: { a: 1 } }))).toThrow(/第 2 个分类.*说明/)
  })

  it('id 重复就拒绝', () => {
    expect(run(cat({ id: C1 }))).toThrow(/第 2 个分类.*id.*重复/)
  })

  it('上级分类在文件里找不到就拒绝——外键会拒收，而那时云端已经空了', () => {
    expect(run(cat({ parent_id: uuid(99) }))).toThrow(/第 2 个分类.*午餐.*上级分类在这个文件里找不到/)
  })

  it('上级填成自己就拒绝', () => {
    expect(run(cat({ parent_id: C2 }))).toThrow(/第 2 个分类.*它自己/)
  })

  it('三级分类就拒绝——categories_depth_guard 只允许两级', () => {
    const f = base()
    f.categories.push({ id: uuid(14), kind: 'expense', parent_id: C2, name: '食堂', icon: null, sort: 1, is_archived: false, note: null })
    expect(run(f)).toThrow(/第 4 个分类.*食堂.*最多两级/)
  })

  it('父子 kind 不一致就拒绝——depth_guard 会当场报错', () => {
    expect(run(cat({ kind: 'income' }))).toThrow(/第 2 个分类.*午餐.*父子必须一致/)
  })

  it('两个同 kind 的一级分类同名就拒绝——cat_root_uniq', () => {
    const f = base()
    f.categories.push({ id: uuid(15), kind: 'expense', parent_id: null, name: '日常餐饮', icon: null, sort: 9, is_archived: false, note: null })
    expect(run(f)).toThrow(/第 4 个分类.*日常餐饮.*重名/)
  })

  it('同一个上级下面两个同名二级分类就拒绝——cat_child_uniq', () => {
    const f = base()
    f.categories.push({ id: uuid(16), kind: 'expense', parent_id: C1, name: '午餐', icon: null, sort: 9, is_archived: false, note: null })
    expect(run(f)).toThrow(/第 4 个分类.*午餐.*同一个上级/)
  })

  it('一级分类只在同 kind 内查重：支出「其他」和收入「其他」可以并存', () => {
    const f = base()
    f.categories.push({ id: uuid(17), kind: 'expense', parent_id: null, name: '其他', icon: null, sort: 8, is_archived: false, note: null })
    f.categories.push({ id: uuid(18), kind: 'income', parent_id: null, name: '其他', icon: null, sort: 9, is_archived: false, note: null })
    expect(validateImport(f).categories).toHaveLength(5)
  })

  it('二级分类只在同一个上级下查重：两个大类下面都能有「其他」', () => {
    const f = base()
    f.categories.push({ id: uuid(19), kind: 'expense', parent_id: null, name: '娱乐消费', icon: null, sort: 2, is_archived: false, note: null })
    f.categories.push({ id: uuid(20), kind: 'expense', parent_id: uuid(19), name: '午餐', icon: null, sort: 1, is_archived: false, note: null })
    expect(validateImport(f).categories).toHaveLength(5)
  })
})

// ══════════════════════════════════════════════════════════════
// transactions —— 单行就能查的
// ══════════════════════════════════════════════════════════════
describe('流水的字段', () => {
  it('缺 id 就拒绝', () => {
    const f = base()
    delete f.transactions[0].id
    expect(run(f)).toThrow(/第 1 条流水.*缺少 id/)
  })

  it('id 不是 UUID 就拒绝', () => {
    expect(run(tx({ id: 't1' }))).toThrow(/第 1 条流水.*t1.*UUID/)
  })

  it('日期格式不对就拒绝', () => {
    expect(run(tx({ date: '2026/09/04' }))).toThrow(/第 1 条流水.*日期格式不对/)
  })

  it('2月30日：正则过得去，但这一天不存在，数据库会拒收', () => {
    expect(run(tx({ date: '2025-02-30' }))).toThrow(/第 1 条流水的日期是 2025-02-30，这一天不存在/)
  })

  it('13 月 45 日：同上', () => {
    expect(run(tx({ date: '2025-13-45' }))).toThrow(/2025-13-45，这一天不存在/)
  })

  it('0000-00-00：同上', () => {
    expect(run(tx({ date: '0000-00-00' }))).toThrow(/0000-00-00，这一天不存在/)
  })

  it('闰年要算对：2024-02-29 合法，2025-02-29 不合法', () => {
    expect(validateImport(tx({ date: '2024-02-29' })).transactions[0].date).toBe('2024-02-29')
    expect(run(tx({ date: '2025-02-29' }))).toThrow(/这一天不存在/)
  })

  it('type 不认识就拒绝', () => {
    expect(run(tx({ type: 'refund' }))).toThrow(/第 1 条流水.*类型不认识/)
  })

  it('金额不是整数分就拒绝——「元当成分」那类备份脚本的唯一防线', () => {
    expect(run(tx({ amount: 18.5 }))).toThrow(/第 1 条流水.*整数分.*18\.5/)
  })

  it('金额超出 numeric(12,2) 就拒绝', () => {
    expect(run(tx({ amount: MAX_CENTS + 1 }))).toThrow(/第 1 条流水.*超出数据库能存的范围/)
    // 边界上那一分钱要能过
    expect(validateImport(tx({ amount: MAX_CENTS })).transactions[0].amount).toBe(MAX_CENTS)
  })

  it('created_at 不是合法时间就拒绝——它是 timestamptz not null', () => {
    expect(run(tx({ created_at: '刚才' }))).toThrow(/第 1 条流水.*记录时间/)
    expect(run(tx({ created_at: null }))).toThrow(/第 1 条流水.*记录时间/)
  })

  it('id 重复就拒绝', () => {
    expect(run(addTx({ id: T1 }))).toThrow(/第 2 条流水.*重复/)
  })
})

// ══════════════════════════════════════════════════════════════
// transactions —— tx_shape（0002 版）
// ══════════════════════════════════════════════════════════════
describe('流水的形状（tx_shape）', () => {
  it('支出没有分类就拒绝', () => {
    expect(run(tx({ category_id: null }))).toThrow(/第 1 条流水是支出，但没有分类/)
  })

  it('支出填了转入账户就拒绝', () => {
    expect(run(tx({ to_account_id: A2 }))).toThrow(/第 1 条流水是支出，却填了转入账户/)
  })

  it('支出金额是 0 或负数就拒绝', () => {
    expect(run(tx({ amount: 0 }))).toThrow(/第 1 条流水是支出，金额却是 0/)
    expect(run(tx({ amount: -100 }))).toThrow(/必须大于 0/)
  })

  it('收入同样必须有分类、金额为正', () => {
    expect(run(tx({ type: 'income', category_id: null }))).toThrow(/是收入，但没有分类/)
  })

  it('支出可以不指定账户（0002 放开的），这是合法的', () => {
    expect(validateImport(tx({ account_id: null })).transactions[0].account_id).toBeNull()
  })

  it('转账带了分类就拒绝', () => {
    expect(run(tx({ type: 'transfer', account_id: A1, to_account_id: A2 }))).toThrow(/是转账，却填了分类/)
  })

  it('转账没有转出账户就拒绝——0002 明确要求 account_id not null', () => {
    expect(run(tx({ type: 'transfer', category_id: null, account_id: null, to_account_id: A2 }))).toThrow(/是转账，但没有转出账户/)
  })

  it('转账没有转入账户就拒绝', () => {
    expect(run(tx({ type: 'transfer', category_id: null, to_account_id: null }))).toThrow(/是转账，但没有转入账户/)
  })

  it('转账两边是同一个账户就拒绝', () => {
    expect(run(tx({ type: 'transfer', category_id: null, account_id: A1, to_account_id: A1 }))).toThrow(/转出和转入却是同一个账户/)
  })

  it('转账金额必须大于 0', () => {
    expect(run(tx({ type: 'transfer', category_id: null, account_id: A1, to_account_id: A2, amount: 0 }))).toThrow(/是转账，金额却是 0/)
  })

  it('校准没有账户就拒绝——不指定账户的话余额无从算起', () => {
    expect(run(tx({ type: 'adjust', category_id: null, account_id: null }))).toThrow(/是余额校准，但没有账户/)
  })

  it('校准带了分类或转入账户就拒绝', () => {
    expect(run(tx({ type: 'adjust' }))).toThrow(/是余额校准，却填了分类/)
    expect(run(tx({ type: 'adjust', category_id: null, to_account_id: A2 }))).toThrow(/是余额校准，却填了转入账户/)
  })

  it('校准可以是负数、也可以是 0，这是合法的', () => {
    expect(validateImport(tx({ type: 'adjust', category_id: null, amount: -1084 })).transactions[0].amount).toBe(-1084)
    expect(validateImport(tx({ type: 'adjust', category_id: null, amount: 0 })).transactions[0].amount).toBe(0)
  })
})

// ══════════════════════════════════════════════════════════════
// transactions —— 外键与触发器
// ══════════════════════════════════════════════════════════════
describe('流水引用的东西必须在同一个文件里', () => {
  it('账户找不到就拒绝——压测就是栽在这类文件上：清空了，导不回来', () => {
    expect(run(tx({ account_id: uuid(98) }))).toThrow(/第 1 条流水.*账户在这个文件里找不到/)
  })

  it('转入账户找不到就拒绝', () => {
    expect(run(tx({ type: 'transfer', category_id: null, account_id: A1, to_account_id: uuid(98) }))).toThrow(/转入的账户在这个文件里找不到/)
  })

  it('分类找不到就拒绝', () => {
    expect(run(tx({ category_id: uuid(97) }))).toThrow(/第 1 条流水.*分类在这个文件里找不到/)
  })

  it('分类的 kind 和流水的 type 对不上就拒绝——tx_category_kind_guard', () => {
    expect(run(tx({ category_id: CI }))).toThrow(/第 1 条流水是支出，却记在「工资\/实习」这个收入分类上/)
  })

  it('收入记在支出分类上，同样拒绝', () => {
    expect(run(tx({ type: 'income' }))).toThrow(/是收入，却记在「午餐」这个支出分类上/)
  })
})

// ══════════════════════════════════════════════════════════════
// 归一化：老备份缺字段不能被拦死，但也不能让批量 upsert 写出 NULL
// ══════════════════════════════════════════════════════════════
describe('缺省字段按数据库默认值补齐', () => {
  it('0003 之前导的老备份没有 note，补成 null 而不是报错', () => {
    const f = base()
    delete f.categories[0].note
    delete f.categories[0].icon
    expect(validateImport(f).categories[0]).toMatchObject({ note: null, icon: null })
  })

  it('缺 sort / is_archived / kind 时补数据库默认值（0 / false / bank）', () => {
    const f = base()
    delete f.accounts[0].sort
    delete f.accounts[0].is_archived
    delete f.accounts[0].kind
    expect(validateImport(f).accounts[0]).toMatchObject({ sort: 0, is_archived: false, kind: 'bank' })
  })

  it('流水缺 note / 三个可空外键时补 null', () => {
    const f = base()
    delete f.transactions[0].note
    delete f.transactions[0].to_account_id
    expect(validateImport(f).transactions[0]).toMatchObject({ note: null, to_account_id: null })
  })
})

describe('报错要能定位', () => {
  it('第几条、哪个字段、读到了什么，三样都要有', () => {
    const f = base()
    f.transactions.push({ ...f.transactions[0], id: T2, date: '2025-02-30' })
    expect(run(f)).toThrow('备份文件第 2 条流水的日期是 2025-02-30，这一天不存在')
  })

  it('只报第一个错，不刷屏', () => {
    const f = base()
    f.transactions[0].date = '2025-02-30'
    f.transactions[0].amount = 1.5
    expect(run(f)).toThrow(/这一天不存在/)
  })
})
