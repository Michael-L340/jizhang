import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Transaction } from '../../types'
import { fmtIsoTimeZh, today } from '../date'
import { CHART } from '../palette'
import type { MoreInput } from './types'
import { bjDateHour, SLOTS, slotOf, weekhour, weekHourGrid, WEEKDAYS } from './weekhour'

let seq = 0
/** 一笔支出：记在 date 那天，录入时刻 created_at（UTC ISO） */
function tx(date: string, amount: number, createdAt: string, over: Partial<Transaction> = {}): Transaction {
  seq++
  return {
    id: `w${seq}`,
    date,
    type: 'expense',
    amount,
    account_id: 'wx',
    to_account_id: null,
    category_id: null,
    note: null,
    installments: null,
    settles: null,
    hidden: null, is_offset: null,
    created_at: createdAt,
    ...over,
  }
}

/** 北京时间 date 那天 hh:mm 的 UTC ISO 串（北京 = UTC+8） */
function bj(date: string, hh: number, mm = 0): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, hh - 8, mm)).toISOString()
}

function input(txs: Transaction[], start = '2026-09-01', end = '2026-09-30'): MoreInput {
  return { txs, accounts: [], cats: [], ym: '2026-09', start, end, today: '2026-09-28' }
}

type Series = { data: [number, number, number][] }
const seriesOf = (o: object | null) => ((o as { series: Series[] }).series[0])

describe('weekhour：打开「什么时候最爱花钱」看到什么', () => {
  it('周一早上 7:40 在食堂吃了 12 块、当场记 → 亮的是「周一 · 早」那一格', () => {
    // 北京 9/7（周一）07:40 = UTC 9/6 23:40：UTC 日期是前一天、UTC 小时是 23 点
    // 变异：bjDateHour 不加 8 小时 → 录入日算成 9/6 ≠ 9/7，被当补记扔掉，整张图变 empty → 红
    const t = tx('2026-09-07', 1200, '2026-09-06T23:40:00.000Z')
    const g = weekHourGrid([t], '2026-09-01', '2026-09-30')
    expect(g.cents[0][0]).toBe(1200)
    expect(g.total).toBe(1200)
    const c = weekhour(input([t]))
    expect(c.empty).toBeUndefined()
    expect(seriesOf(c.option).data).toContainEqual([0, 0, 12])
  })

  it('周二凌晨 0:30 记的宵夜算「周二 · 夜」；同一刻录入、却记在周一的那笔是补记，不进格子', () => {
    // 北京 9/8 00:30 = UTC 9/7 16:30
    // 变异：录入日改用 created_at.slice(0, 10)（UTC 日期）比 → 宵夜被扔、补记那笔反而进了周一 → 红
    const at = '2026-09-07T16:30:00.000Z'
    const snack = tx('2026-09-08', 3500, at)
    const late = tx('2026-09-07', 800, at)
    const g = weekHourGrid([snack, late], '2026-09-01', '2026-09-30')
    expect(g.cents[1][3]).toBe(3500)
    expect(g.cents[0].every((v) => v === 0)).toBe(true)
    expect(g.total).toBe(3500)
    expect(g.skipped).toBe(800)
  })

  it('时段边界按北京时间的整点小时：6–10 早、11–14 中、17–21 晚，其余（含下午 3、4 点）夜', () => {
    // 变异：slotOf 里 `hour <= 10` 改成 `hour < 10` → 10:30 那笔落到夜 → 红
    // 变异：「晚」的上界 21 改成 22 → 22:30 那笔落到晚 → 红
    const want = [3, 3, 3, 3, 3, 3, 0, 0, 0, 0, 0, 1, 1, 1, 1, 3, 3, 2, 2, 2, 2, 2, 3, 3]
    const day = '2026-09-09' // 周三
    for (let h = 0; h < 24; h++) {
      const g = weekHourGrid([tx(day, 100, bj(day, h, 30))], day, day)
      if (g.cents[2][want[h]] !== 100) expect.fail(`北京 ${h}:30 应该落在「${SLOTS[want[h]].name}」`)
    }
    expect(Array.from({ length: 24 }, (_, h) => slotOf(h))).toEqual(want)
  })

  it('周一在最左、周日在最右', () => {
    // 变异：weekdayIdx 去掉 `+ 6) % 7`（直接用 getUTCDay，周日 = 0）→ 周日跑到最左 → 红
    const sun = tx('2026-09-13', 500, bj('2026-09-13', 12))
    const mon = tx('2026-09-07', 700, bj('2026-09-07', 12))
    const g = weekHourGrid([sun, mon], '2026-09-01', '2026-09-30')
    expect(g.cents[6][1]).toBe(500)
    expect(g.cents[0][1]).toBe(700)
  })

  it('9/1 的账 9/5 才补记 → 这张图不算它；只有补记的账时显示空状态', () => {
    // 变异：去掉 `at.date !== t.date` 那条判断 → 补记那笔按 9/5 的钟点进了周二的格子 → 红
    const t = tx('2026-09-01', 9900, bj('2026-09-05', 12))
    const c = weekhour(input([t]))
    expect(c.option).toBeNull()
    expect(c.empty).toBeTruthy()
    expect(weekHourGrid([t], '2026-09-01', '2026-09-30').skipped).toBe(9900)
  })

  it('收入、转账、校准不算；时间范围外的支出不算（两端当天算）', () => {
    // 变异：过滤条件把 `t.type !== 'expense'` 去掉 → 工资、转账都进了格子 → 红
    // 变异：`t.date > end` 改成 `t.date >= end` → 范围最后一天那笔丢了 → 红
    const d = '2026-09-10'
    const txs = [
      tx(d, 1000000, bj(d, 9), { type: 'income' }),
      tx(d, 50000, bj(d, 9), { type: 'transfer', to_account_id: 'boc' }),
      tx(d, 30000, bj(d, 9), { type: 'adjust' }),
      tx('2026-09-04', 111, bj('2026-09-04', 9)), // 范围前一天
      tx('2026-09-05', 222, bj('2026-09-05', 9)), // 第一天
      tx('2026-09-12', 333, bj('2026-09-12', 9)), // 最后一天
      tx('2026-09-13', 444, bj('2026-09-13', 9)), // 范围后一天
    ]
    const g = weekHourGrid(txs, '2026-09-05', '2026-09-12')
    expect(g.total).toBe(222 + 333)
    expect(g.skipped).toBe(0)
  })

  it('周三中午同一格记了 3 笔（12 + 8 + 20 元）：提示框写「¥40.00 · 3 笔」；空着的格子写「没花钱」', () => {
    // 变异：count[w][s] += 1 写成 = 1 → 提示框写「1 笔」→ 红
    const d = '2026-09-09'
    const c = weekhour(input([tx(d, 1200, bj(d, 12)), tx(d, 800, bj(d, 12, 30)), tx(d, 2000, bj(d, 13, 45))]))
    const fmt = (c.option as { tooltip: { formatter: (p: { value: [number, number, number] }) => string } }).tooltip.formatter
    expect(fmt({ value: [2, 1, 40] })).toContain('¥40.00 · 3 笔')
    expect(fmt({ value: [2, 1, 40] })).toContain('周三 中')
    expect(fmt({ value: [0, 0, 0] })).toContain('没花钱')
  })

  it('图的样子：横轴一到日、纵轴早中晚夜（早在上）、色条在底部、28 格都在、颜色全来自 palette.CHART', () => {
    // 变异：yAxis 去掉 inverse → 红；inRange 的深色端换成 CHART.income → 红；只推有钱的格子（v > 0 才 push）→ 28 格不全，红
    const d = '2026-09-09'
    const c = weekhour(input([tx(d, 2000, bj(d, 12)), tx(d, 6000, bj(d, 19))]))
    const o = c.option as {
      xAxis: { data: string[] }
      yAxis: { data: string[]; inverse: boolean }
      visualMap: { orient: string; bottom: number; max: number; inRange: { color: string[] } }
      series: Series[]
    }
    expect(c.key).toBe('weekhour')
    expect(c.title).toBe('什么时候最爱花钱')
    expect(o.xAxis.data).toEqual(['一', '二', '三', '四', '五', '六', '日'])
    expect(o.yAxis.data).toEqual(['早', '中', '晚', '夜'])
    expect(o.yAxis.inverse).toBe(true)
    expect(o.visualMap.orient).toBe('horizontal')
    expect(o.visualMap.bottom).toBe(0)
    expect(o.visualMap.max).toBe(60)
    expect(o.visualMap.inRange.color).toEqual([CHART.axis, CHART.expense])
    expect(o.series[0].data).toHaveLength(WEEKDAYS.length * SLOTS.length)
    expect(o.series[0].data).toContainEqual([2, 1, 20])
    expect(o.series[0].data).toContainEqual([2, 2, 60])
  })

  it('没有任何记录 → 空状态，不画图；标题旁照样写着这段时间', () => {
    // 变异：去掉 `if (!hasAny) return … empty` → 画出一张 28 格全 0 的图 → 红
    // 变异：span 不写 → 红
    const c = weekhour(input([]))
    expect(c.option).toBeNull()
    expect(c.empty).toBeTruthy()
    expect(c.span).toBe('26.9')
  })
})

describe('weekhour：不变量', () => {
  // 固定种子的 LCG，红了能复现
  function rng(seed: number) {
    let s = seed >>> 0
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      return s / 2 ** 32
    }
  }

  it('bjDateHour ≡ date.ts 的 today() / fmtIsoTimeZh（Intl 按 Asia/Shanghai 算的那一套），任何时刻都成立', () => {
    // 变异：BJ_OFFSET_MS 写成 7 小时 → 小时差一 → 红
    // 测试进程的 TZ 是 UTC（vite.config.ts），用本机时区的 getHours 写法在这里也会红
    const r = rng(20260928)
    const lo = Date.UTC(1995, 0, 1)
    const hi = Date.UTC(2035, 11, 31)
    for (let i = 0; i < 3000; i++) {
      const ms = Math.floor(lo + r() * (hi - lo))
      const iso = new Date(ms).toISOString()
      const got = bjDateHour(iso)
      const date = today(new Date(ms))
      const hour = Number(fmtIsoTimeZh(iso).slice(0, 2))
      if (!got || got.date !== date || got.hour !== hour) expect.fail(`${iso}: 得到 ${JSON.stringify(got)}，应为 ${date} ${hour} 点`)
    }
    expect(bjDateHour('')).toBeNull()
    expect(bjDateHour('不是时间')).toBeNull()
  })

  it('随机账本：格子之和 + 补记没进格子的 ≡ 范围内全部支出；图上数据之和 ≡ 格子之和', () => {
    // 变异：补记那笔 continue 之前不累加 skipped（或者进格子时漏加 total）→ 等式断 → 红
    const types: Transaction['type'][] = ['expense', 'expense', 'expense', 'income', 'transfer', 'adjust']
    for (let k = 0; k < 200; k++) {
      const r = rng(k + 1)
      const txs: Transaction[] = []
      const n = Math.floor(r() * 40)
      for (let i = 0; i < n; i++) {
        const date = `2026-${r() < 0.5 ? '08' : '09'}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`
        // 一半当天记，一半晚 0–3 天补记；时刻随机到分钟
        const lagDays = r() < 0.5 ? 0 : Math.floor(r() * 4)
        const [y, m, d] = date.split('-').map(Number)
        const ms = Date.UTC(y, m - 1, d + lagDays, -8) + Math.floor(r() * 24 * 60) * 60_000
        txs.push(tx(date, 1 + Math.floor(r() * 50000), new Date(ms).toISOString(), { type: types[Math.floor(r() * types.length)] }))
      }
      const start = '2026-08-15'
      const end = '2026-09-20'
      const g = weekHourGrid(txs, start, end)
      const all = txs.filter((t) => t.type === 'expense' && t.date >= start && t.date <= end).reduce((s, t) => s + t.amount, 0)
      if (g.total + g.skipped !== all) expect.fail(`第 ${k} 份：${g.total} + ${g.skipped} ≠ ${all}`)
      const cells = g.cents.flat().reduce((s, v) => s + v, 0)
      if (cells !== g.total) expect.fail(`第 ${k} 份：格子之和 ${cells} ≠ ${g.total}`)
      const c = weekhour(input(txs, start, end))
      if (c.option) {
        const drawn = Math.round(seriesOf(c.option).data.reduce((s, p) => s + p[2], 0) * 100)
        if (drawn !== g.total) expect.fail(`第 ${k} 份：图上 ${drawn} ≠ ${g.total}`)
      } else if (g.total !== 0) expect.fail(`第 ${k} 份：有数却显示空状态`)
    }
  })
})

describe('weekhour：守规矩', () => {
  const src = readFileSync(new URL('./weekhour.ts', import.meta.url), 'utf8')
  it('不看 hidden、不碰 store / api、不写死十六进制颜色', () => {
    // 变异：往 weekhour.ts 里加一行 `if (t.hidden) continue` → 红
    expect(src).not.toMatch(/\bhidden\b/)
    expect(src).not.toMatch(/from '\.\.\/(store|api|supabase|facade)'/)
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})
