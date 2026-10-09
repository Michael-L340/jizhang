// 补记延迟。输入一律是「用户哪天花的钱、什么时候打开 App 记上的，打开卡片看到什么」。
// 每条用例都先把实现改坏跑过一次，确认它会红（注释里的「变异：… → 红」）。
import { describe, expect, it } from 'vitest'
import type { Transaction } from '../../types'
import { addDays, today } from '../date'
import { delay, delayStats, fmtDelay, IMPORT_BATCH } from './delay'
import { pointMode } from './registry'
import type { MoreChart, MoreInput } from './types'

let seq = 0
/** 记在 date 那天的一笔，录入时刻 createdAt（UTC ISO） */
function tx(date: string, createdAt: string, over: Partial<Transaction> = {}): Transaction {
  seq++
  return {
    id: `d${seq}`, date, type: 'expense', amount: 1000, account_id: 'wx', to_account_id: null, category_id: null,
    note: null, installments: null, settles: null, hidden: null, is_offset: null, created_at: createdAt, ...over,
  }
}
/** 北京时间 date 那天 hh:mm 的 UTC ISO 串（北京 = UTC+8） */
function bj(date: string, hh: number, mm = 0): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, hh - 8, mm)).toISOString()
}
const inputOf = (txs: Transaction[], start = '2026-09-01', end = '2026-09-28'): MoreInput => ({
  txs, accounts: [], cats: [], ym: '2026-09', start, end, today: '2026-09-28',
})
const tiles = (c: MoreChart) => Object.fromEntries((c.tiles ?? []).map((t) => [t.label, t.value]))

/**
 * 9 月的几笔：
 *   9/7 午饭，12:30 当场记（半小时）；9/7 早饭，08:00 当场记（中午之前 → 0）；
 *   9/5 晚饭，9/6 21:00 才记（33 小时，隔天）；9/1 买菜，9/4 中午才记（72 小时，拖过一天）；
 *   9/10 工资，13:00 记（1 小时）；9/20 的房租，9/15 就提前记上了（预记，不算）；
 *   还白条、校准拖了十天才记（不是收支，不算）。
 */
const BOOK: Transaction[] = [
  tx('2026-09-07', bj('2026-09-07', 12, 30)),
  tx('2026-09-07', bj('2026-09-07', 8)),
  tx('2026-09-05', bj('2026-09-06', 21)),
  tx('2026-09-01', bj('2026-09-04', 12)),
  tx('2026-09-10', bj('2026-09-10', 13), { type: 'income' }),
  tx('2026-09-20', bj('2026-09-15', 9)),
  tx('2026-09-02', bj('2026-09-12', 9), { type: 'transfer', to_account_id: 'jd' }),
  tx('2026-09-03', bj('2026-09-13', 9), { type: 'adjust' }),
]

describe('补记延迟：打开看到什么', () => {
  it('9 月：五笔算数（半小时、0、33、72、1 小时）→ 平均 21.3 小时；当天记的 3/5 = 60%；拖过一天的只有 9/1 那笔', () => {
    // 变异：中午写成 UTC 12 点（`Date.UTC(y, m - 1, d, 12)`，差 8 小时）→ 平均少了一截，红
    // 变异：去掉 Math.max(0, …)（早上 8 点记的算成 -4 小时）→ 红
    // 变异：「拖过一天」写成隔天就算（daysBetween ≥ 1）→ 9/5 那笔也算，2 笔，红
    // 变异：收支判断换成 `t.type !== 'adjust'`（转账也算）→ 红
    const c = delay(inputOf(BOOK))
    expect(c.key).toBe('delay')
    expect(c.title).toBe('补记延迟')
    expect(c.span).toBe('26.9')
    expect(c.option).toBeNull()
    expect(c.empty).toBeUndefined()
    expect(c.tiles).toEqual([
      { label: '平均延迟', value: '21.3 小时' },
      { label: '当天记的', value: '60%' },
      { label: '拖过一天的', value: '1 笔' },
    ])
  })

  it('提前记的（9/20 的房租 9/15 就记上）不算延迟，也不当「当天记的」；只有预记的时候说清楚为什么算不出', () => {
    // 变异：去掉 `at.date < t.date` 那条（预记也收，延迟按 0 算）→ 6 笔、当天记的 50%，红
    const s = delayStats(BOOK, '2026-09-01', '2026-09-28')
    expect(s.n).toBe(5)
    expect(s.skipped).toBe(1)
    const only = delay(inputOf([tx('2026-09-20', bj('2026-09-15', 9)), tx('2026-09-25', bj('2026-09-01', 9))]))
    expect(only.tiles).toBeUndefined()
    expect(only.empty).toBe('这段时间的记录都是提前记的，算不出延迟')
  })

  it('按北京时间认日子：9/8 凌晨 0:30（UTC 还是 9/7）记 9/8 的宵夜 = 当天记的；9/7 的账 9/8 凌晨 4 点（UTC 还是 9/7）才记 = 隔天', () => {
    // 变异：录入日直接取 created_at.slice(0, 10)（UTC 日期）→ 宵夜成了「提前记的」、隔天那笔成了当天，红
    const snack = tx('2026-09-08', '2026-09-07T16:30:00.000Z')
    const late = tx('2026-09-07', '2026-09-07T20:00:00.000Z')
    const s = delayStats([snack, late], '2026-09-01', '2026-09-28')
    expect(s.n).toBe(2)
    expect(s.sameDay).toBe(1)
    // 宵夜：中午之前 → 0；隔天那笔：9/7 12:00 → 9/8 04:00 = 16 小时
    expect(s.meanHours).toBe(8)
    expect(tiles(delay(inputOf([snack, late])))['当天记的']).toBe('50%')
  })

  it('一周的账周末一口气补：平均 3 天 → 写成「3.0 天」，不写「72.0 小时」', () => {
    // 变异：fmtDelay 去掉换成天的那一支 → 「72.0 小时」，红
    const txs = ['2026-09-01', '2026-09-02', '2026-09-03'].map((d) => tx(d, bj(addDays(d, 3), 12)))
    expect(tiles(delay(inputOf(txs)))['平均延迟']).toBe('3.0 天')
    expect(tiles(delay(inputOf(txs)))['拖过一天的']).toBe('3 笔')
  })

  it('拖过一天的边界：9/1 的账 9/3 零点 05 分才记 → 算拖过一天；9/2 夜里 23:59 记 → 隔天，不算', () => {
    // 按北京日期数「隔了几天」，不按小时：9/2 23:59 离 9/1 中午已经 36 小时了，但还是隔天。
    // 变异：「拖过一天」按小时算（延迟 ≥ 48 小时）→ 9/3 00:05 只隔了 36 小时 5 分，不算，红
    // 变异：写成 daysBetween ≥ 3 → 9/3 那笔不算，红
    const on3 = delayStats([tx('2026-09-01', bj('2026-09-03', 0, 5))], '2026-09-01', '2026-09-28')
    expect(on3.late).toBe(1)
    expect(on3.sameDay).toBe(0)
    const on2 = delayStats([tx('2026-09-01', bj('2026-09-02', 23, 59))], '2026-09-01', '2026-09-28')
    expect(on2.late).toBe(0)
    expect(on2.n).toBe(1)
  })

  it('小时和天的分界：47.9 小时照写小时；47.96 小时显示出来是 48.0，按天写「2.0 天」；正好 48 小时写「2.0 天」', () => {
    // 变异：分界拿没四舍五入的小时比（`hours >= 48`）→ 47.96 写成「48.0 小时」，红
    // 变异：`>=` 写成 `>` → 正好 48 写成「48.0 小时」，红
    expect(fmtDelay(0)).toBe('0.0 小时')
    expect(fmtDelay(47.9)).toBe('47.9 小时')
    expect(fmtDelay(47.96)).toBe('2.0 天')
    expect(fmtDelay(48)).toBe('2.0 天')
    expect(fmtDelay(60)).toBe('2.5 天')
  })

  it('范围两端当天的算，范围外的不算', () => {
    // 变异：`t.date > end` 写成 `t.date >= end` → 9/28 那笔丢了，红
    const txs = [
      tx('2026-08-31', bj('2026-09-10', 12)),
      tx('2026-09-01', bj('2026-09-01', 12)),
      tx('2026-09-28', bj('2026-09-28', 14)),
      tx('2026-09-29', bj('2026-09-29', 12)),
    ]
    const s = delayStats(txs, '2026-09-01', '2026-09-28')
    expect(s.n).toBe(2)
    expect(s.meanHours).toBe(1)
  })

  it('录入时刻坏了（空串）的那笔跳过，不把平均数算成 NaN', () => {
    // 变异：去掉 `!at ||` → 读 null 的 date，抛错，红
    const c = delay(inputOf([tx('2026-09-02', ''), tx('2026-09-03', bj('2026-09-03', 18))]))
    expect(tiles(c)['平均延迟']).toBe('6.0 小时')
  })

  it('什么都没记 → 一句话；这张卡本来就不画图，也不接点击', () => {
    // 变异：空状态那条 return 带上 option: {} → 不再是「只有数字的卡」，红
    const c = delay(inputOf([]))
    expect(c.option).toBeNull()
    expect(c.empty).toBe('这段时间没有收支记录')
    expect(c.span).toBe('26.9')
    expect(c.note.endsWith('。')).toBe(true)
    expect(pointMode(delay(inputOf(BOOK)))).toBeNull()
  })
})

describe('补记延迟：整批导入的不算', () => {
  /** 一分钟里导进 n 笔：账上日期从 from 起每隔 step 天一笔，created_at 都在 at 那一分钟里（秒数各不相同） */
  function batch(n: number, from: string, step: number, at: string, over: Partial<Transaction> = {}): Transaction[] {
    const t0 = Date.parse(at)
    return Array.from({ length: n }, (_, i) => tx(addDays(from, i * step), new Date(t0 + i * 1500).toISOString(), over))
  }

  it('从 Excel 导进来的历史账（9/2 上午 10 点那一分钟导进 30 笔，账上日期 25.10 起每 10 天一笔）+ 9 月自己记的：只算自己记的，说明里写「整批导入的 N 笔不算」', () => {
    // 不排除的话，导入的那 30 笔延迟全是几个月，「平均延迟」成了几十天、「拖过一天的」三十多笔。
    // 变异：去掉导入那一关（不看 importMinutes）→ 35 笔、平均几十天，红
    const imported = batch(30, '2025-10-01', 10, bj('2026-09-02', 10))
    const c = delay(inputOf([...BOOK, ...imported], '2025-10-01', '2026-09-28'))
    expect(tiles(c)).toEqual({ 平均延迟: '21.3 小时', 当天记的: '60%', 拖过一天的: '1 笔' })
    // 导入那 30 笔的账上日期是 25/10/1 … 26/7/18，全在近一年里
    expect(c.note).toContain('整批导入的 30 笔不算')
    expect(c.note.endsWith('。')).toBe(true)
    // 没有导入的时候不提这一句
    expect(delay(inputOf(BOOK)).note).not.toContain('导入')
  })

  it('一分钟里 19 笔照算、20 笔算导入；正常一天记 5 笔（哪怕是一口气在同一分钟里记的）照算', () => {
    // 变异：阈值 `>= IMPORT_BATCH` 写成 `>` → 20 笔那份照算，红
    // 变异：阈值写成 5 → 一口气记的 5 笔被当成导入，红
    expect(IMPORT_BATCH).toBe(20)
    const at = bj('2026-09-20', 21)
    const s19 = delayStats(batch(19, '2026-09-10', 0, at), '2026-09-01', '2026-09-28')
    expect([s19.n, s19.imported]).toEqual([19, 0])
    const s20 = delayStats(batch(20, '2026-09-10', 0, at), '2026-09-01', '2026-09-28')
    expect([s20.n, s20.imported]).toEqual([0, 20])
    const five = delayStats(batch(5, '2026-09-20', 0, at), '2026-09-01', '2026-09-28')
    expect([five.n, five.imported, five.sameDay]).toEqual([5, 0, 5])
  })

  it('一分钟 30 笔，但只看 9 月（只有 3 笔的账上日期在 9 月）→ 这 3 笔也算导入：数的是整本账那一分钟有几笔，不是这段时间里的', () => {
    // 变异：只数这段时间里的收支（范围过滤之后再按分钟数）→ 9 月只有 3 笔，到不了 20，照算，红
    const imported = batch(30, '2026-06-01', 4, bj('2026-09-02', 10)) // 6/1 起每 4 天一笔，最后三笔 9/2、9/6……
    const inSep = imported.filter((t) => t.date >= '2026-09-01' && t.date <= '2026-09-28').length
    expect(inSep).toBeGreaterThan(0)
    expect(inSep).toBeLessThan(IMPORT_BATCH)
    const s = delayStats([...BOOK, ...imported], '2026-09-01', '2026-09-28')
    expect(s.imported).toBe(inSep)
    expect(s.n).toBe(5)
  })

  it('那一分钟里导进来的还有转账、校准：18 笔收支 + 2 笔转账也是 20 笔，算导入', () => {
    // 变异：只数收支（isFlow 过滤之后再按分钟数）→ 18 笔，照算，红
    const at = bj('2026-09-02', 10)
    const txs = [...batch(18, '2026-09-01', 1, at), ...batch(2, '2026-09-01', 1, new Date(Date.parse(at) + 30_000).toISOString(), { type: 'transfer', to_account_id: 'jd' })]
    const s = delayStats(txs, '2026-09-01', '2026-09-28')
    expect([s.n, s.imported]).toEqual([0, 18])
    const c = delay(inputOf(txs))
    expect(c.empty).toBe('这段时间的记录都是整批导入的，算不出延迟')
    expect(c.tiles).toBeUndefined()
  })
})

describe('补记延迟：不变量', () => {
  function rng(seed: number) {
    let s = seed >>> 0
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
  }

  it('随机账本（有的夹着一批导入）：算进来的 + 跳过的 + 导入的 ≡ 范围内的收支笔数；平均延迟、当天记的、拖过一天的 ≡ 用 date.ts 的 today()（Intl 按 Asia/Shanghai）另算一遍的结果', () => {
    // 另算那一遍不用 weekhour.bjDateHour，用 Intl：两套北京时间换算互相对账；「隔了几天」用毫秒差自己数，不用 daysBetween；
    // 哪一分钟是导入按 ISO 串的前 16 位（到分钟）数，不用实现里的 Math.floor(ms / 60000)
    // 变异：「拖过一天」写成 daysBetween ≥ 1 → 隔天记的也算，红
    // 变异：导入那一关只数收支 → 夹着转账的那几批漏网，红
    // 变异：delay.ts 的中午写成 `12 - 7`（差一小时）→ 平均数对不上，红
    // 变异：预记那笔跳过时不累加 skipped → 等式断，红
    const TYPES = ['expense', 'expense', 'income', 'transfer', 'adjust'] as const
    let batches = 0
    for (let k = 0; k < 300; k++) {
      const r = rng(k + 3)
      const txs: Transaction[] = []
      for (let i = 0; i < 40; i++) {
        const date = addDays('2026-08-01', Math.floor(r() * 60))
        // 录入：提前 0–3 天到推后 0–6 天，钟点随机到分钟
        const lag = Math.floor(r() * 10) - 3
        const [y, m, d] = date.split('-').map(Number)
        const ms = Date.UTC(y, m - 1, d + lag, -8) + Math.floor(r() * 1440) * 60_000
        txs.push(tx(date, new Date(ms).toISOString(), { type: TYPES[Math.floor(r() * TYPES.length)] }))
      }
      // 三份里大约一份夹着一批导入：15–30 笔挤在同一分钟（有的够 20、有的不够），类型、账上日期随机
      if (r() < 0.35) {
        const at = Date.UTC(2026, 8, 1 + Math.floor(r() * 20), Math.floor(r() * 24), Math.floor(r() * 60))
        const m = 15 + Math.floor(r() * 16)
        for (let i = 0; i < m; i++) txs.push(tx(addDays('2026-07-01', Math.floor(r() * 90)), new Date(at + Math.floor(r() * 60_000)).toISOString(), { type: TYPES[Math.floor(r() * TYPES.length)] }))
      }
      const perMinute = new Map<string, number>()
      for (const t of txs) perMinute.set(t.created_at.slice(0, 16), (perMinute.get(t.created_at.slice(0, 16)) ?? 0) + 1)
      const isImported = (t: Transaction) => (perMinute.get(t.created_at.slice(0, 16)) ?? 0) >= 20
      const start = addDays('2026-08-01', Math.floor(r() * 20))
      const end = addDays(start, Math.floor(r() * 40))
      const s = delayStats(txs, start, end)
      const inRange = txs.filter((t) => (t.type === 'expense' || t.type === 'income') && t.date >= start && t.date <= end)
      if (s.n + s.skipped + s.imported !== inRange.length) expect.fail(`第 ${k} 份：${s.n} + ${s.skipped} + ${s.imported} ≠ ${inRange.length}`)
      let n = 0
      let sum = 0
      let same = 0
      let late = 0
      let imp = 0
      for (const t of inRange) {
        if (isImported(t)) {
          imp++
          continue
        }
        const ms = Date.parse(t.created_at)
        const day = today(new Date(ms))
        if (day < t.date) continue
        n++
        if (day === t.date) same++
        if ((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${t.date}T00:00:00Z`)) / 86_400_000 >= 2) late++
        sum += Math.max(0, ms - Date.parse(`${t.date}T12:00:00+08:00`))
      }
      if (s.imported !== imp) expect.fail(`第 ${k} 份：导入 ${s.imported} ≠ ${imp}`)
      if (s.n !== n || s.sameDay !== same || s.late !== late) expect.fail(`第 ${k} 份：笔数 / 当天 / 拖过一天 ${s.n}/${s.sameDay}/${s.late} ≠ ${n}/${same}/${late}`)
      const want = n ? sum / n / 3600_000 : null
      if (want === null ? s.meanHours !== null : Math.abs((s.meanHours ?? NaN) - want) > 1e-9) expect.fail(`第 ${k} 份：平均 ${s.meanHours} ≠ ${want}`)
      if (s.late > s.n - s.sameDay) expect.fail(`第 ${k} 份：拖过一天的比不是当天记的还多`)
      if (imp) batches++
    }
    // 真的撞到过导入（不然上面那几条导入的等式是空转）
    expect(batches).toBeGreaterThan(30)
  })
})
