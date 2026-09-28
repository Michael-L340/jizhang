// 统计页顶上「月份 + 时间范围」→ 具体日期。两页（统计 / 进阶分析）共用这一个函数。
//
// 输入按用户视角写：「今天是 9 月 28 日，顶上选的是 X 月，范围选的是 Y，看到的是哪几天」。
// 每条用例的注释里写着把实现改坏成什么样它会红（都实际改过、跑过）。
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { addDays, daysInMonth, monthOf, monthRange, shiftMonth } from './date'
import { rangeBounds, type RangeSpec } from './range'

const TODAY = '2026-09-28'
const at = (kind: RangeSpec['kind'], ym: string, earliest = '2025-03-14', today = TODAY) => rangeBounds({ kind }, ym, earliest, today)

describe('今天 9/28，顶上停在本月（9 月）', () => {
  it('近一年 = 去年 10/1 到今天；终点不能跑到 9/30（今天之后没有账）', () => {
    // 变异：end 不截到今天 → 9/30，红；往前数 12 个月写成 -back → 从 2025-09 起，红
    expect(at('year', '2026-09')).toEqual({ start: '2025-10-01', end: '2026-09-28' })
  })

  it('本月 = 9/1 到今天；本年 = 1/1 到今天', () => {
    // 变异：本月的起点写成 monthRange(monthOf(today)) → 看 9 月时不红，所以下面还有看 2 月的那条
    expect(at('month', '2026-09')).toEqual({ start: '2026-09-01', end: '2026-09-28' })
    expect(at('ytd', '2026-09')).toEqual({ start: '2026-01-01', end: '2026-09-28' })
  })

  it('近三个月 = 7/1 起；近半年 = 4/1 起', () => {
    // 变异：quarter 和 half 的月数对调 → 红
    expect(at('quarter', '2026-09')).toEqual({ start: '2026-07-01', end: '2026-09-28' })
    expect(at('half', '2026-09')).toEqual({ start: '2026-04-01', end: '2026-09-28' })
  })

  it('全部记录 = 第一笔收支那天到今天', () => {
    // 变异：去掉 `if (range.kind === 'all') return …`（全部记录落到默认的近一年）→ 起点成了 2025-10-01，红
    expect(at('all', '2026-09')).toEqual({ start: '2025-03-14', end: '2026-09-28' })
  })
})

describe('今天 9/28，往回翻到了以前的月份', () => {
  it('停在 8 月看近一年 = 去年 9/1 到 8/31（整月，不截到今天）', () => {
    // 变异：end 恒取 today → 终点成了 9/28，红
    expect(at('year', '2026-08')).toEqual({ start: '2025-09-01', end: '2026-08-31' })
  })

  it('停在今年 2 月看本月 = 2/1 到 2/28；停在去年 11 月看本年 = 去年 1/1 到 11/30', () => {
    // 变异：本月起点按今天所在的月算 → 9/1，红；本年按今天的年份 → 2026-01-01，红
    expect(at('month', '2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' })
    expect(at('ytd', '2025-11')).toEqual({ start: '2025-01-01', end: '2025-11-30' })
  })

  it('翻到了第一笔账之前的月份看「全部记录」：只剩终点那一天，不会倒过来', () => {
    // 变异：去掉 earliest < end 的比较 → start 3/14 在 end 1/31 之后，红
    expect(at('all', '2025-01')).toEqual({ start: '2025-01-31', end: '2025-01-31' })
  })

  it('跨年：停在 2 月看近半年 = 去年 9/1 起', () => {
    // 变异：起点不用 shiftMonth、按「同一年的第 M−5 个月」手拼（`${ym.slice(0, 4)}-${pad(M - 5)}-01`）→ 「2026--3-01」，红
    expect(at('half', '2026-02')).toEqual({ start: '2025-09-01', end: '2026-02-28' })
  })
})

describe('自定义', () => {
  it('两头都选了：原样返回，跟顶上停在哪个月无关', () => {
    // 变异：自定义也把 end 截到选中月末 → 红
    const r = { kind: 'custom' as const, start: '2026-06-01', end: '2026-06-10' }
    expect(rangeBounds(r, '2026-09', '2025-03-14', TODAY)).toEqual({ start: '2026-06-01', end: '2026-06-10' })
    expect(rangeBounds(r, '2025-01', '2025-03-14', TODAY)).toEqual({ start: '2026-06-01', end: '2026-06-10' })
  })

  it('缺了一头（老版本存下来的半截数据）：按近一年算，不崩', () => {
    // 变异：条件改成只看 kind === 'custom' → 返回 start 为 undefined，红
    expect(rangeBounds({ kind: 'custom', start: '2026-06-01' }, '2026-09', '2025-03-14', TODAY)).toEqual(at('year', '2026-09'))
  })
})

// ---------- 不变量 ----------

/** 2026-09-28 抽成纯函数之前 Stats.tsx 里那段 useMemo，一字不改搬过来对账 */
function legacy(range: RangeSpec, ym: string, earliest: string, t: string) {
  if (range.kind === 'custom' && range.start && range.end) return { start: range.start, end: range.end }
  const monthEnd = monthRange(ym).end
  const end = monthEnd > t ? t : monthEnd
  if (range.kind === 'all') return { start: earliest < end ? earliest : end, end }
  if (range.kind === 'month') return { start: monthRange(ym).start, end }
  if (range.kind === 'ytd') return { start: `${ym.slice(0, 4)}-01-01`, end }
  const back = range.kind === 'quarter' ? 3 : range.kind === 'half' ? 6 : 12
  const start = addDays(monthRange(shiftMonth(monthOf(end), -(back - 1))).start, 0)
  return { start, end }
}

const KINDS: RangeSpec['kind'][] = ['month', 'ytd', 'quarter', 'half', 'year', 'all']
const BACK: Partial<Record<RangeSpec['kind'], number>> = { month: 1, quarter: 3, half: 6, year: 12 }

describe('不变量：今天换 40 个、月份往回翻 30 个、第一笔账换 3 个', () => {
  const todays: string[] = []
  for (let i = 0; i < 40; i++) todays.push(addDays('2024-01-01', i * 23)) // 覆盖月初、月末、闰年 2/29
  const earliests = ['2023-06-15', '2024-12-31', '2027-01-01']

  it('和抽出来之前的 Stats.tsx 逐格一样', () => {
    // 变异：end 不截到今天、all 不夹、往前数的月数多一个、本月 / 本年按今天而不是选中的月份 → 这条都红（都跑过）。
    // 自定义那一档不在这里对（它不看月份和今天），由上面「自定义」两条守
    for (const t of todays)
      for (let k = 0; k < 30; k++) {
        const ym = shiftMonth(monthOf(t), -k)
        for (const e of earliests)
          for (const kind of KINDS) {
            const a = rangeBounds({ kind }, ym, e, t)
            const b = legacy({ kind }, ym, e, t)
            if (a.start !== b.start || a.end !== b.end) expect.fail(`${kind} ym=${ym} today=${t} earliest=${e}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`)
          }
      }
  })

  it('起点不晚于终点；终点不晚于今天、落在选中的月份里；按月的几档起点是月初、正好 N 个整月', () => {
    // 变异：all 不夹（start 可能晚于 end）→ 红；end 不截到今天 → 红
    for (const t of todays)
      for (let k = 0; k < 30; k++) {
        const ym = shiftMonth(monthOf(t), -k)
        for (const e of earliests)
          for (const kind of KINDS) {
            const { start, end } = rangeBounds({ kind }, ym, e, t)
            const bad =
              start > end ||
              end > t ||
              monthOf(end) !== ym ||
              (end !== t && end.slice(8) !== String(daysInMonth(ym))) ||
              (BACK[kind] !== undefined && (start.slice(8) !== '01' || monthOf(start) !== shiftMonth(ym, -(BACK[kind]! - 1)))) ||
              (kind === 'ytd' && start !== `${ym.slice(0, 4)}-01-01`)
            if (bad) expect.fail(`${kind} ym=${ym} today=${t} earliest=${e}: ${start}..${end}`)
          }
      }
  })
})

describe('两页读同一对钥匙、调同一个函数', () => {
  // 页面测不了（没有 DOM），守源码。
  // 变异：进阶分析页把钥匙写成 'jz_more_range' → 红；Stats.tsx 退回自己算 → 红
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
  for (const p of ['../pages/Stats.tsx', '../pages/StatsMore.tsx']) {
    it(p, () => {
      const src = read(p)
      expect(src).toMatch(/useRecentState\('jz_stats_ym', \(\) => monthOf\(today\(\)\)\)/)
      expect(src).toMatch(/usePersistedState<RangeValue>\('jz_stats_range', \{ kind: 'year' \}\)/)
      expect(src).toMatch(/useMemo\(\(\) => rangeBounds\(range, ym, earliest, today\(\)\), \[range, ym, earliest\]\)/)
      expect(src).toMatch(/const earliest = useMemo\(\(\) => firstFlowDate\(otxs\), \[otxs\]\)/)
    })
  }
})
