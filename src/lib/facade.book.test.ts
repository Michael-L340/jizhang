// 里外校准分家（2026-09-27）：外页面有自己的一本账 outerBook。
//
// 这里守四条：
//   一、迁移前后一个数都不变——老模型（固定差值整条平移）和新模型（迁移出来的记录）在随机账本上逐点相同；
//   二、外页面三条路径吃的是同一本账：账户页 ≡ 曲线末点 ≡ 列表之和 + 外页面校准合计；
//   三、外页面校准只从那天起算，以前的点一动不动（这是整个改法的目的）；
//   四、外页面校准不是收支，进不了收入/支出统计。
import { describe, expect, it } from 'vitest'
import { balanceSeries, balances, monthSummary } from './compute'
import { FACADE_EPOCH, facadeAsTx, facadeDelta, facadeIdFor, latestFacadeAdjust, migrateFacade, outerBook, outerList } from './facade'
import type { Account, FacadeAdjust, Transaction } from '../types'

const acc = (id: string, kind: Account['kind'], facade_offset: number | null = null): Account => ({
  id: `${id}00000-0000-4000-8000-000000000000`,
  name: id,
  kind,
  sort: 1,
  is_archived: false,
  repay_day: null,
  facade_offset,
  defer_after_repay: null,
})
const boc = acc('boc', 'bank', -216326) // 修饰过：真实 4163.26 → 外面 2000.00
const cmb = acc('cmb', 'bank') // 没修饰
const wx = acc('wx', 'wallet', 50000) // 修饰过，而且往多了修饰
const jd = acc('jd', 'credit', -500000) // 白条：数据里就算带着偏移量也不参与
const ALL = [boc, cmb, wx, jd]
const ASSETS = [boc, cmb, wx]

let txSeq = 0
const tx = (date: string, type: Transaction['type'], amount: number, account: Account, over: Partial<Transaction> = {}): Transaction => ({
  id: `${String(++txSeq).padStart(8, '0')}-0000-4000-8000-00000000${String(txSeq).padStart(4, '0')}`,
  date,
  type,
  amount,
  account_id: account.id,
  to_account_id: null,
  category_id: null,
  note: null,
  installments: null,
  settles: null,
  hidden: null, is_offset: null,
  created_at: `${date}T00:00:00.${String(txSeq).padStart(3, '0')}Z`,
  ...over,
})
const fa = (account: Account, date: string, cents: number, seq = 0): FacadeAdjust => ({
  id: `fa000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
  account_id: account.id,
  date,
  cents,
  created_at: `${date}T10:00:00.${String(seq).padStart(3, '0')}Z`,
})

// ── 老模型的参考实现：原样抄自 2026-09-27 之前的 facade.ts，删掉正式代码之后这份还在，等式才有意义 ──
const legacy = {
  offsetOf: (a: Account) => (a.kind === 'credit' ? 0 : a.facade_offset ?? 0),
  isDecorated: (a: Account) => a.kind !== 'credit' && a.facade_offset !== null,
  outerTxs: (txs: Transaction[]) => (txs.some((t) => t.hidden) ? txs.filter((t) => !t.hidden) : txs),
  visibleTxs(txs: Transaction[], accounts: Account[]): Transaction[] {
    const base = this.outerTxs(txs)
    const hidden = new Set(accounts.filter(this.isDecorated).map((a) => a.id))
    return base.filter((t) => !(t.type === 'adjust' && t.account_id !== null && hidden.has(t.account_id)))
  },
  adjustTotals(txs: Transaction[], accounts: Account[]): Record<string, number> {
    const out: Record<string, number> = {}
    for (const a of accounts) if (this.isDecorated(a)) out[a.id] = 0
    for (const t of txs) if (t.type === 'adjust' && t.account_id !== null && t.account_id in out) out[t.account_id] += t.amount
    return out
  },
  applyFacade(bal: Record<string, number>, accounts: Account[]): Record<string, number> {
    const out = { ...bal }
    for (const a of accounts) out[a.id] = (out[a.id] ?? 0) + this.offsetOf(a)
    return out
  },
  shiftSeries(series: { total: number[]; byAccount: Record<string, number[]> }, accounts: Account[], adjusts: Record<string, number>) {
    const byAccount: Record<string, number[]> = {}
    let shift = 0
    for (const a of accounts) {
      const d = this.offsetOf(a) + (adjusts[a.id] ?? 0)
      shift += d
      byAccount[a.id] = (series.byAccount[a.id] ?? []).map((v) => v + d)
    }
    return { total: series.total.map((v) => v + shift), byAccount }
  },
  balances: (txs: Transaction[], accounts: Account[]) => legacy.applyFacade(balances(legacy.outerTxs(txs), accounts), accounts),
  curve(txs: Transaction[], accounts: Account[], keys: string[], unit: 'day' | 'month') {
    return this.shiftSeries(balanceSeries(this.visibleTxs(txs, accounts), accounts, keys, unit), accounts, this.adjustTotals(this.outerTxs(txs), accounts))
  },
}

// ── 随机账本（固定种子 LCG，红了能复现） ──
function rng(seed: number) {
  let s = seed
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648
}
const day = (i: number): string => {
  const d = new Date(Date.UTC(2026, 7, 20 + i)) // 从 2026-08-20 起
  return d.toISOString().slice(0, 10)
}
function randomLedger(seed: number): Transaction[] {
  const rnd = rng(seed)
  const n = 20 + Math.floor(rnd() * 40)
  const out: Transaction[] = []
  for (let i = 0; i < n; i++) {
    const d = day(Math.floor(rnd() * 45))
    const a = ALL[Math.floor(rnd() * ALL.length)]
    const kind = rnd()
    let t: Transaction
    if (kind < 0.4) t = tx(d, 'expense', 100 + Math.floor(rnd() * 5000), a)
    else if (kind < 0.65) t = tx(d, 'income', 1000 + Math.floor(rnd() * 20000), a)
    else if (kind < 0.8) {
      const to = ALL[(ALL.indexOf(a) + 1 + Math.floor(rnd() * 3)) % ALL.length]
      t = tx(d, 'transfer', 500 + Math.floor(rnd() * 3000), a, { to_account_id: to.id })
    } else t = tx(d, 'adjust', Math.floor(rnd() * 8000) - 4000, a)
    // 藏一部分；涉及白条的记录不给藏（Entry.tsx 的规矩）
    const touchesCredit = a.kind === 'credit' || t.to_account_id === jd.id
    if (!touchesCredit && rnd() < 0.25) t = { ...t, hidden: true }
    out.push(t)
  }
  return out
}
const DAYS = Array.from({ length: 60 }, (_, i) => day(i - 8)) // 2026-08-12 … 2026-10-10，起点早于任何流水
const MONTHS = ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10']

describe('迁移：老模型（固定差值整条平移）→ 新模型（迁移出来的记录），一个数都不变', () => {
  it('随机账本 × 两种粒度：外页面余额和曲线逐点相同', () => {
    // 变异：migrateFacade 把藏掉的校准也算进合计 → 红；FACADE_EPOCH 改成 2026-09-01 → 早于它的点红；
    // outerBook 忘了摘非白条的真实校准 → 红
    for (let seed = 1; seed <= 150; seed++) {
      const txs = randomLedger(seed)
      const fadj = migrateFacade(ALL, txs)
      const book = outerBook(txs, ALL, fadj, 'outer')
      const got = balances(book, ALL)
      const want = legacy.balances(txs, ALL)
      for (const a of ALL) if (got[a.id] !== want[a.id]) expect.fail(`seed ${seed} ${a.name}：新 ${got[a.id]} ≠ 老 ${want[a.id]}`)
      for (const [keys, unit] of [[DAYS, 'day'], [MONTHS, 'month']] as const) {
        const n = balanceSeries(book, ASSETS, keys, unit)
        const o = legacy.curve(txs, ASSETS, keys, unit)
        if (n.total.join() !== o.total.join()) expect.fail(`seed ${seed} ${unit} 合计曲线不同\n新 ${n.total.join()}\n老 ${o.total.join()}`)
        for (const a of ASSETS) if (n.byAccount[a.id].join() !== o.byAccount[a.id].join()) expect.fail(`seed ${seed} ${unit} ${a.name} 曲线不同`)
      }
    }
  })

  it('修饰过的账户：一条记在 FACADE_EPOCH 的记录 = 偏移量 + 没藏掉的真实校准合计', () => {
    const txs = [
      tx('2026-09-07', 'adjust', 639100, boc),
      tx('2026-09-08', 'adjust', -100, boc, { hidden: true }), // 藏掉的不算
      tx('2026-09-09', 'adjust', 5000, jd), // 白条不参与
    ]
    const rows = migrateFacade([boc, jd], txs)
    expect(rows).toEqual([{ id: facadeIdFor('offset', boc.id), account_id: boc.id, date: FACADE_EPOCH, cents: -216326 + 639100, created_at: '2000-01-01T00:00:00.000Z' }])
  })

  it('没修饰的账户：每条没藏掉、不为 0 的真实校准配一条同日期同金额的孪生记录', () => {
    const a1 = tx('2026-09-03', 'adjust', -1084, cmb)
    const a2 = tx('2026-09-10', 'adjust', 0, cmb) // 0 元的不写
    const a3 = tx('2026-09-12', 'adjust', 700, cmb, { hidden: true }) // 藏掉的不写
    const rows = migrateFacade([cmb], [a1, a2, a3, tx('2026-09-05', 'expense', 100, cmb)])
    expect(rows).toEqual([{ id: facadeIdFor('twin', a1.id), account_id: cmb.id, date: '2026-09-03', cents: -1084, created_at: a1.created_at }])
  })

  it('偏移量和校准正好抵消（支付宝那种 −6,391 + 6,391）就不写记录，表里不留 0', () => {
    const ali = acc('ali', 'wallet', -639100)
    expect(migrateFacade([ali], [tx('2026-09-07', 'adjust', 639100, ali)])).toEqual([])
  })

  it('id 由来源 id 推出来：重复跑、合并导入老备份都是同一批 id；两种来源不会撞', () => {
    expect(facadeIdFor('twin', '12345678-0000-4000-8000-000000000001')).toBe('fa005678-0000-4000-8000-000000000001')
    expect(facadeIdFor('offset', '12345678-0000-4000-8000-000000000001')).toBe('fa015678-0000-4000-8000-000000000001')
    const txs = randomLedger(7)
    const a = migrateFacade(ALL, txs)
    const b = migrateFacade(ALL, txs)
    expect(a).toEqual(b)
    expect(new Set(a.map((r) => r.id)).size).toBe(a.length)
  })
})

describe('外页面那本账', () => {
  const txs = [
    tx('2026-09-01', 'expense', 2090, boc),
    tx('2026-09-07', 'adjust', 639100, boc), // 非白条的真实校准：外页面不算、不列
    tx('2026-09-07', 'adjust', -1084, cmb), // 没修饰过的也一样不算、不列（老模型是算的，孪生记录补回来）
    tx('2026-09-07', 'adjust', 5000, jd), // 白条照旧
    tx('2026-09-10', 'income', 100000, wx, { hidden: true }),
  ]
  const fadj = [fa(boc, '2026-09-20', -800000), fa(cmb, '2026-09-07', -1084)]

  it('里模式两个函数都原样返回同一个数组', () => {
    expect(outerBook(txs, ALL, fadj, 'inner')).toBe(txs)
    expect(outerList(txs, ALL, 'inner')).toBe(txs)
  })

  it('外模式：藏掉的和非白条真实校准都不在；账本比列表多的正好是外页面校准记录', () => {
    // 变异：stripForOuter 只摘修饰过的账户 → cmb 那条校准漏进列表，红
    const list = outerList(txs, ALL, 'outer').map((t) => t.id)
    expect(list).toEqual([txs[0].id, txs[3].id])
    const book = outerBook(txs, ALL, fadj, 'outer')
    expect(book.slice(0, 2).map((t) => t.id)).toEqual(list)
    expect(book.slice(2)).toEqual(fadj.map(facadeAsTx))
  })

  it('没什么可摘、也没有外页面校准时返回同一个数组，页面的 useMemo 不重算', () => {
    const plain = [tx('2026-09-01', 'expense', 100, boc), tx('2026-09-02', 'adjust', 5, jd)]
    expect(outerList(plain, ALL, 'outer')).toBe(plain)
    expect(outerBook(plain, ALL, [], 'outer')).toBe(plain)
  })

  it('外页面校准记录变成的流水是 adjust：进余额，不进收入/支出', () => {
    // 变异：facadeAsTx 的 type 写成 income → 收入统计多出 8,000，红
    const row = facadeAsTx(fa(boc, '2026-09-20', 800000))
    expect(row.type).toBe('adjust')
    expect(row.amount).toBe(800000)
    expect(row.account_id).toBe(boc.id)
    const book = outerBook(txs, ALL, [fa(boc, '2026-09-20', 800000)], 'outer')
    expect(monthSummary(book, '2026-09')).toEqual(monthSummary(outerList(txs, ALL, 'outer'), '2026-09'))
    expect(balances(book, ALL)[boc.id]).toBe(-2090 + 800000)
  })

  it('不变量：随机账本 + 随机外页面校准，随机挑一天问，账户页 ≡ 曲线末点 ≡ 列表之和 + 外页面校准合计', () => {
    // 三条路径（余额 / 曲线 / 列表）必须吃同一本账。变异：outerBook 不加外页面校准 → 红
    for (let seed = 200; seed < 260; seed++) {
      const rnd = rng(seed)
      const txs = randomLedger(seed)
      const fadj = [...migrateFacade(ALL, txs), ...Array.from({ length: 1 + Math.floor(rnd() * 4) }, (_, i) => fa(ASSETS[i % 3], day(Math.floor(rnd() * 45)), Math.floor(rnd() * 40000) - 20000, 100 + i))]
      for (const probe of [day(5), day(20), day(33), day(50)]) {
        const upTo = txs.filter((t) => t.date <= probe)
        const fUpTo = fadj.filter((f) => f.date <= probe)
        const shown = balances(outerBook(upTo, ALL, fUpTo, 'outer'), ALL) // 账户页
        const keys = DAYS.filter((d) => d <= probe)
        const curve = balanceSeries(outerBook(upTo, ALL, fUpTo, 'outer'), ASSETS, keys, 'day') // 统计页
        const listed = balances(outerList(upTo, ALL, 'outer'), ALL) // 流水页看得见的加起来
        for (const a of ASSETS) {
          const last = curve.byAccount[a.id][curve.byAccount[a.id].length - 1]
          if (shown[a.id] !== last) expect.fail(`seed ${seed} ${probe} ${a.name}：账户页 ${shown[a.id]} ≠ 曲线末点 ${last}`)
          const sum = fUpTo.filter((f) => f.account_id === a.id).reduce((s, f) => s + f.cents, 0)
          if (shown[a.id] !== listed[a.id] + sum) expect.fail(`seed ${seed} ${probe} ${a.name}：账户页 ${shown[a.id]} ≠ 列表之和 ${listed[a.id]} + 外校准 ${sum}`)
        }
        // 白条不分里外：外页面的白条余额 = 里页面的
        if (shown[jd.id] !== balances(upTo, ALL)[jd.id]) expect.fail(`seed ${seed} ${probe} 白条两边不一样`)
      }
    }
  })
})

describe('外页面校准只从那天起算，以前的点一动不动', () => {
  it('加一条记在 d 的记录：d 之前每个点不变，d 起每个点正好加 cents，合计线同理', () => {
    // 变异：facadeAsTx 的 date 写成 FACADE_EPOCH（等于回到整条平移）→ 红
    for (let seed = 300; seed < 340; seed++) {
      const rnd = rng(seed)
      const txs = randomLedger(seed)
      const base = migrateFacade(ALL, txs)
      const a = ASSETS[seed % 3]
      const d = day(10 + Math.floor(rnd() * 30))
      const cents = Math.floor(rnd() * 30000) - 15000 || 1
      const before = balanceSeries(outerBook(txs, ALL, base, 'outer'), ASSETS, DAYS, 'day')
      const after = balanceSeries(outerBook(txs, ALL, [...base, fa(a, d, cents, 9)], 'outer'), ASSETS, DAYS, 'day')
      DAYS.forEach((k, i) => {
        const delta = k < d ? 0 : cents
        if (after.byAccount[a.id][i] !== before.byAccount[a.id][i] + delta) expect.fail(`seed ${seed} ${k}：${a.name} 该${delta ? '加 ' + delta : '不动'}`)
        if (after.total[i] !== before.total[i] + delta) expect.fail(`seed ${seed} ${k}：合计该${delta ? '加 ' + delta : '不动'}`)
        for (const o of ASSETS) if (o !== a && after.byAccount[o.id][i] !== before.byAccount[o.id][i]) expect.fail(`seed ${seed} ${k}：别的账户 ${o.name} 动了`)
      })
    }
  })

  it('该记多少 = 你填的对外显示 − 外页面现在显示的数', () => {
    expect(facadeDelta(200000, 1000000)).toBe(-800000)
    expect(facadeDelta(1000000, 1000000)).toBe(0)
    expect(facadeDelta(1200000, 1000000)).toBe(200000)
  })
})

describe('「外页面上次校准」', () => {
  it('按账户取最近一次：先比日期，同一天比记录时间；迁移出来的 EPOCH 那条不算', () => {
    // 变异：不跳过 EPOCH → boc 显示 2000-01-01，红；只比 created_at → 反而选中 9/20 那条晚录的，红
    const rows = [
      { ...fa(boc, FACADE_EPOCH, 400000, 1), created_at: '2026-09-30T00:00:00.000Z' },
      fa(boc, '2026-09-20', -100, 2),
      fa(boc, '2026-09-27', -800000, 3),
      { ...fa(boc, '2026-09-27', 500, 4), created_at: '2026-09-27T09:00:00.000Z' }, // 同一天但更早录的
      fa(wx, '2026-09-25', 100, 5),
    ]
    const m = latestFacadeAdjust(rows)
    expect(m.get(boc.id)?.cents).toBe(-800000)
    expect(m.get(wx.id)?.date).toBe('2026-09-25')
    expect(m.get(cmb.id)).toBeUndefined()
    expect(latestFacadeAdjust([rows[0]]).size).toBe(0)
  })
})
