// 用电记录（设置 → 用电记录）的纯计算：电表读数 → 用了几度、每天多少、什么时候最费电、这个月大概多少钱。
// 页面里只留渲染。读数单位一律是整数「0.01 度」（MeterReading.centi_kwh），只在这里和输入框、显示之间换算。
//
// 电表显示的是**累计读数**，越走越大（用户 2026-10-03 确认）。两次读数之间用掉的电 = 后一次 − 前一次，
// 按时间平均摊到这段时间里的每一刻：读数不用在零点记，一段跨了午夜就按钟点切开分给两天。
// 后一次比前一次还小（输错了、换了表）的那一段不算用电：宁可少算一段，也不能算出负的或一下子几千度。
import type { MeterReading } from '../types'

const HOUR_MS = 3600_000
const DAY_MS = 24 * HOUR_MS
/** 北京时间比 UTC 早 8 小时，没有夏令时 */
const BJ_OFFSET_MS = 8 * HOUR_MS

/** 输入框里的读数（「3393.4」）→ 整数 0.01 度。最多两位小数；不是合法的非负数就返回 null */
export function parseReading(input: string): number | null {
  const s = input.trim()
  const m = /^(\d{1,9})(?:\.(\d{0,2}))?$/.exec(s)
  if (!m) return null
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))
}

/** 整数 0.01 度 → 电表上的样子：一位小数，第二位不是 0 才写两位（3393.4、3393.45） */
export function fmtReading(centi: number): string {
  const whole = Math.floor(centi / 100)
  const frac = centi % 100
  return frac % 10 === 0 ? `${whole}.${frac / 10}` : `${whole}.${String(frac).padStart(2, '0')}`
}

/** 用了多少度（可以是摊出来的小数）→ 一位小数 */
export function fmtKwh(centi: number): string {
  return (Math.round(centi / 10) / 10).toFixed(1)
}

/** 按读数时间从早到晚（同一刻按录入先后） */
export function sortReadings(rs: MeterReading[]): MeterReading[] {
  return [...rs].sort((a, b) => Date.parse(a.read_at) - Date.parse(b.read_at) || (a.created_at < b.created_at ? -1 : 1))
}

export interface Interval {
  from: MeterReading
  to: MeterReading
  /** 这段用掉的电，0.01 度 */
  used: number
  hours: number
  /** 平均每小时几度（0.01 度 / 小时） */
  perHour: number
}

/**
 * 相邻两次读数之间的一段段。读数倒退的那段（输错了、换表）不算，同一时刻的两条也不算（时长为 0 没法算速度）。
 * 等式：各段 used 之和 = 最后一次 − 第一次（读数没倒退过时），meter.test.ts 拿随机读数守着。
 */
export function intervals(rs: MeterReading[]): Interval[] {
  const s = sortReadings(rs)
  const out: Interval[] = []
  for (let i = 1; i < s.length; i++) {
    const from = s[i - 1]
    const to = s[i]
    const hours = (Date.parse(to.read_at) - Date.parse(from.read_at)) / HOUR_MS
    const used = to.centi_kwh - from.centi_kwh
    if (hours <= 0 || used < 0) continue
    out.push({ from, to, used, hours, perHour: used / hours })
  }
  return out
}

/** 北京时间 YYYY-MM-DD 那天零点的时间戳 */
function dayStart(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number)
  return Date.UTC(y, m - 1, d) - BJ_OFFSET_MS
}

/** 时间戳在北京时间是哪一天 */
function dayOf(ms: number): string {
  return new Date(ms + BJ_OFFSET_MS).toISOString().slice(0, 10)
}

/** [a, b) 这段时间里用掉了多少（0.01 度）：每一段按重叠的时长比例摊 */
export function usedBetween(ivs: Interval[], a: number, b: number): number {
  let sum = 0
  for (const iv of ivs) {
    const s = Date.parse(iv.from.read_at)
    const e = Date.parse(iv.to.read_at)
    const lo = Math.max(a, s)
    const hi = Math.min(b, e)
    if (hi > lo) sum += (iv.used * (hi - lo)) / (e - s)
  }
  return sum
}

export interface DayUsage {
  date: string
  /** 这天用了多少（0.01 度，摊出来的，可以带小数） */
  used: number
  /** 这天有多少小时被读数盖住了（0–24）。第一次读数之前、最后一次读数之后的钟点算不出来 */
  coveredHours: number
}

/** start..end（含两端，北京时间）每天用了多少 */
export function dailyUsage(rs: MeterReading[], start: string, end: string): DayUsage[] {
  const ivs = intervals(rs)
  const out: DayUsage[] = []
  for (let t = dayStart(start); t <= dayStart(end); t += DAY_MS) {
    let covered = 0
    for (const iv of ivs) {
      const lo = Math.max(t, Date.parse(iv.from.read_at))
      const hi = Math.min(t + DAY_MS, Date.parse(iv.to.read_at))
      if (hi > lo) covered += hi - lo
    }
    out.push({ date: dayOf(t), used: usedBetween(ivs, t, t + DAY_MS), coveredHours: covered / HOUR_MS })
  }
  return out
}

export interface PowerSummary {
  /** 今天零点到最后一次读数用了多少 */
  today: number
  /** 这个月 1 号零点到最后一次读数 */
  month: number
  /** 最近 7 个整天（不含今天、只算被读数盖满的天）的日均；凑不够一天就是 null */
  avg7: number | null
  /** 这个月预计：已经用的 + 日均 × 这个月剩下的时间（从最后一次读数算到月底）；没有日均就是 null */
  projected: number | null
}

/** 顶上三个大数字。now 只用来定「今天」「这个月」是哪天 */
export function summarize(rs: MeterReading[], now: Date): PowerSummary {
  const ivs = intervals(rs)
  const todayYmd = dayOf(now.getTime())
  const t0 = dayStart(todayYmd)
  const m0 = dayStart(`${todayYmd.slice(0, 7)}-01`)
  const [y, mo] = todayYmd.split('-').map(Number)
  const m1 = Date.UTC(y, mo, 1) - BJ_OFFSET_MS
  const today = usedBetween(ivs, t0, t0 + DAY_MS)
  const month = usedBetween(ivs, m0, m1)
  const full = dailyUsage(rs, dayOf(t0 - 7 * DAY_MS), dayOf(t0 - DAY_MS)).filter((d) => d.coveredHours >= 24 - 1e-9)
  const avg7 = full.length ? full.reduce((s, d) => s + d.used, 0) / full.length : null
  const last = ivs.length ? Date.parse(ivs[ivs.length - 1].to.read_at) : null
  const projected = avg7 === null || last === null ? null : month + (avg7 * Math.max(0, m1 - Math.max(last, m0))) / DAY_MS
  return { today, month, avg7, projected }
}

/** 记一次之前，输入框底下那句「比上次多 2.9 度」：上一次读数（按时间，不按录入先后）和它比 */
export interface Preview {
  prev: MeterReading
  used: number
  hours: number
  perHour: number | null
  /** 比上一次还小：是输错了，还是换表了 */
  lower: boolean
}

export function preview(rs: MeterReading[], centi: number, at: Date): Preview | null {
  const t = at.getTime()
  const before = sortReadings(rs).filter((r) => Date.parse(r.read_at) <= t)
  const prev = before[before.length - 1]
  if (!prev) return null
  const hours = (t - Date.parse(prev.read_at)) / HOUR_MS
  const used = centi - prev.centi_kwh
  return { prev, used, hours, perHour: hours > 0 && used >= 0 ? used / hours : null, lower: used < 0 }
}

/** 「过了 3 小时 35 分」 */
export function fmtDuration(hours: number): string {
  const min = Math.round(hours * 60)
  if (min < 60) return `${min} 分钟`
  const d = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)
  const m = min % 60
  if (d) return h ? `${d} 天 ${h} 小时` : `${d} 天`
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`
}

/** 电价（元/度）存本机，没填就是 null（只显示度数） */
export const PRICE_KEY = 'jz_power_price'

/** 输入框里的电价 → 元/度；空串 = 不填 */
export function parsePrice(input: string): number | null | undefined {
  const s = input.trim()
  if (!s) return null
  return /^\d{1,3}(\.\d{1,4})?$/.test(s) && Number(s) > 0 ? Number(s) : undefined
}

/** 0.01 度 × 元/度 → 整数「分」 */
export function costCents(centi: number, price: number): number {
  return Math.round(centi * price)
}

/** 「什么时候最费电」那张图：从 since 起每一段读数的平均速度（度/小时），画成台阶 */
export function rateSteps(rs: MeterReading[], since: number): { from: number; to: number; perHour: number }[] {
  return intervals(rs)
    .filter((iv) => Date.parse(iv.to.read_at) > since)
    .map((iv) => ({ from: Math.max(since, Date.parse(iv.from.read_at)), to: Date.parse(iv.to.read_at), perHour: iv.perHour / 100 }))
}

export { dayOf as beijingDayOf, dayStart as beijingDayStart, DAY_MS, HOUR_MS }
