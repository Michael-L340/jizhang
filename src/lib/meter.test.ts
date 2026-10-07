// 用电记录的计算。输入一律是「几点看了一眼电表、上面写着多少」，问「页面上看到什么」。
// 每条用例都先把实现改坏跑过一次，确认它会红（注释里的「变异：… → 红」）。
import { describe, expect, it } from 'vitest'
import type { MeterReading } from '../types'
import { costCents, dailyUsage, fmtDuration, fmtSpan, hourProfile, peakHours, peakWeekdays, fmtKwh, fmtReading, intervals, parsePrice, parseReading, preview, rateSteps, summarize, weekdayLead, weekdayOf, weekdayProfile, WEEKDAY_WEEKS, type WeekdaySlot } from './meter'

let seq = 0
/** 北京时间「2026-10-01 08:00」那一刻电表上写着 value */
const R = (bj: string, value: string): MeterReading => ({
  id: `r${++seq}`,
  read_at: new Date(`${bj.replace(' ', 'T')}:00+08:00`).toISOString(),
  centi_kwh: parseReading(value)!,
  created_at: new Date(`${bj.replace(' ', 'T')}:00+08:00`).toISOString(),
})
const at = (bj: string) => new Date(`${bj.replace(' ', 'T')}:00+08:00`)

describe('读数的输入和显示', () => {
  it('「3393.4」存成 339340；最多两位小数；乱写的、负的不收', () => {
    // 变异：按 Number(s)*100 算 → 0.29 得 28.999999999999996，红
    expect(parseReading('3393.4')).toBe(339340)
    expect(parseReading(' 3393.45 ')).toBe(339345)
    expect(parseReading('0.29')).toBe(29)
    expect(parseReading('3393')).toBe(339300)
    expect(parseReading('3393.')).toBe(339300)
    for (const bad of ['', '-1', '3.456', 'abc', '1,000']) expect(parseReading(bad), bad).toBeNull()
    expect(fmtReading(339340)).toBe('3393.4')
    expect(fmtReading(339345)).toBe('3393.45')
    expect(fmtReading(339300)).toBe('3393.0')
    expect(fmtKwh(289.6)).toBe('2.9')
  })

  it('「过了多久」：分钟、小时、天', () => {
    expect(fmtDuration(0.5)).toBe('30 分钟')
    expect(fmtDuration(3 + 35 / 60)).toBe('3 小时 35 分')
    expect(fmtDuration(2)).toBe('2 小时')
    expect(fmtDuration(49)).toBe('2 天 1 小时')
  })

  it('列表里一行是一段：同一天「10/3 07:20–15:20」，跨天两头都写日期', () => {
    // 变异：跨天也只写一个日期 → 「10/2 22:50–07:40」看不出过了夜，红
    expect(fmtSpan(R('2026-10-03 07:20', '1').read_at, R('2026-10-03 15:20', '2').read_at)).toBe('10/3 07:20–15:20')
    expect(fmtSpan(R('2026-10-02 22:50', '1').read_at, R('2026-10-03 07:40', '2').read_at)).toBe('10/2 22:50 – 10/3 07:40')
  })

  it('电价：空着 = 不填；正数最多四位小数；乱写的不收', () => {
    expect(parsePrice('')).toBeNull()
    expect(parsePrice('0.588')).toBe(0.588)
    expect(parsePrice('1')).toBe(1)
    for (const bad of ['0', '-1', 'abc', '1.23456']) expect(parsePrice(bad), bad).toBeUndefined()
    // 2.9 度 × 1.2 元 = 3.48 元
    expect(costCents(290, 1.2)).toBe(348)
  })
})

describe('记一次的时候：比上次多了几度', () => {
  const rs = [R('2026-10-03 07:40', '3380.0'), R('2026-10-03 18:05', '3389.7')]

  it('21:40 记 3392.6 → 比 18:05 那次多 2.9 度，过了 3 小时 35 分，每小时 0.81 度', () => {
    const p = preview(rs, parseReading('3392.6')!, at('2026-10-03 21:40'))!
    expect(fmtReading(p.prev.centi_kwh)).toBe('3389.7')
    expect(fmtKwh(p.used)).toBe('2.9')
    expect(fmtDuration(p.hours)).toBe('3 小时 35 分')
    expect((p.perHour! / 100).toFixed(2)).toBe('0.81')
    expect(p.lower).toBe(false)
  })

  it('补记今天中午的：和中午之前最近的那次比（07:40），不是和最后录入的那次比', () => {
    // 变异：preview 拿最后一条（不看时间）当上一次 → 和 18:05 的 3389.7 比，红
    const p = preview(rs, parseReading('3384.0')!, at('2026-10-03 12:00'))!
    expect(fmtReading(p.prev.centi_kwh)).toBe('3380.0')
    expect(fmtKwh(p.used)).toBe('4.0')
  })

  it('输得比上次还小 → 标出来（输错了还是换表），不算速度', () => {
    const p = preview(rs, parseReading('3289.7')!, at('2026-10-03 21:40'))!
    expect(p.lower).toBe(true)
    expect(p.perHour).toBeNull()
  })

  it('第一次记 → 没有可比的', () => {
    expect(preview([], 100, at('2026-10-03 21:40'))).toBeNull()
  })
})

describe('每天用了多少度', () => {
  it('9/30 22:00 记 3380.0、10/1 08:00 记 3390.0：10 度摊在 10 个小时里，9/30 分到 2 度，10/1 分到 8 度', () => {
    // 变异：一段整个算给后一次读数那天（不按钟点切开）→ 9/30 是 0、10/1 是 10，红
    const days = dailyUsage([R('2026-09-30 22:00', '3380.0'), R('2026-10-01 08:00', '3390.0')], '2026-09-30', '2026-10-01')
    expect(days.map((d) => [d.date, fmtKwh(d.used), d.coveredHours])).toEqual([
      ['2026-09-30', '2.0', 2],
      ['2026-10-01', '8.0', 8],
    ])
  })

  it('读数倒退的那段（输错了、换表）不算用电，后面照常算', () => {
    // 变异：intervals 不跳过倒退的段 → 那天出来一个负几千度，红
    const rs = [R('2026-10-01 08:00', '3390.0'), R('2026-10-01 12:00', '339.0'), R('2026-10-01 20:00', '343.0')]
    const [d] = dailyUsage(rs, '2026-10-01', '2026-10-01')
    expect(fmtKwh(d.used)).toBe('4.0')
    expect(intervals(rs)).toHaveLength(1)
  })

  it('不变量（随机读数，从不倒退）：每天摊到的加起来 = 最后一次 − 第一次；任何一天都不是负的', () => {
    let s = 20261003
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
    for (let k = 0; k < 200; k++) {
      let v = 300000
      let t = Date.parse('2026-09-01T00:00:00+08:00') + rnd() * 86400_000
      const rs: MeterReading[] = []
      for (let i = 0; i < 2 + Math.floor(rnd() * 40); i++) {
        t += rnd() * 30 * 3600_000
        v += Math.floor(rnd() * 900)
        rs.push({ id: `x${k}-${i}`, read_at: new Date(t).toISOString(), centi_kwh: v, created_at: new Date(t).toISOString() })
      }
      const days = dailyUsage(rs, '2026-08-31', '2026-11-30')
      const sum = days.reduce((n, d) => n + d.used, 0)
      if (Math.abs(sum - (rs[rs.length - 1].centi_kwh - rs[0].centi_kwh)) > 1e-6) expect.fail(`第 ${k} 份：每天之和 ${sum} ≠ 首尾之差`)
      if (days.some((d) => d.used < 0 || d.coveredHours > 24 + 1e-9)) expect.fail(`第 ${k} 份：有一天是负的或超过 24 小时`)
    }
  })
})

describe('顶上三个大数字', () => {
  // 9/26 零点起每天零点、中午各看一次，每天正好用 8 度（零点到中午 3 度、中午到零点 5 度）；
  // 10/3 只记到 18:00（中午之后又用了 2 度）
  const rs: MeterReading[] = []
  let v = 3000
  for (let d = 26; d <= 33; d++) {
    const ymd = d <= 30 ? `2026-09-${d}` : `2026-10-0${d - 30}`
    rs.push(R(`${ymd} 00:00`, v.toFixed(1)))
    if (d === 33) {
      rs.push(R(`${ymd} 12:00`, (v + 3).toFixed(1)))
      rs.push(R(`${ymd} 18:00`, (v + 5).toFixed(1)))
      break
    }
    rs.push(R(`${ymd} 12:00`, (v + 3).toFixed(1)))
    v += 8
  }

  it('10/3 21:40 打开：今天到现在 5 度；10 月已用 21 度（1 号、2 号各 8 度 + 今天 5）；近 7 天日均 8 度；本月预计 = 21 + 8 × 剩下的（10/3 18:00 到月底）', () => {
    // 变异：日均把今天这个没过完的天也算进去 → 日均变小，红
    // 变异：本月预计从「今天零点」而不是「最后一次读数」往后算 → 多算 18 小时，红
    const s = summarize(rs, at('2026-10-03 21:40'))
    expect(fmtKwh(s.today)).toBe('5.0')
    expect(fmtKwh(s.month)).toBe('21.0')
    expect(fmtKwh(s.avg7!)).toBe('8.0')
    const restDays = (Date.parse('2026-11-01T00:00:00+08:00') - Date.parse('2026-10-03T18:00:00+08:00')) / 86400_000
    expect(fmtKwh(s.projected!)).toBe(fmtKwh(2100 + 800 * restDays))
  })

  it('才记了一次 → 今天 0 度、没有日均、不预计', () => {
    const s = summarize([R('2026-10-03 08:00', '3000.0')], at('2026-10-03 21:40'))
    expect(s.today).toBe(0)
    expect(s.avg7).toBeNull()
    expect(s.projected).toBeNull()
  })

  it('「什么时候最费电」：从 since 起每一段的平均速度（度/小时），起点被截到 since', () => {
    const steps = rateSteps(rs, Date.parse('2026-10-03T06:00:00+08:00'))
    expect(steps.map((x) => [new Date(x.from).toISOString(), x.perHour.toFixed(3)])).toEqual([
      ['2026-10-02T22:00:00.000Z', '0.250'],
      ['2026-10-03T04:00:00.000Z', '0.333'],
    ])
  })
})

describe('一天里几点最费电', () => {
  it('每天 0 点、12 点各看一次，上午 3 度、下午晚上 5 度 → 0–11 点每小时 0.25 度，12–23 点每小时约 0.42 度', () => {
    // 变异：按读数那一刻的钟点整段记账（不按时间平均分）→ 只有 0 点、12 点两根，红
    const rs: MeterReading[] = []
    let v = 3000
    for (let d = 1; d <= 5; d++) {
      rs.push(R(`2026-10-0${d} 00:00`, v.toFixed(1)), R(`2026-10-0${d} 12:00`, (v + 3).toFixed(1)))
      v += 8
    }
    rs.push(R('2026-10-06 00:00', v.toFixed(1)))
    const slots = hourProfile(rs, Date.parse('2026-09-01T00:00:00+08:00'), Date.parse('2026-10-07T00:00:00+08:00'))
    expect(slots.map((x) => (x.perHour! / 100).toFixed(2))).toEqual([...Array(12).fill('0.25'), ...Array(12).fill('0.42')])
    expect(slots.every((x) => Math.abs(x.days - 5) < 1e-9)).toBe(true)
  })

  it('22:00 到第二天 7:30 只记了两次 → 这 9.5 个钟点一样高（直接平均）；没盖到的钟点是空的', () => {
    const slots = hourProfile([R('2026-10-02 22:00', '3000.0'), R('2026-10-03 07:30', '3009.5')], 0, Date.parse('2026-10-04T00:00:00+08:00'))
    expect(slots[22].perHour).toBeCloseTo(100)
    expect(slots[3].perHour).toBeCloseTo(100)
    expect(slots[7].perHour).toBeCloseTo(100)
    expect(slots[7].days).toBeCloseTo(0.5)
    expect(slots[12].perHour).toBeNull()
  })

  it('不变量（随机读数）：Σ 每个钟点（每小时几度 × 盖到的小时数）= 这段时间里用掉的电', () => {
    let s = 20261005
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
    for (let k = 0; k < 200; k++) {
      let v = 300000
      let t = Date.parse('2026-09-01T00:00:00+08:00') + rnd() * 86400_000
      const rs: MeterReading[] = []
      for (let i = 0; i < 2 + Math.floor(rnd() * 30); i++) {
        t += rnd() * 20 * 3600_000
        v += Math.floor(rnd() * 900)
        rs.push({ id: `h${k}-${i}`, read_at: new Date(t).toISOString(), centi_kwh: v, created_at: new Date(t).toISOString() })
      }
      const from = Date.parse('2026-09-03T05:17:00+08:00')
      const to = Date.parse('2026-09-20T00:00:00+08:00')
      const total = hourProfile(rs, from, to).reduce((n, x) => n + (x.perHour ?? 0) * x.days, 0)
      const ivs = intervals(rs)
      let want = 0
      for (const iv of ivs) {
        const a = Date.parse(iv.from.read_at), b = Date.parse(iv.to.read_at)
        const lo = Math.max(a, from), hi = Math.min(b, to)
        if (hi > lo) want += (iv.used * (hi - lo)) / (b - a)
      }
      if (Math.abs(total - want) > 1e-6) expect.fail(`第 ${k} 份：钟点合计 ${total} ≠ 用掉的 ${want}`)
    }
  })

  it('最费电的钟点：晚上明显高 → 挑出来；只记早晚两次、各钟点差不多高 → 一个都不挑（不硬标三根）', () => {
    // 变异：不看中位数，永远挑最高三根 → 第二种情况挑出三个，红
    const slot = (hour: number, perHour: number | null) => ({ hour, perHour, days: 30 })
    const evening = Array.from({ length: 24 }, (_, h) => slot(h, h >= 20 && h <= 22 ? 90 : h === 23 ? 50 : 30))
    expect(peakHours(evening)).toEqual([20, 21, 22])
    const flat = Array.from({ length: 24 }, (_, h) => slot(h, 35 + (h % 3)))
    expect(peakHours(flat)).toEqual([])
    expect(peakHours(Array.from({ length: 24 }, (_, h) => slot(h, null)))).toEqual([])
  })
})

describe('一周里哪天最费电', () => {
  const DAY = 86400_000
  /** 从 from 到 to 每天零点记一次，第 i 天（from 是第 0 天）用 kwh(i, 日期) 度；读数从 1000.00 起 */
  const daily = (from: string, to: string, kwh: (i: number, ymd: string) => number): MeterReading[] => {
    const out: MeterReading[] = []
    let v = 100000
    const t0 = at(`${from} 00:00`).getTime()
    for (let t = t0, i = 0; t <= at(`${to} 00:00`).getTime(); t += DAY, i++) {
      const ymd = new Date(t + 8 * 3600_000).toISOString().slice(0, 10)
      out.push(R(`${ymd} 00:00`, (v / 100).toFixed(2)))
      v += Math.round(kwh(i, ymd) * 100)
    }
    return out
  }
  const slot = (dow: number, perDay: number | null): WeekdaySlot => ({ dow, perDay, days: perDay === null ? 0 : 5 })
  const mk = (vals: (number | null)[]) => vals.map((v, i) => slot(i + 1, v))

  it('周几：2026-10-08 是周四；周日是 7 不是 0', () => {
    // 变异：直接用 getUTCDay()（周日 = 0）→ 红
    expect(weekdayOf('2026-10-08')).toBe(4)
    expect(weekdayOf('2026-10-11')).toBe(7)
    expect(weekdayOf('2026-10-12')).toBe(1)
  })

  it('8/1（周六）起每天零点记一次到 10/9 零点，周六 12 度、别的天 8 度，10/8 看：周六那根 12 度、其余 8 度；周一到周三、周六日各 10 天，周四五各 9 天（今天 10/8 虽然记满了也不算）', () => {
    // 变异：周几错一位 → 12 度落到周日那根，红；窗口把今天算进去 → 周四变 10 天，红
    const rs = daily('2026-08-01', '2026-10-09', (i) => (i % 7 === 0 ? 12 : 8))
    const w = weekdayProfile(rs, '2026-10-08')
    expect(w.map((x) => x.dow)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(w.map((x) => x.perDay)).toEqual([800, 800, 800, 800, 800, 1200, 800])
    expect(w.map((x) => x.days)).toEqual([10, 10, 10, 9, 9, 10, 10])
  })

  it('只算记满的整天：第一天中午才开始记、最后一天没记完，这两天都不算', () => {
    // 变异：盖了一部分的天也算 → 周六（10/3 中午起只盖半天）多出一根，红
    const rs = [R('2026-10-03 12:00', '1000.0'), R('2026-10-04 00:00', '1004.0'), R('2026-10-05 00:00', '1012.0'), R('2026-10-05 12:00', '1015.0')]
    const w = weekdayProfile(rs, '2026-10-06')
    expect(w.map((x) => x.perDay)).toEqual([null, null, null, null, null, null, 800])
    expect(w.map((x) => x.days)).toEqual([0, 0, 0, 0, 0, 0, 1])
  })

  it(`窗口 = 今天的前一天往回整整 ${WEEKDAY_WEEKS} 周：今天 10/8，4/9 那天的 100 度算进来，4/8 的不算`, () => {
    // 变异：窗口多一天或少一天 → 红
    const spike = (day: string) => daily('2026-01-01', '2026-10-08', (_, ymd) => (ymd === day ? 100 : 8))
    const inWin = weekdayProfile(spike('2026-04-09'), '2026-10-08')
    expect(inWin[3].days).toBe(26)
    expect(inWin[3].perDay).toBeCloseTo((25 * 800 + 10000) / 26, 6)
    const outWin = weekdayProfile(spike('2026-04-08'), '2026-10-08')
    expect(outWin.map((x) => x.perDay)).toEqual([800, 800, 800, 800, 800, 800, 800])
    expect(outWin.map((x) => x.days)).toEqual([26, 26, 26, 26, 26, 26, 26])
  })

  it('最费电的那一两天：周末明显高 → 两天；七天差不多 → 不挑；三天都高也只标两根；只有一天有数 → 不挑', () => {
    // 变异：最多挑 3 个 → 第三组红
    expect(peakWeekdays(mk([800, 800, 800, 800, 800, 1200, 1100]))).toEqual([6, 7])
    expect(peakWeekdays(mk([800, 820, 790, 810, 800, 830, 805]))).toEqual([])
    expect(peakWeekdays(mk([1300, 800, 800, 800, 800, 1200, 1100]))).toEqual([1, 6])
    expect(peakWeekdays(mk([null, null, null, null, null, 800, null]))).toEqual([])
  })

  it('「比其他天多几成」：周六 12 度、其余 8 度 → 多 50%；其余天都没数 → 不说', () => {
    expect(weekdayLead(mk([800, 800, 800, 800, 800, 1200, 800]), [6])).toBeCloseTo(0.5, 9)
    expect(weekdayLead(mk([null, null, null, null, null, 1200, null]), [6])).toBeNull()
    expect(weekdayLead(mk([800, 800, 800, 800, 800, 1200, 800]), [])).toBeNull()
  })

  it('不变量（随机读数，从不倒退）：Σ 每个星期几（平均每天几度 × 天数）= 窗口里记满的整天用掉的电，整天数也对得上；没数 ⇔ 0 天；每个星期几最多 26 天', () => {
    let s = 20261008
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
    const today = '2026-10-08'
    const t0 = at(`${today} 00:00`).getTime()
    for (let k = 0; k < 200; k++) {
      let v = 300000
      let t = Date.parse('2026-03-20T00:00:00+08:00') + Math.floor(rnd() * 40 * DAY)
      const rs: MeterReading[] = []
      for (let i = 0; i < 2 + Math.floor(rnd() * 150); i++) {
        t += 60_000 + Math.floor(rnd() * 40 * 3600_000)
        v += Math.floor(rnd() * 900)
        rs.push({ id: `w${k}-${i}`, read_at: new Date(t).toISOString(), centi_kwh: v, created_at: new Date(t).toISOString() })
      }
      // 独立口径：读数之间线性插值；「记满的整天」= 第一次读数不晚于这天零点、最后一次不早于第二天零点
      const pts = rs.map((r) => [Date.parse(r.read_at), r.centi_kwh] as const)
      const valueAt = (x: number) => {
        let i = 0
        while (i + 1 < pts.length && pts[i + 1][0] <= x) i++
        if (i + 1 >= pts.length) return pts[i][1]
        const [a, va] = pts[i]
        const [b, vb] = pts[i + 1]
        return va + ((vb - va) * (x - a)) / (b - a)
      }
      let want = 0
      let n = 0
      for (let d = t0 - WEEKDAY_WEEKS * 7 * DAY; d < t0; d += DAY) {
        if (pts[0][0] <= d && pts[pts.length - 1][0] >= d + DAY) {
          want += valueAt(d + DAY) - valueAt(d)
          n++
        }
      }
      const w = weekdayProfile(rs, today)
      const got = w.reduce((a, x) => a + (x.perDay ?? 0) * x.days, 0)
      const days = w.reduce((a, x) => a + x.days, 0)
      if (days !== n) expect.fail(`第 ${k} 份：算了 ${days} 个整天，应该是 ${n} 个`)
      if (Math.abs(got - want) > 1e-6) expect.fail(`第 ${k} 份：合计 ${got} ≠ 用掉的 ${want}`)
      for (const x of w) {
        if ((x.perDay === null) !== (x.days === 0)) expect.fail(`第 ${k} 份：周${x.dow} 没数和 0 天对不上`)
        if (x.days > WEEKDAY_WEEKS) expect.fail(`第 ${k} 份：周${x.dow} 有 ${x.days} 天，超过 ${WEEKDAY_WEEKS}`)
      }
    }
  })
})
