import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { findAccount, findCat, lastAccountByParent } from './book'
import { draftProblem, draftToTx, makeDraft, type DraftCtx } from './drafts'
import { factsOf, ledgerLinkOf, prevRange, type Query } from './facts'
import { OUTER_FORBIDDEN, safeReply } from './guard'
import { normNote, oneoffSpends } from './oneoff'
import { analysisPrompt, intentSystem } from './prompt'
import { parseAnalysis, parseIntent, parseJsonObject, type DraftInput } from './protocol'
import { outerBook } from '../facade'
import { parseAiYuan } from '../money'
import type { Account, Category, Transaction } from '../../types'

// ---- 一本照用户真实分类结构搭的小账本（名字照抄，金额编的） ----
const cat = (id: string, kind: 'expense' | 'income', name: string, parent: string | null = null, extra: Partial<Category> = {}): Category => ({ id, kind, parent_id: parent, name, icon: null, sort: 0, is_archived: false, note: null, ...extra })
const CATS: Category[] = [
  cat('daily', 'expense', '日常开支'),
  cat('lunch', 'expense', '午餐', 'daily'),
  cat('commute', 'expense', '通勤交通', 'daily'),
  cat('reg', 'expense', '经常生活开支'),
  cat('rent', 'expense', '房租', 'reg'),
  cat('irr', 'expense', '非经常生活消费'),
  cat('digital', 'expense', '数码电器', 'irr'),
  cat('home', 'expense', '家居家装', 'irr'),
  cat('irrOther', 'expense', '其他', 'irr'),
  cat('acc', 'expense', '意外开支'),
  cat('fee', 'expense', '手续费利息', 'acc'),
  cat('accOther', 'expense', '其他', 'acc'),
  cat('fun', 'expense', '娱乐消费'),
  cat('game', 'expense', '游戏充值', 'fun'),
  cat('meal', 'expense', '聚餐下馆子', 'fun'),
  cat('love', 'expense', '恋爱'),
  cat('anniv', 'expense', '纪念日节日', 'love'),
  cat('old', 'expense', '咖啡奶茶', 'daily', { is_archived: true }),
  cat('salary', 'income', '工资/实习'),
  cat('refund', 'income', '退款'),
  cat('other', 'income', '其他'),
]
const acc = (id: string, name: string, kind: Account['kind'] = 'wallet', extra: Partial<Account> = {}): Account => ({ id, name, kind, sort: 0, is_archived: false, repay_day: null, defer_after_repay: false, facade_offset: 0, ...extra }) as Account
const ACCS: Account[] = [acc('wx', '微信'), acc('zfb', '支付宝'), acc('cmb', '招商银行', 'bank'), acc('boc', '中国银行', 'bank'), acc('hb', '花呗/淘宝', 'credit', { repay_day: 8 }), acc('jd', '京东白条', 'credit', { repay_day: 17 })]
let n = 0
const tx = (date: string, type: Transaction['type'], amount: number, category_id: string | null, extra: Partial<Transaction> = {}): Transaction => ({ id: `t${++n}`, date, type, amount, account_id: 'wx', to_account_id: null, category_id, note: null, installments: null, settles: null, hidden: null, is_offset: null, created_at: `${date}T10:00:00Z`, ...extra })

describe('金额：AI 给的元 → 分，严格', () => {
  it('正常的数和字符串', () => {
    expect(parseAiYuan(12)).toBe(1200)
    expect(parseAiYuan(22.8)).toBe(2280)
    expect(parseAiYuan(22.799999999)).toBe(2280)
    expect(parseAiYuan('1,234.5')).toBe(123450)
    expect(parseAiYuan('¥16元')).toBe(1600)
  })
  it('空、0、负数、三位小数、科学计数、十六进制、汉字 → null（不悄悄记成 0）', () => {
    for (const v of ['', '  ', 0, -5, '-5', 12.345, '1e3', '0x10', '两百五', null, undefined, NaN, Infinity, {}]) expect(parseAiYuan(v)).toBeNull()
  })
})

describe('分类、账户按名字找回来', () => {
  it('一级 + 二级原样对上；二级没给 → needChild', () => {
    expect(findCat(CATS, 'expense', '日常开支', '午餐')).toMatchObject({ ok: true, child: { id: 'lunch' }, needChild: false })
    expect(findCat(CATS, 'expense', '意外开支', '')).toMatchObject({ ok: true, parent: { id: 'acc' }, child: null, needChild: true })
  })
  it('一级给错了不拿二级反推；只给二级时唯一才反推，重名（两个「其他」）是 ambiguous', () => {
    // 变异：一级对不上时退回去用二级反推 → 第一条红
    expect(findCat(CATS, 'expense', '娱乐', '午餐')).toEqual({ ok: false, reason: 'nomatch' })
    expect(findCat(CATS, 'expense', '', '午餐')).toMatchObject({ ok: true, parent: { id: 'daily' } })
    expect(findCat(CATS, 'expense', '', '其他')).toEqual({ ok: false, reason: 'ambiguous' })
    expect(findCat(CATS, 'expense', '', '')).toEqual({ ok: false, reason: 'none' })
  })
  it('二级在这个一级下面找不到：一级照用、要用户挑（不悄悄记在一级上）；归档的不认', () => {
    expect(findCat(CATS, 'expense', '日常开支', '咖啡奶茶')).toMatchObject({ ok: true, parent: { id: 'daily' }, child: null, needChild: true })
  })
  it('账户：整名、「/」别名、唯一包含；「银行」两个都包含不猜', () => {
    expect(findAccount(ACCS, '微信')?.id).toBe('wx')
    expect(findAccount(ACCS, '花呗')?.id).toBe('hb')
    expect(findAccount(ACCS, '京东')?.id).toBe('jd')
    expect(findAccount(ACCS, '银行')).toBeNull()
    expect(findAccount(ACCS, '')).toBeNull()
  })
  it('缩写（用户 2026-11-28 给的）：vx、v 微信、zfb 支付宝、zh 中国银行、pdd 拼多多、jd 京东、tb 淘宝，不分大小写', () => {
    const accs = [...ACCS, acc('pdd', '拼多多', 'credit')]
    expect(findAccount(accs, 'vx')?.id).toBe('wx')
    expect(findAccount(accs, 'V')?.id).toBe('wx')
    expect(findAccount(accs, 'ZFB')?.id).toBe('zfb')
    expect(findAccount(accs, 'zh')?.id).toBe('boc')
    expect(findAccount(accs, 'pdd')?.id).toBe('pdd')
    expect(findAccount(accs, 'jd')?.id).toBe('jd')
    expect(findAccount(accs, 'tb')?.id).toBe('hb')
    // 中国银行的账户名叫「中行」也认
    expect(findAccount([acc('boc', '中行', 'bank')], 'zh')?.id).toBe('boc')
    // 招商银行不要缩写；这本账里没有拼多多就是没有，不乱指
    expect(findAccount(accs, 'zs')).toBeNull()
    expect(findAccount(ACCS, 'pdd')).toBeNull()
    // 发给 AI 的对照只列对得上的
    const sys = intentSystem({ cats: CATS, accounts: ACCS, drafts: [], todayYmd: '2026-11-28' })
    expect(sys).toContain('vx=微信、v=微信、zfb=支付宝、zh=中国银行、jd=京东白条、tb=花呗/淘宝')
    expect(sys).not.toContain('pdd=')
  })
  it('默认账户 = 这个一级最近一次用的', () => {
    const m = lastAccountByParent([tx('2026-11-01', 'expense', 100, 'lunch', { account_id: 'cmb' }), tx('2026-11-03', 'expense', 100, 'lunch', { account_id: 'zfb' })], CATS)
    expect(m.get('daily')).toBe('zfb')
  })
})

describe('AI 回复当不可信输入：只留白名单里的动作', () => {
  const T = '2026-11-25'
  it('宽松取 JSON：整段 / ```json 围着 / 前后有一句话；空白、截断 → null', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonObject('好的\n```json\n{"a":2}\n```')).toEqual({ a: 2 })
    expect(parseJsonObject('结果：{"a":3} 完')).toEqual({ a: 3 })
    expect(parseJsonObject('   ')).toBeNull()
    expect(parseJsonObject('{"reply":"半截')).toBeNull()
  })
  it('校准、未知动作丢掉；日期不合法的查询丢掉；查询截到今天、倒过来的范围摆正', () => {
    const it = parseIntent(JSON.stringify({ reply: '好', actions: [{ op: 'new', kind: 'adjust', amount: 1 }, { op: 'drop_table' }, { op: 'query', kind: 'expense', from: '2026-02-30', to: '2026-03-01' }, { op: 'query', from: '2026-12-31', to: '2026-11-01' }] }), T)!
    expect(it.actions).toEqual([{ op: 'query', q: { kind: 'expense', parent: '', child: '', keyword: '', from: '2026-11-01', to: '2026-11-25', chart: false } }])
  })
  it('转账没有抵消；期数超范围回到 1；reply 和动作都没有 → null', () => {
    const it = parseIntent(JSON.stringify({ reply: 'x', actions: [{ op: 'new', kind: 'transfer', offset: true, amount: 21, account: '微信', to_account: '招商银行' }, { op: 'new', kind: 'expense', amount: 600, installments: 99 }] }), T)!
    expect(it.actions[0]).toMatchObject({ op: 'new', draft: { kind: 'transfer', offset: false, toAccount: '招商银行' } })
    expect(it.actions[1]).toMatchObject({ draft: { installments: 1 } })
    expect(parseIntent('{"reply":"","actions":[]}', T)).toBeNull()
  })
  it('分析的回复：refs 只认 r1–r99、最多 3 个', () => {
    expect(parseAnalysis(JSON.stringify({ reply: '一段话', refs: ['r1', 't9', 'r2', 'r3', 'r4'], ask: ['a', 'b', 'c'] }))).toEqual({ reply: '一段话', refs: ['r1', 'r2', 'r3'], ask: ['a', 'b'] })
  })
})

describe('记账卡片：和记一笔页同样的规矩', () => {
  const ctx: DraftCtx = { cats: CATS, accounts: ACCS, lastAcc: new Map([['daily', 'zfb']]), todayYmd: '2026-11-25' }
  const input = (p: Partial<DraftInput>): DraftInput => ({ kind: 'expense', offset: false, parent: '', child: '', amount: 12, account: '', toAccount: '', installments: 1, date: '', note: '', ...p })

  it('没说账户用这一类上次的；日期默认今天、未来的拉回今天', () => {
    const d = makeDraft(input({ parent: '日常开支', child: '午餐', date: '2026-12-01' }), ctx, 'd1', 'id1')
    expect(d).toMatchObject({ parentId: 'daily', childId: 'lunch', accountId: 'zfb', date: '2026-11-25', amount: 1200 })
    expect(draftProblem(d, ctx)).toBeNull()
  })
  it('只说了一级：不选二级（或「不细分」）不能存', () => {
    const d = makeDraft(input({ parent: '意外开支' }), ctx, 'd1', 'id1')
    expect(draftProblem(d, ctx)).toBe('选一下二级分类')
    expect(draftProblem({ ...d, noChild: true }, ctx)).toBeNull()
    expect(draftProblem({ ...d, childId: 'fee' }, ctx)).toBeNull()
  })
  it('金额不对、分类对不上 → 不能存', () => {
    expect(draftProblem(makeDraft(input({ parent: '日常开支', child: '午餐', amount: '两百五' }), ctx, 'd', 'i'), ctx)).toBe('金额不对，点开改一下')
    expect(draftProblem(makeDraft(input({ parent: '不存在' }), ctx, 'd', 'i'), ctx)).toBe('选一下分类')
  })
  it('转账：两头都要且不同；存成 transfer、没有分类', () => {
    const d = makeDraft(input({ kind: 'transfer', amount: 21, account: '微信', toAccount: '招商银行' }), ctx, 'd', 'tid')
    expect(draftProblem(d, ctx)).toBeNull()
    expect(draftToTx(d, ACCS, 'now')).toMatchObject({ id: 'tid', type: 'transfer', amount: 2100, account_id: 'wx', to_account_id: 'cmb', category_id: null, is_offset: null, hidden: null })
    expect(draftProblem(makeDraft(input({ kind: 'transfer', amount: 21, account: '微信', toAccount: '微信' }), ctx, 'd', 'i'), ctx)).toBe('选一下从哪转到哪')
  })
  it('退款 = 收入 + 抵消，分类用支出那边的', () => {
    // 变异：catSideOf 不看 offset（退款去收入分类里找「午餐」）→ 红
    const d = makeDraft(input({ kind: 'income', offset: true, parent: '日常开支', child: '午餐', amount: 5 }), ctx, 'd', 'i')
    expect(draftProblem(d, ctx)).toBeNull()
    expect(draftToTx(d, ACCS, 'now')).toMatchObject({ type: 'income', is_offset: true, category_id: 'lunch' })
  })
  it('白条分期：只有白条上的支出能分；期数写进 installments', () => {
    const d = makeDraft(input({ parent: '非经常生活消费', child: '数码电器', amount: 600, account: '花呗', installments: 3 }), ctx, 'd', 'i')
    expect(draftToTx(d, ACCS, 'now')).toMatchObject({ account_id: 'hb', installments: 3 })
    const notCredit = makeDraft(input({ parent: '非经常生活消费', child: '数码电器', amount: 600, account: '微信', installments: 3 }), ctx, 'd', 'i')
    expect(notCredit.installments).toBe(1)
    expect(draftProblem({ ...notCredit, installments: 3 }, ctx)).toBe('只有白条上的支出能分期')
  })
  it('同一张卡片的流水 id 建卡时就定了（重试保存不会变两条）', () => {
    const d = makeDraft(input({ parent: '日常开支', child: '午餐' }), ctx, 'd', 'fixed-id')
    expect(draftToTx(d, ACCS, 'a').id).toBe(draftToTx(d, ACCS, 'b').id)
  })
})

describe('一次性开支（用户 2026-11-25 按自己的账定的规矩）', () => {
  const T = '2026-11-25'
  const book = [
    tx('2026-11-03', 'expense', 2500, 'lunch', { note: '麦当劳' }), // 日常开支：永远不算
    tx('2026-11-01', 'expense', 350000, 'rent'), // 经常生活开支：不算
    tx('2026-11-10', 'expense', 6600, 'home'), // 非经常：整类都算（没备注也算）
    tx('2026-11-02', 'expense', 12200, 'accOther', { note: '证券考试' }), // 意外开支：算
    tx('2026-11-08', 'expense', 12400, 'game', { note: '城市天际线2' }), // 娱乐：备注只出现一次 → 算
    tx('2026-10-20', 'expense', 1200, 'game', { note: '哔哩哔哩漫画' }),
    tx('2026-11-20', 'expense', 1200, 'game', { note: '哔哩哔哩漫画 ' }), // 重复的备注（规范化后相同）→ 不算
    tx('2026-11-15', 'expense', 100200, 'anniv'), // 恋爱·纪念日，没备注，这一类 90 天就 1 笔 → 算
    tx('2026-11-05', 'expense', 8000, 'meal'),
    tx('2026-11-12', 'expense', 9000, 'meal'),
    tx('2026-11-19', 'expense', 7000, 'meal'), // 聚餐 90 天 3 笔 → 不算
    tx('2026-11-21', 'expense', 3000, 'meal', { note: 'Excel 导入' }), // 自动备注当没写 → 按频次 → 不算
    tx('2026-11-22', 'income', 500, 'home', { is_offset: true }), // 退款不算
  ]
  it('按规矩挑出来，从大到小', () => {
    // 变异：去掉「日常开支整类不算」→ 麦当劳混进来红；备注不规范化 → 哔哩哔哩漫画混进来红
    expect(oneoffSpends(book, CATS, '2026-11-01', T).map((t) => t.note ?? t.category_id)).toEqual(['anniv', '城市天际线2', '证券考试', 'home'])
  })
  it('名字登记表里的四个一级就是用户的', () => {
    expect(normNote('  Ｅｘｃｅｌ 导入 ')).toBe('')
  })
  it('外页面那本账：藏起来的一次性开支不出现', () => {
    const hidden = tx('2026-11-11', 'expense', 66600, 'digital', { note: '哨兵-里页面', hidden: true })
    const o = outerBook([...book, hidden], ACCS, [], 'outer')
    expect(oneoffSpends(o, CATS, '2026-11-01', T).some((t) => t.id === hidden.id)).toBe(false)
    expect(oneoffSpends([...book, hidden], CATS, '2026-11-01', T).some((t) => t.id === hidden.id)).toBe(true)
  })
})

describe('查账的数：App 自己算', () => {
  const T = '2026-11-25'
  const book = [tx('2026-11-01', 'expense', 350000, 'rent'), tx('2026-11-03', 'expense', 2500, 'lunch'), tx('2026-11-04', 'expense', 3000, 'lunch'), tx('2026-11-05', 'income', 500, 'lunch', { is_offset: true }), tx('2026-11-06', 'transfer', 99900, null), tx('2026-10-03', 'expense', 2000, 'lunch'), tx('2026-11-23', 'income', 1200000, 'salary')]
  const q = (p: Partial<Query>): Query => ({ kind: 'expense', from: '2026-11-01', to: T, parentId: null, childId: null, keyword: null, ...p })
  it('合计是净额（退款扣掉）、转账不算；构成和占比', () => {
    const f = factsOf(book, CATS, q({}), T)
    expect(f.total).toBe(350000 + 2500 + 3000 - 500)
    expect(f.count).toBe(4)
    expect(f.parts.map((p) => [p.name, p.total, p.sharePct])).toEqual([['经常生活开支', 350000, 99], ['日常开支', 5000, 1]])
    expect(f.top2SharePct).toBe(100)
  })
  it('限定一级就按二级拆；上一段 = 上个月同样的几号', () => {
    const f = factsOf(book, CATS, q({ parentId: 'daily' }), T)
    expect(f.parts[0]).toMatchObject({ name: '午餐', total: 5000 })
    expect(f.prev).toEqual({ from: '2026-10-01', to: '2026-10-25', total: 2000 })
    expect(prevRange('2026-03-01', '2026-03-31')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(prevRange('2026-09-25', '2026-11-25')).toEqual({ from: '2026-07-25', to: '2026-09-24' })
  })
  it('「在流水里看」：带日期范围；限定分类时不带 type（退款原始类型是收入，带了会被筛掉）', () => {
    expect(ledgerLinkOf(q({ from: '2026-09-25' }))).toBe('/ledger?from=2026-09-25&to=2026-11-25&type=expense&cat=all')
    expect(ledgerLinkOf(q({ parentId: 'daily', childId: 'lunch' }))).toBe('/ledger?from=2026-11-01&to=2026-11-25&cat=daily&sub=lunch')
  })
})

describe('里外：外页面下发给 AI 的东西里没有里页面的东西', () => {
  it('哨兵：藏起来的那笔的备注、金额不出现在两步的提示词里', () => {
    const T = '2026-11-25'
    const hidden = tx('2026-11-11', 'expense', 77777, 'digital', { note: '哨兵备注XYZ', hidden: true })
    const book = [tx('2026-11-03', 'expense', 2500, 'lunch', { note: '麦当劳' }), hidden]
    const o = outerBook(book, ACCS, [], 'outer')
    const f = factsOf(o, CATS, { kind: 'expense', from: '2026-11-01', to: T, parentId: null, childId: null, keyword: null }, T)
    const p = analysisPrompt(f, CATS, '支出')
    const all = p.system + p.user + intentSystem({ cats: CATS, accounts: ACCS, drafts: [], todayYmd: T })
    expect(all).not.toContain('哨兵备注XYZ')
    expect(all).not.toContain('777.77')
    expect(p.refIds).not.toContain(hidden.id)
    // 对照：里页面那本账里有它（证明测试本身能看见）
    expect(analysisPrompt(factsOf(book, CATS, f.q, T), CATS, '支出').user).toContain('哨兵备注XYZ')
  })
  it('外页面下 AI 的话里出现里外相关的字 → 整句换掉；里页面原样', () => {
    for (const w of OUTER_FORBIDDEN) expect(safeReply(`有一笔${w}的记录`, 'outer')).not.toContain(w)
    expect(safeReply('有一笔隐藏的记录', 'inner')).toBe('有一笔隐藏的记录')
    expect(safeReply('本月花了不少', 'outer')).toBe('本月花了不少')
  })
  it('弹层只吃当前模式那本账；记上的流水不打「外面隐藏」', () => {
    const src = readFileSync(new URL('../../components/AssistantSheet.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/const otxs = useMemo\(\(\) => outerBook\(txs, accounts, fadj, mode\), \[txs, accounts, fadj, mode\]\)/)
    expect(src).not.toMatch(/factsOf\(txs|oneoffSpends\(txs|lastAccountByParent\(txs/)
    expect(src).toMatch(/safeReply\(/)
    expect(readFileSync(new URL('./drafts.ts', import.meta.url), 'utf8')).toMatch(/hidden: null,/)
  })
})
