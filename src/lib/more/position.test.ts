/// <reference types="node" />
// 所选月份在历史里的位置。输入一律是「用户记了这些账，今天几号，翻到哪个月，打开看到什么」。
// 每条用例都先把实现改坏跑过一次，确认它会红（注释里的「变异：… → 红」）。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Category, Transaction } from '../../types'
import { addDays, daysInMonth, monthRange, shiftMonth } from '../date'
import { CHART } from '../palette'
import { HISTORY_MONTHS, median, position, positionChart } from './position'
import type { MoreChart, MoreInput } from './types'

const CATS: Category[] = [
  { id: 'lunch', kind: 'expense', parent_id: null, name: '日常餐饮', icon: null, sort: 1, is_archived: false, note: null },
  { id: 'salary', kind: 'income', parent_id: null, name: '工资/实习', icon: null, sort: 1, is_archived: false, note: null },
]

let seq = 0
function tx(p: Partial<Transaction> & Pick<Transaction, 'type' | 'amount' | 'date'>): Transaction {
  seq++
  return {
    id: `p${seq}`, account_id: 'boc', to_account_id: null, category_id: null, note: null,
    installments: null, settles: null, hidden: null, created_at: '2026-09-01T00:00:00.000Z', ...p,
  }
}
const Y = (yuan: number) => Math.round(yuan * 100)
const spend = (date: string, yuan: number) => tx({ type: 'expense', amount: Y(yuan), date, category_id: 'lunch' })
const earn = (date: string, yuan: number) => tx({ type: 'income', amount: Y(yuan), date, category_id: 'salary' })

const open = (txs: Transaction[], ym: string, today: string): MoreChart => {
  const inp: MoreInput = { txs, accounts: [], cats: CATS, ym, start: `${ym}-01`, end: monthRange(ym).end, today }
  return positionChart(inp)
}

type Series = { name: string; color: string; data: (number | null)[]; showSymbol: boolean; lineStyle: { width: number; opacity?: number } }
type Opt = { series: Series[]; legend: { data: string[] }; xAxis: { data: string[] }; tooltip: { formatter: (ps: { dataIndex: number }[]) => string } }
const opt = (c: MoreChart) => c.option as unknown as Opt
const tiles = (c: MoreChart) => (c.tiles ?? []).map((t) => [t.label, t.value])

/**
 * 从 2026 年 3 月开始记的账。今天 9/12，停在 9 月。
 * 往前 12 个月里只有 3–8 月这 6 个月记过账（2025-09 到 2026-02 还没开始用 App）。
 * 每个月 1 号花一笔、20 号花一笔；到 12 号为止：3 月 50、4 月 300、5 月 100、6 月 200、7 月 400、8 月 150。
 * 9 月：1 号 100、5 号 50、12 号 20（到今天 170），20 号记了一笔预支 999（还没到）；另有还白条、校准、工资。
 */
const BOOK: Transaction[] = [
  spend('2026-03-01', 50), spend('2026-03-20', 500),
  spend('2026-04-01', 300), spend('2026-04-20', 10), spend('2026-04-30', 7),
  spend('2026-05-01', 100),
  spend('2026-06-01', 200),
  spend('2026-07-01', 400),
  spend('2026-08-01', 150), spend('2026-08-31', 40),
  spend('2026-09-01', 100), spend('2026-09-05', 50), spend('2026-09-12', 20), spend('2026-09-20', 999),
  tx({ type: 'transfer', amount: Y(5000), date: '2026-09-03', to_account_id: 'jd' }),
  tx({ type: 'adjust', amount: Y(-200), date: '2026-09-04' }),
  earn('2026-09-10', 8000),
]

describe('所选月份在历史里的位置', () => {
  it('今天 9/12 看 9 月：到今天 170；3–8 月到 12 号的中位数 (150 + 200) / 2 = 175；比 170 多的有 200、300、400 → 7 个月里排第 4', () => {
    // 变异：不管记没记账都往前取 12 个月（去掉 `m < firstYm` 那行）→ 6 个 0 进来，中位数 25、「12 个月」，红
    // 变异：偶数个时只取 s[m]（不取中间两个的平均）→ 200，红
    // 变异：标签写回「6 个月同期中位数」「排第几（从高到低）」（手机上三格一行被截掉，审阅 #12）→ 红
    // 变异：自己累计时把转账也算成支出 → 到今天 5170，红
    const c = open(BOOK, '2026-09', '2026-09-12')
    expect(c.key).toBe('position')
    expect(tiles(c)).toEqual([
      ['9月到今天', '¥170.00'],
      ['同期中位数', '¥175.00'],
      ['名次', '第 4 / 7'],
    ])
    expect(c.span).toBe('26.3–26.9')
  })

  it('红线（9 月）画到 12 号为止，13 号起空着、20 号那笔预支不画；灰线是记过账的 6 个月，4 月只有 30 天、31 号那一格空着', () => {
    // 变异：当前月也画整月（dailyCumulative 的 ref 恒为月底）→ 13 号起不是空的，红
    // 变异：补齐到 31 天时用 0 补（`: 0`）→ 4 月线 31 号掉到 0，红
    const o = opt(open(BOOK, '2026-09', '2026-09-12'))
    const red = o.series[o.series.length - 1]
    expect(red.name).toBe('9月')
    expect(red.color).toBe(CHART.expense)
    expect(o.xAxis.data).toHaveLength(31)
    expect(red.data).toHaveLength(31)
    expect(red.data.slice(0, 12)).toEqual([100, 100, 100, 100, 150, 150, 150, 150, 150, 150, 150, 170])
    expect(red.data.slice(12).every((v) => v === null)).toBe(true)
    const grey = o.series.slice(0, -1)
    expect(grey).toHaveLength(6)
    for (const g of grey) {
      expect(g.color).toBe(CHART.label)
      expect(g.showSymbol).toBe(false)
      expect(g.lineStyle.width).toBeLessThan(red.lineStyle.width)
      expect(g.lineStyle.opacity).toBeLessThan(1)
    }
    // 从早到晚：3、4、5、6、7、8 月
    const apr = grey[1]
    expect(apr.data[28]).toBe(310)
    expect(apr.data[29]).toBe(317)
    expect(apr.data[30]).toBeNull()
    expect(grey[5].data[30]).toBe(190)
    expect(o.legend.data).toEqual(['9月', '往前 6 个月'])
  })

  it('翻回 2 月看（今天 9/12）：2 月整月 300 和前几个月的整月比——1 月 31 号那 500 不能因为 2 月没有 31 号就丢掉', () => {
    // 变异：「同一天」不用月底合计、直接取那个月 28 号的累计（`full[Math.min(day, full.length) - 1]`）→ 1 月只剩 100，
    //       中位数 100、排第 1，红
    const txs = [spend('2025-12-01', 100), spend('2026-01-01', 100), spend('2026-01-31', 500), spend('2026-02-01', 300)]
    const c = open(txs, '2026-02', '2026-09-12')
    expect(tiles(c)).toEqual([
      ['2月整月', '¥300.00'],
      ['同期中位数', '¥350.00'],
      ['名次', '第 2 / 3'],
    ])
    // 翻回去的月份画整月，末点就是整月合计
    const red = opt(c).series.at(-1)!
    expect(red.data[27]).toBe(300)
    expect(red.data.slice(28).every((v) => v === null)).toBe(true)
  })

  it('今天 3/30 看 3 月：2 月没有 30 号 → 用 2 月的月底合计 15（不是 0）', () => {
    // 变异：同一天越界取 0（月底照取整月，其余 `full[day - 1] ?? 0`，不夹到那个月的月底）→ 2 月那一格是 0、排第 1，红
    const txs = [spend('2026-02-01', 10), spend('2026-02-28', 5), spend('2026-03-02', 7)]
    const P = position({ txs, ym: '2026-03', today: '2026-03-30' })
    expect(P.day).toBe(30)
    expect(P.now).toBe(700)
    expect(P.sameDay).toEqual([1500])
    expect(P.rank).toBe(2)
  })

  it('并列算靠前：9 月到今天 170，有个月同一天也是 170 → 只数比它多的，排第 2（不是第 3）', () => {
    // 变异：名次数「≥」（`v >= now`）→ 第 3，红
    const txs = [spend('2026-06-01', 100), spend('2026-07-01', 170), spend('2026-08-01', 300), spend('2026-09-01', 170)]
    expect(tiles(open(txs, '2026-09', '2026-09-12'))[2]).toEqual(['名次', '第 2 / 4'])
  })

  it('这个月才开始记账（往前一个月都没有）→ 一句话，不画图；几个月只记了工资 → 也是一句话', () => {
    // 变异：删掉「没有历史」那个 empty 分支 → 画了一张只有红线的图，红
    // 变异：删掉「都没花钱」那个 empty 分支 → 画了几条贴着 0 的线，红
    // 两句话各是各的：用 toBe 钉死原文（toBeTruthy 的话两个分支互换了也是绿的）。
    // 变异：两个 empty 分支的话对调 → 红
    const fresh = open([spend('2026-09-02', 30)], '2026-09', '2026-09-12')
    expect(fresh.option).toBeNull()
    expect(fresh.empty).toBe('往前还没有记过账的月份，没得比')
    const onlyPay = open([earn('2026-07-10', 5000), earn('2026-08-10', 5000), earn('2026-09-10', 5000)], '2026-09', '2026-09-12')
    expect(onlyPay.option).toBeNull()
    expect(onlyPay.empty).toBe('这几个月没有支出记录')
  })

  it('标题不写「本月」（翻到 2 月看的是 2 月）；底下那行字以句号结尾、不写「近 12」', () => {
    // 变异：标题改回「本月在历史里的位置」→ 红（registry.test.ts 对所有图守着同一条）
    for (const c of [open(BOOK, '2026-09', '2026-09-12'), open(BOOK, '2026-02', '2026-09-12')]) {
      expect(c.title).not.toMatch(/本月|这个月|五大类|近 ?12/)
      expect(c.note).not.toMatch(/近 ?12/)
      expect(c.note.endsWith('。')).toBe(true)
    }
  })

  it('提示框：点 12 号 → 9 月 170、同期中位数 175、最多是 7 月 400、最少是 3 月 50；点 31 号（9 月没有）→ 只有往前几个月的', () => {
    // 变异：最多 / 最少写反（reduce 里的 > 和 < 对调）→ 红
    const o = opt(open(BOOK, '2026-09', '2026-09-12'))
    const at12 = o.tooltip.formatter([{ dataIndex: 11 }])
    expect(at12).toContain('12 号')
    expect(at12).toMatch(/9月<\/span><span[^>]*>¥170\.00/)
    expect(at12).toMatch(/同期中位数<\/span><span[^>]*>¥175\.00/)
    expect(at12).toMatch(/最多（26\.7）<\/span><span[^>]*>¥400\.00/)
    expect(at12).toMatch(/最少（26\.3）<\/span><span[^>]*>¥50\.00/)
    const at31 = o.tooltip.formatter([{ dataIndex: 30 }])
    expect(at31).not.toContain('9月')
    // 31 号：3 月 550、4 月（30 天，月底）317、8 月 190 ……最多是 3 月
    expect(at31).toMatch(/最多（26\.3）<\/span><span[^>]*>¥550\.00/)
  })

  it('点 12 号（今天）→ 跳 9 月 12 号的流水；点 13 号（还没到）不跳；翻回 2 月，点 29 号（2 月没有）不跳、点 28 号跳', () => {
    // 同「累计支出 vs 上月」：点哪一号看所选月份那一天。x 轴固定 31 格，比这个月长的那几格没有日子。
    // 变异：「今天之后」写成 d >= today（今天也不跳）→ 12 号红
    // 变异：不看这个月有几天（只看今天）→ 2 月 29 号跳到 3 月 1 号，红
    // 变异：去掉 &cat=all → 红
    const sep = open(BOOK, '2026-09', '2026-09-12')
    expect(sep.onPoint?.(11, 0)).toBe('ym=2026-09&date=2026-09-12&cat=all')
    expect(sep.onPoint?.(0, 0)).toBe('ym=2026-09&date=2026-09-01&cat=all')
    expect(sep.onPoint?.(12, 0)).toBeNull()
    expect(sep.onPoint?.(-1, 0)).toBeNull()
    const feb = open([spend('2026-01-01', 100), spend('2026-02-01', 300)], '2026-02', '2026-09-12')
    expect(feb.onPoint?.(27, 0)).toBe('ym=2026-02&date=2026-02-28&cat=all')
    expect(feb.onPoint?.(28, 0)).toBeNull()
    expect(feb.onPoint?.(30, 0)).toBeNull()
  })

  it('提示框：点得动的那一号末尾写「再点一下看流水 ›」，点不动的（今天之后）不写', () => {
    // 变异：一律带「再点一下」→ 13 号也写了，点下去没反应，红；一律不带 → 12 号红
    const o = opt(open(BOOK, '2026-09', '2026-09-12'))
    expect(o.tooltip.formatter([{ dataIndex: 11 }])).toContain('再点一下看流水')
    expect(o.tooltip.formatter([{ dataIndex: 12 }])).not.toContain('再点一下')
  })

  it('不变量（随机账本 × 随机今天 × 翻回去 0–3 个月）：到今天的数 = 手算；每个月「同一天」= 手算；名次 = 1 + 比它多的月数；中位数夹在最少和最多之间', () => {
    // 变异：「同一天」不用月底合计（同上）→ 所选月份是 30 天、往前是 31 天的月份时对不上，红
    // 变异：名次数「≥」→ 红
    let s = 12
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
    const TYPES = ['expense', 'expense', 'expense', 'income', 'transfer', 'adjust'] as const
    for (let k = 0; k < 200; k++) {
      const txs: Transaction[] = []
      const from = addDays('2025-01-01', Math.floor(rnd() * 300))
      for (let i = 0; i < 80; i++) {
        txs.push(tx({ type: TYPES[Math.floor(rnd() * TYPES.length)], amount: 1 + Math.floor(rnd() * 30000), date: addDays(from, Math.floor(rnd() * 500)) }))
      }
      const today = addDays('2026-01-01', Math.floor(rnd() * 270))
      const ym = shiftMonth(today.slice(0, 7), -Math.floor(rnd() * 4))
      const P = position({ txs, ym, today })
      const n = daysInMonth(ym)
      const ref = ym === today.slice(0, 7) ? today : monthRange(ym).end
      const spent = (pred: (t: Transaction) => boolean) => txs.filter((t) => t.type === 'expense' && pred(t)).reduce((a, t) => a + t.amount, 0)
      const now = spent((t) => t.date.startsWith(ym) && t.date <= ref)
      if (P.now !== now) expect.fail(`${ym} 今天 ${today}：到今天 ${P.now} ≠ ${now}`)
      const firstFlow = txs.filter((t) => t.type === 'expense' || t.type === 'income').map((t) => t.date).sort()[0]
      const want = Array.from({ length: HISTORY_MONTHS }, (_, i) => shiftMonth(ym, i - HISTORY_MONTHS)).filter((m) => firstFlow && m >= firstFlow.slice(0, 7))
      if (JSON.stringify(P.history.map((h) => h.ym)) !== JSON.stringify(want)) expect.fail(`${ym}：往前的月份 ${P.history.map((h) => h.ym)} ≠ ${want}`)
      P.history.forEach((h, i) => {
        const v = spent((t) => t.date.startsWith(h.ym) && (P.day === n || Number(t.date.slice(8)) <= P.day))
        if (P.sameDay[i] !== v) expect.fail(`${ym} 比到 ${P.day} 号：${h.ym} 同一天 ${P.sameDay[i]} ≠ ${v}`)
        for (let d = 1; d < h.full.length; d++) if (h.full[d] < h.full[d - 1]) expect.fail('累计线往下走了')
      })
      if (P.rank !== 1 + P.sameDay.filter((v) => v > P.now).length) expect.fail('名次不对')
      if (P.rank < 1 || P.rank > P.history.length + 1) expect.fail('名次越界')
      if (P.median !== null && (P.median < Math.min(...P.sameDay) || P.median > Math.max(...P.sameDay))) expect.fail('中位数出界')
    }
    expect(median([])).toBeNull()
    expect(median([5, 1, 3])).toBe(3)
    expect(median([1, 2])).toBe(2) // 1.5 分四舍五入到 2 分
  })

  it('源码不写死颜色、不看 hidden、不碰 store / api / facade', () => {
    // 变异：往 position.ts 里加一行 `const X = '#918a80'` → 红
    const src = readFileSync(new URL('./position.ts', import.meta.url), 'utf8')
    expect(src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([])
    expect(src).not.toMatch(/\.hidden\b/)
    expect(src).not.toMatch(/from '\.\.\/(store|api|supabase|facade)'/)
  })
})
