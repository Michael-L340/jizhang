// 里外页面的纯逻辑（账本口径那部分在 facade.book.test.ts）。
//
// 这一层守的是几条不能破的规矩：
//   一、白条永远不参与修饰——欠款两边一样，这是用户 2026-09-07 拍板的；
//   二、里模式必须原样返回，一分钱都不能动；
//   三、外模式下校准记录整条隐身（真实的、外页面的都不列），且账户页副标题两种模式都从原始流水取时间；
//   四、「外面隐藏」= 外页面当这一笔不存在；
//   五、页面里所有算钱的地方只准吃 otxs / vtxs（源码守卫）。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { hiddenSummary, lastAdjustAt, outerBook, outerList } from './facade'
import { balances, monthSummary } from './compute'
import type { Account, Transaction } from '../types'

const acc = (id: string, kind: Account['kind'], facade_offset: number | null = null): Account => ({
  id,
  name: id,
  kind,
  sort: 1,
  is_archived: false,
  repay_day: null,
  facade_offset,
  defer_after_repay: null,
})

const boc = acc('boc', 'bank', -216326) // 老模型修饰过（这一列已退役，新模型不看它）
const cmb = acc('cmb', 'bank')
const wx = acc('wx', 'wallet')
const jd = acc('jd', 'credit', -500000) // 白条，数据里就算带着偏移量也不能生效
const ALL = [boc, cmb, wx, jd]

const tx = (id: string, date: string, type: Transaction['type'], amount: number, account_id: string | null): Transaction => ({
  id,
  date,
  type,
  amount,
  account_id,
  to_account_id: null,
  category_id: null,
  note: null,
  installments: null,
  settles: null,
  hidden: null,
  created_at: `${date}T00:00:0${id.length}.000Z`,
})

describe('外页面藏掉校准记录', () => {
  // 2026-09-08 用户在首页截到的那一幕：支付宝余额显示 0.00，
  // 下面「最近流水」却挂着一条 +6,391.00 的余额校准。
  const txs = [
    tx('a', '2026-09-01', 'expense', 2090, 'boc'),
    tx('b', '2026-09-07', 'adjust', 639100, 'boc'),
    tx('c', '2026-09-07', 'adjust', -1084, 'wx'), // 2026-09-27 起没修饰过的账户也一样藏（孪生记录补进账本）
    tx('d', '2026-09-07', 'adjust', 5000, 'jd'), // 白条不分里外，照常显示
  ]

  it('里模式原样返回同一个数组', () => {
    expect(outerList(txs, ALL, 'inner')).toBe(txs)
    expect(outerBook(txs, ALL, [], 'inner')).toBe(txs)
  })

  it('外模式藏掉所有非白条账户的校准，白条那条不动', () => {
    // 变异：stripForOuter 不看账户种类 → 白条那条也没了，红；只藏修饰过的 → wx 那条漏出去，红
    expect(outerList(txs, ALL, 'outer').map((t) => t.id)).toEqual(['a', 'd'])
  })

  it('哪个账户都没有校准、也没藏任何一笔时返回同一个数组，不做多余的拷贝', () => {
    const plain = [txs[0], txs[3]]
    expect(outerList(plain, ALL, 'outer')).toBe(plain)
    expect(outerBook(plain, ALL, [], 'outer')).toBe(plain)
  })

  it('白条的余额两边一样：外页面那本账里它的真实校准照旧算', () => {
    // 变异：outerBook 把白条的校准也摘掉 → 外页面白条余额少 5,000，红
    expect(balances(outerBook(txs, ALL, [], 'outer'), ALL).jd).toBe(5000)
    expect(balances(txs, ALL).jd).toBe(5000)
  })
})

describe('账户页副标题「上次校准」：外页面下各账户必须长一样', () => {
  // 2026-09-16 用户截图：中国银行、支付宝（修饰过）显示「点此输入实际余额核对」，
  // 招行、微信（没修饰）显示「上次校准 9/3」。两种字并排，等于把哪两个动过手脚写在脸上。
  const adj = (id: string, account_id: string, created_at: string): Transaction => ({ ...tx(id, '2026-09-03', 'adjust', 100, account_id), created_at })
  const txs = [adj('a1', 'boc', '2026-09-03T12:15:00Z'), adj('a2', 'wx', '2026-09-03T12:02:00Z'), adj('a3', 'boc', '2026-09-01T00:00:00Z')]

  it('从原始流水取时间：每个账户取最近一次', () => {
    const m = lastAdjustAt(txs)
    expect(m.get('boc')).toBe('2026-09-03T12:15:00Z')
    expect(m.get('wx')).toBe('2026-09-03T12:02:00Z')
    expect(m.get('cmb')).toBeUndefined()
  })

  it('要是拿外页面的列表去算，日期就全没了——这就是那个露馅点', () => {
    const m = lastAdjustAt(outerList(txs, ALL, 'outer'))
    expect(m.get('boc')).toBeUndefined()
    expect(m.get('wx')).toBeUndefined()
  })

  it('账户页必须把原始 txs 传给 lastAdjustAt，不能传 vtxs', () => {
    // 页面测不了（没有 DOM），守源码：改成 lastAdjustAt(vtxs) 这条会红
    const src = readFileSync(new URL('../pages/Accounts.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/lastAdjustAt\(txs\)/)
    expect(src).not.toMatch(/lastAdjustAt\(vtxs\)/)
  })
})

describe('「外面隐藏」：外页面当这一笔不存在', () => {
  // 用户 2026-09-16 最终口径：藏了的记录在外页面整条不算——列表、余额、曲线、统计都不算。
  // 第一版做成「只藏行、钱照算」，首页和流水页各出一个「本月支出」，对不上，当天推翻。
  const income = { ...tx('i1', '2026-09-10', 'income', 100000, 'wx'), hidden: true }
  const spend = tx('e1', '2026-09-11', 'expense', 3000, 'wx')
  const txs = [income, spend]

  it('外页面的账本和列表里都没有它；里页面原样', () => {
    // 变异：stripForOuter 不看 hidden → 红
    expect(outerBook(txs, ALL, [], 'outer').map((t) => t.id)).toEqual(['e1'])
    expect(outerList(txs, ALL, 'outer').map((t) => t.id)).toEqual(['e1'])
    expect(outerBook(txs, ALL, [], 'inner')).toBe(txs)
  })

  it('外页面的余额和本月收入都不含它，里页面含', () => {
    expect(balances(outerBook(txs, ALL, [], 'outer'), ALL).wx).toBe(-3000)
    expect(balances(txs, ALL).wx).toBe(97000)
    expect(monthSummary(outerBook(txs, ALL, [], 'outer'), '2026-09').income).toBe(0)
    expect(monthSummary(txs, '2026-09').income).toBe(100000)
  })

  it('页面里算钱的地方一律不许吃原始 txs——只准吃 otxs / vtxs；账本必须从 outerBook 来', () => {
    // 页面测不了（没有 DOM），守源码。第一版漏的正是这里：12 处调用各吃各的。
    // 变异：把 Home 的 monthSummary(otxs 改回 monthSummary(txs → 红
    // 变异：进阶分析页 firstFlowDate(otxs) 改成 firstFlowDate(txs)、outerBook 的 mode 写死成 'inner' → 红
    const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
    const money = /(monthSummary|byCategory|balances|monthTotals|firstFlowDate|seriesTotals|seriesByCategory|balanceSeries|searchTx)\(\s*txs\b/
    for (const p of ['../pages/Home.tsx', '../pages/Stats.tsx', '../pages/Ledger.tsx', '../pages/Accounts.tsx', '../pages/StatsMore.tsx']) {
      const src = read(p)
      expect(src, `${p} 里有算钱的函数直接吃了原始 txs`).not.toMatch(money)
      expect(src, `${p} 必须建 otxs = outerBook(txs, 全部账户, fadj, mode)`).toMatch(/const otxs = useMemo\(\(\) => outerBook\(txs, (accounts|allAccounts), fadj, mode\)/)
      expect(src, `${p} 不许再用老模型的函数`).not.toMatch(/applyFacade|shiftSeries|adjustTotals|facadeShift|offsetOf|isDecorated|facade_offset/)
    }
    expect(read('../pages/Home.tsx')).not.toMatch(/for \(const t of txs\)/) // 今日收支那个循环
    expect(read('../pages/Ledger.tsx')).toMatch(/g\.items\.map/) // 行不再单独过滤
    for (const p of ['./compute.ts', './chart.ts']) expect(read(p), `${p} 不该碰 hidden`).not.toMatch(/\.hidden/)
    // 统计页的曲线直接画那本账，不许再叠任何平移
    expect(read('../pages/Stats.tsx')).toMatch(/balanceSeries\(otxs, accounts, keys, unit\)/)
  })

  it('进阶分析页：每张图只吃 otxs；页面里没有 hidden、没有「隐」「外页面」这几个字', () => {
    // 这一页在外页面下照常打开，也没有里页面专属的东西，所以整个源文件（连注释）都不许出现这几个字——
    // 比「只查 JSX 里的字」好守，也不会有人顺手在界面上写个「显示 / 隐藏」开关。
    // 变异：MoreInput 里写成 txs: txs → 红；自定义开关文案写成「隐藏」→ 红；读一下 t.hidden → 红
    const src = readFileSync(new URL('../pages/StatsMore.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/\(\{ txs: otxs, accounts, cats, ym, start, end, today: t \}\)/)
    // 原始 txs 只准出现在「从 store 取」和「建 otxs」这两行（注释不算）
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    const rest = code
      .replace('const txs = useStore((s) => s.transactions)', '')
      .replace('outerBook(txs, accounts, fadj, mode), [txs, accounts, fadj, mode]', '')
      .replace('({ txs: otxs,', '')
    expect(rest.match(/.{0,30}\btxs\b.{0,30}/g) ?? [], '原始 txs 漏到别处去了').toEqual([])
    expect(src).not.toMatch(/\.hidden\b/)
    expect(src).not.toMatch(/隐|外页面|外面|mode ===|mode !==/)
  })

  it('账户页：「对外显示」的差额必须按外页面那本账算，两种模式都算一份', () => {
    // 变异：outerBal 改成拿 bal（里页面下是真实余额）→ 红。真实校准外页面看不见，差额按真实余额算就错一截
    const src = readFileSync(new URL('../pages/Accounts.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/const outerBal = useMemo\(\(\) => balances\(outerBook\(txs, accounts, fadj, 'outer'\), accounts\)/)
    expect(src).toMatch(/facadeDelta\(want, outerBal\[a\.id\] \?\? 0\)/)
  })
})

describe('里页面校准弹层那行「隐藏金额汇总 · n 笔 −¥X」', () => {
  // 纯展示：把这个账户藏掉的记录加起来告诉用户，不进任何计算（用户 2026-09-18）
  const h1 = { ...tx('h1', '2026-09-10', 'income', 300000, 'boc'), hidden: true }
  const h2 = { ...tx('h2', '2026-09-12', 'expense', 50000, 'boc'), hidden: true }
  const h3 = { ...tx('h3', '2026-09-13', 'transfer', 20000, 'boc'), to_account_id: 'wx', hidden: true }
  const shown = tx('s1', '2026-09-11', 'income', 100000, 'boc')
  const txs = [h1, h2, h3, shown]

  it('按账户汇总影响和笔数，转账两头都算，没藏过的账户不出现', () => {
    // 变异：count 只数 account_id → wx 没了，红；cents 改成 amount 直接相加 → boc 符号错，红
    const s = hiddenSummary(txs, ALL)
    expect(s.boc).toEqual({ cents: 300000 - 50000 - 20000, count: 3 })
    expect(s.wx).toEqual({ cents: 20000, count: 1 })
    expect(s.cmb).toBeUndefined()
    expect(hiddenSummary([shown], ALL)).toEqual({})
  })

  it('这个数正好是「里页面余额 − 外页面账本余额」（没有校准和外页面校准记录时），两边口径一致', () => {
    const inner = balances(txs, ALL)
    const outer = balances(outerBook(txs, ALL, [], 'outer'), ALL)
    expect(inner.boc - outer.boc).toBe(hiddenSummary(txs, ALL).boc.cents)
  })

  it('这行只在里页面出现：必须嵌在 showFacadeField（mode === inner）那一块里', () => {
    // 页面测不了，守源码。变异：把这行挪到 showFacadeField 那块外面 → 红
    const src = readFileSync(new URL('../pages/Accounts.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/const showFacadeField = mode === 'inner'/)
    // 找的是 JSX 里那一行（后面跟着 {hiddenSum），注释里提到这几个字不算
    const marker = '隐藏金额汇总 · {hiddenSum'
    const block = src.indexOf('{showFacadeField ? (')
    const line = src.indexOf(marker)
    const end = src.indexOf('\n        ) : null}', block) // showFacadeField 那块的收尾（8 格缩进）
    expect(block).toBeGreaterThan(0)
    expect(line).toBeGreaterThan(block)
    expect(line).toBeLessThan(end)
    expect(src.split(marker).length).toBe(2) // 只有这一处
    // 「外页面上次校准」那行同样只能在这块里
    const lf = src.indexOf('外页面上次校准 {fmtDateZh')
    expect(lf).toBeGreaterThan(block)
    expect(lf).toBeLessThan(end)
  })
})
