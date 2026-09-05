// 日期全程用北京时间的 YYYY-MM-DD 字符串，不在业务代码里传 Date 对象。

const fmtCN = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' })

/** 北京时间的今天 */
export function today(now: Date = new Date()): string {
  return fmtCN.format(now)
}

export function nowIso(): string {
  return new Date().toISOString()
}

function parts(ymd: string): [number, number, number] {
  const [y, m, d] = ymd.split('-').map(Number)
  return [y, m, d]
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** ymd 加减 n 天（用 UTC 算，避开本机时区） */
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = parts(ymd)
  const t = Date.UTC(y, m - 1, d + n)
  const dt = new Date(t)
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

/** 'YYYY-MM-DD' → 'YYYY-MM' */
export function monthOf(ymd: string): string {
  return ymd.slice(0, 7)
}

export function daysInMonth(ym: string): number {
  const [y, m] = ym.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** 某月的首尾日期（含） */
export function monthRange(ym: string): { start: string; end: string } {
  return { start: `${ym}-01`, end: `${ym}-${pad(daysInMonth(ym))}` }
}

export function shiftMonth(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number)
  const total = y * 12 + (m - 1) + n
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}`
}

/** 以 endYm 结尾的连续 n 个月，升序 */
export function lastMonths(n: number, endYm: string): string[] {
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) out.push(shiftMonth(endYm, -i))
  return out
}

export function fmtMonthZh(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return `${y}年${m}月`
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六']

export function fmtDateZh(ymd: string, withWeek = true): string {
  const [y, m, d] = parts(ymd)
  const w = WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  const base = `${m}月${d}日`
  return withWeek ? `${base} 周${w}` : base
}

/** 相对描述：今天 / 昨天 / 9月3日 */
export function fmtDateRel(ymd: string, ref: string = today()): string {
  if (ymd === ref) return '今天'
  if (ymd === addDays(ref, -1)) return '昨天'
  return fmtDateZh(ymd, false)
}

/** ISO 时间 → 北京时间 'M月D日 HH:mm' */
export function fmtIsoZh(iso: string): string {
  const d = new Date(iso)
  const f = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  })
  return f.format(d)
}

/** ISO 时间 → 北京时间的 'HH:mm'。hourCycle 写死 h23，否则零点会变成「24:00」 */
export function fmtIsoTimeZh(iso: string): string {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  return f.format(new Date(iso))
}
