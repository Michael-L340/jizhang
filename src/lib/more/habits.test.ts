import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Account, FacadeAdjust, Transaction } from '../../types'
import { addDays, daysBetween, monthRange } from '../date'
import { outerBook, outerList } from '../facade'
import { habits, perDay, streakDays, zeroSpendDays } from './habits'
import type { MoreInput } from './types'

let seq = 0
function tx(date: string, type: Transaction['type'] = 'expense', amount = 1000): Transaction {
  seq++
  return {
    id: `b${seq}`,
    date,
    type,
    amount,
    account_id: 'wx',
    to_account_id: type === 'transfer' ? 'boc' : null,
    category_id: null,
    note: null,
    installments: null,
    settles: null,
    hidden: null, is_offset: null,
    created_at: new Date(Date.UTC(2026, 8, 1, 0, 0, seq)).toISOString(),
  }
}

function input(txs: Transaction[], over: Partial<MoreInput> = {}): MoreInput {
  return { txs, accounts: [], cats: [], ym: '2026-09', start: '2026-09-01', end: '2026-09-28', today: '2026-09-28', ...over }
}

const tile = (txs: Transaction[], label: string, over: Partial<MoreInput> = {}) =>
  habits(input(txs, over)).tiles!.find((t) => t.label === label)?.value

describe('habits：打开「记账习惯」看到什么', () => {
  it('今天 9/28，26、27、28 都记了、25 号断过 → 连续 3 天', () => {
    // 变异：遇到断档不停（改成数「今天及以前所有记过的天」）→ 5 天 → 红
    const txs = [tx('2026-09-28'), tx('2026-09-27', 'income'), tx('2026-09-26'), tx('2026-09-24'), tx('2026-09-23')]
    expect(tile(txs, '连续记账')).toBe('3 天')
  })

  it('早上打开、今天还没记：从昨天往前数，不显示 0', () => {
    // 变异：去掉「今天没记就从昨天数」（永远从 today 起）→ 显示 0 天 → 红
    // 变异：while 里 `d = addDays(d, -1)` 写成 -2 → 跳着数，9/26 之后跳到 9/24 断掉 → 红
    const txs = [tx('2026-09-27'), tx('2026-09-26'), tx('2026-09-25')]
    expect(tile(txs, '连续记账')).toBe('3 天')
  })

  it('昨天今天都没记 → 0 天；9/30 提前录的那笔不算今天', () => {
    // 变异：「今天没记」时一路往前找最近记过的那天再数（跳过 9/27 的空档）→ 2 天 → 红
    expect(tile([tx('2026-09-26'), tx('2026-09-25'), tx('2026-09-30')], '连续记账')).toBe('0 天')
    expect(streakDays([tx('2026-09-29')], '2026-09-28')).toBe(0)
  })

  it('哪天只记了一笔转账，也算那天记过账；只做了一次校准的那天不算（校准是核对，不是记账）', () => {
    // 变异：streakDays 只收 isFlow 的记录 → 9/27 只有转账那天断掉，变成 1 天 → 红
    // 变异：streakDays 不看类型、校准也算（改前的写法）→ 9/25 那次校准把连续接上，5 天 → 红
    const txs = [tx('2026-09-28'), tx('2026-09-27', 'transfer'), tx('2026-09-26', 'income'), tx('2026-09-25', 'adjust'), tx('2026-09-24')]
    expect(tile(txs, '连续记账')).toBe('3 天')
  })

  it('外页面：9/26、9/28 各一笔支出，9/27 只在外页面点过一次「校准」→ 连续 1 天，和外页面流水、里页面一致', () => {
    // 外页面那本账里，外页面校准记录是 type=adjust 的流水；外页面流水列表（outerList）从来不列它。
    // 变异：streakDays 不看类型（改前的写法）→ 外页面算成 3 天、流水里 9/27 却是空的 → 红
    const wx: Account = { id: 'wx', name: '微信', kind: 'wallet', sort: 1, is_archived: false, repay_day: null, defer_after_repay: null, facade_offset: null }
    const raw = [tx('2026-09-26'), tx('2026-09-28')]
    const fadj: FacadeAdjust[] = [{ id: 'f1', account_id: 'wx', date: '2026-09-27', cents: 5000, created_at: '2026-09-27T02:00:00.000Z' }]
    const outer = outerBook(raw, [wx], fadj, 'outer')
    expect(outer.some((t) => t.date === '2026-09-27')).toBe(true) // 账本里确实有这一条
    expect(outerList(raw, [wx], 'outer').map((t) => t.date).sort()).toEqual(['2026-09-26', '2026-09-28'])
    expect(tile(outer, '连续记账')).toBe('1 天')
    expect(tile(outerBook(raw, [wx], fadj, 'inner'), '连续记账')).toBe('1 天')
  })

  it('9/1–9/10 记了 23 笔收支、外加 5 笔转账 → 平均每天 2.3 笔（转账校准不算）', () => {
    // 变异：perDay 改成数全部类型 → 2.8 笔 → 红
    const txs: Transaction[] = []
    for (let i = 0; i < 23; i++) txs.push(tx(`2026-09-${String(1 + (i % 10)).padStart(2, '0')}`, i % 4 === 0 ? 'income' : 'expense'))
    for (let i = 0; i < 4; i++) txs.push(tx('2026-09-05', 'transfer'))
    txs.push(tx('2026-09-06', 'adjust'))
    txs.push(tx('2026-08-31')) // 范围外
    expect(tile(txs, '平均每天', { start: '2026-09-01', end: '2026-09-10' })).toBe('2.3 笔')
  })

  it('范围的尾巴超过今天：只除到今天（今天 9/10，选 9/1–9/30，记了 20 笔 → 2.0 笔，不是 0.7）', () => {
    // 变异：去掉「end 截到 today」→ 除以 30 → 0.7 笔 → 红
    const txs = Array.from({ length: 20 }, (_, i) => tx(`2026-09-${String(1 + (i % 10)).padStart(2, '0')}`))
    expect(tile(txs, '平均每天', { start: '2026-09-01', end: '2026-09-30', today: '2026-09-10' })).toBe('2.0 笔')
  })

  it('整段范围都在未来 → 平均每天显示「—」', () => {
    // 变异：去掉 perDay 的 `if (days <= 0) return null` → 天数是负的，显示「0.0 笔」→ 红
    expect(perDay([], '2026-10-01', '2026-10-31', '2026-09-28')).toBeNull()
    expect(tile([], '平均每天', { start: '2026-10-01', end: '2026-10-31' })).toBe('—')
  })

  it('本月（今天 9/10，8 月就开始记账了）：2 号花了两笔、5 号一笔、3 号只有收入 → 零支出 8 天', () => {
    // 变异：zeroSpendDays 把收入也当花钱 → 7 天 → 红
    // 变异：一直数到月底不截到今天 → 28 天 → 红
    const txs = [tx('2026-08-20'), tx('2026-09-02'), tx('2026-09-02'), tx('2026-09-05'), tx('2026-09-03', 'income'), tx('2026-09-04', 'transfer'), tx('2026-09-20')]
    expect(tile(txs, '本月零支出', { today: '2026-09-10' })).toBe('8 天')
  })

  it('选的是 8 月（已经过完）：整月 31 天里减掉有支出的天，标签写「8月零支出」不写「本月」', () => {
    // 变异：标签永远写「本月零支出」→ 找不到「8月零支出」→ 红
    const txs = [tx('2026-08-01'), tx('2026-08-15'), tx('2026-08-31'), tx('2026-09-01')]
    expect(tile(txs, '8月零支出', { ym: '2026-08' })).toBe('28 天')
    expect(tile(txs, '本月零支出', { ym: '2026-08' })).toBeUndefined()
  })

  it('这个月中途才开始记账：9/20 记第一笔、今天 9/28 → 零支出只数 9/20 以后的（7 天），不是 26 天', () => {
    // 9/1 那次校准不算「开始记账」（外页面那本账里还有记在 2000-01-01 的外页面校准记录，同理）
    // 变异：起点永远是月初（去掉「开始记账那天」）→ 26 天 → 红
    // 变异：「开始记账」把校准也算上 → 从 9/1 起数，26 天 → 红
    const txs = [tx('2026-09-01', 'adjust'), tx('2026-09-20'), tx('2026-09-22'), tx('2026-09-25', 'income')]
    expect(zeroSpendDays(txs, '2026-09', '2026-09-28')).toEqual({ days: 7, of: 9 })
    expect(tile(txs, '本月零支出')).toBe('7 天')
    // 开始记账之前的月份：没法说零支出，显示「—」
    expect(tile(txs, '8月零支出', { ym: '2026-08' })).toBe('—')
  })

  it('选的月份还没到 → 零支出显示「—」', () => {
    // 变异：去掉 zeroSpendDays 的 `last < start` 那条 → of = -2，显示「-2 天」→ 红
    expect(tile([tx('2026-09-01')], '10月零支出', { ym: '2026-10' })).toBe('—')
    expect(tile([], '10月零支出', { ym: '2026-10' })).toBe('—')
  })

  it('这张卡不画图，只有三块数字；标题旁写着「平均每天」按的那段时间', () => {
    // 变异：habits 返回里加一个 option: {} → 红；span 写成 ym 的月份（26.9）→ 红
    const c = habits(input([], { start: '2025-10-01' }))
    expect(c.span).toBe('25.10–26.9')
    expect(c.key).toBe('habits')
    expect(c.title).toBe('记账习惯')
    expect(c.option).toBeNull()
    expect(c.empty).toBeUndefined()
    expect(c.tiles!.map((t) => t.label)).toEqual(['连续记账', '平均每天', '本月零支出'])
  })
})

describe('habits：不变量', () => {
  function rng(seed: number) {
    let s = seed >>> 0
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      return s / 2 ** 32
    }
  }
  const types: Transaction['type'][] = ['expense', 'expense', 'income', 'transfer', 'adjust']
  const randomBook = (r: () => number) => {
    const txs: Transaction[] = []
    const n = Math.floor(r() * 50)
    for (let i = 0; i < n; i++) txs.push(tx(addDays('2026-08-15', Math.floor(r() * 50)), types[Math.floor(r() * types.length)]))
    return txs
  }

  it('随机账本 × 随机今天：零支出天数 + 有支出的天数 ≡ 这个月（从开始记账那天起）到今天为止的天数', () => {
    // 变异：spent 集合不按日期去重（改成计数）→ 同一天两笔支出多减一天 → 红
    // 变异：起点不跟「开始记账那天」→ 账本从 8 月中旬才开始、看 8 月的那些份对不上 → 红
    for (let k = 0; k < 300; k++) {
      const r = rng(k + 3)
      const txs = randomBook(r)
      const todayStr = addDays('2026-08-20', Math.floor(r() * 40))
      const ym = r() < 0.5 ? '2026-08' : '2026-09'
      const { start: monthStart, end } = monthRange(ym)
      const recs = txs.filter((t) => t.type !== 'adjust').map((t) => t.date).sort()
      const start = recs.length && recs[0] > monthStart ? recs[0] : monthStart
      const last = end < todayStr ? end : todayStr
      const z = zeroSpendDays(txs, ym, todayStr)
      if (!recs.length || last < start) {
        if (z.of !== 0) expect.fail(`第 ${k} 份：月份未到却算了 ${z.of} 天`)
        continue
      }
      const spentDays = new Set(txs.filter((t) => t.type === 'expense' && t.date >= start && t.date <= last).map((t) => t.date)).size
      if (z.days + spentDays !== daysBetween(start, last) + 1) expect.fail(`第 ${k} 份：${z.days} + ${spentDays} ≠ 天数`)
    }
  })

  it('随机账本：连续 N 天 ⇔ 那 N 天每天都有记录（校准不算）、再往前一天没有', () => {
    // 变异：去掉「今天没记从昨天数」→ 今天没记的账本全部断言失败 → 红
    // 变异：streakDays 把校准也算上 → 只有校准的那天被算进连续 → 红
    for (let k = 0; k < 300; k++) {
      const r = rng(k + 11)
      const txs = randomBook(r)
      const todayStr = addDays('2026-08-15', Math.floor(r() * 50))
      // 校准不算记账
      const days = new Set(txs.filter((t) => t.type !== 'adjust').map((t) => t.date))
      const n = streakDays(txs, todayStr)
      const from = days.has(todayStr) ? todayStr : addDays(todayStr, -1)
      for (let i = 0; i < n; i++) if (!days.has(addDays(from, -i))) expect.fail(`第 ${k} 份：第 ${i} 天没记却算进了连续`)
      if (days.has(addDays(from, -n))) expect.fail(`第 ${k} 份：连续 ${n} 天之前那天也记了，少数了`)
    }
  })
})

describe('habits：守规矩', () => {
  const src = readFileSync(new URL('./habits.ts', import.meta.url), 'utf8')
  it('不看 hidden、不碰 store / api', () => {
    // 变异：streakDays 的循环里加一行 `if (t.hidden) continue` → 红；import { useStore } from '../store' → 红
    expect(src).not.toMatch(/\bhidden\b/)
    expect(src).not.toMatch(/from '\.\.\/(store|api|supabase|facade)'/)
  })
})
