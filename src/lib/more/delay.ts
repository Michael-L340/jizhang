// 进阶统计 ·「补记延迟」：花完钱多久才记上。不画图，只有三个小数字。
//
// 只吃 MoreInput.txs（当前模式那本账），不看 hidden、不碰 store。
// 只看收入和支出（compute.isFlow）：转账、校准不是「花了一笔 / 进了一笔」，谈不上补记。
//
// 录入时刻只有 created_at（UTC 的 ISO 串），流水本身只有日期没有钟点，所以：
//   · created_at 换成北京时间（weekhour.bjDateHour，和 date.ts 的 today() 逐点对账过）；
//   · 录入的北京日期早于账上日期的是「预记」（提前把下周的房租记上），不是补记，不算；
//   · 延迟 = 录入时刻 − 账上那天北京时间中午 12:00（几点花的不知道，取中午当估计），当天上午记的算 0。
//
// 整批导入的不算（审阅 #5）：用户 2025 年到 2026-09 初的历史账是从 Excel 整批导进来的，created_at 是导入那一刻，
// 算进来的话「平均延迟」是好几个月、「拖过一天的」是几百笔，说的全是导入那天，不是记账习惯。
// 认法：**整本账**里 created_at 落在同一分钟的记录 ≥ IMPORT_BATCH（20）笔，这一分钟的全算导入。阈值怎么定的：
//   · 手记一笔要填金额、挑分类和账户，再快也要好几秒，一分钟记 20 笔 = 3 秒一笔，人手做不到；平常一天也就几笔；
//   · 导入是几百行一次写进去：同一批的 created_at 是同一刻（或者差几毫秒），落在一两分钟里、每分钟成百上千；
//   · 离线记的账联网后补传，created_at 是记账时本机填的（api.txToRow 带着它上去），不会挤进同一分钟，不会被误伤。
// 数的是整本账、不分类型（导入的转账、校准也在那一分钟里），不是只数这段时间的收支：
// 选「本月」时一个月里只落了几笔导入的账，光数这几笔永远到不了 20。
import { isFlow } from '../compute'
import { daysBetween } from '../date'
import type { Transaction } from '../../types'
import { rangeSpan } from './span'
import type { MoreChart, MoreInput, MoreTile } from './types'
import { bjDateHour } from './weekhour'

const HOUR_MS = 3600_000
const MINUTE_MS = 60_000
/** 同一分钟里录入这么多笔（整本账），就当是整批导入的（见文件头） */
export const IMPORT_BATCH = 20
/** 平均延迟到这么多小时就改写成天（「52.0 小时」不如「2.2 天」好读） */
export const DAYS_FROM_HOURS = 48

export interface DelayStats {
  /** 算进来的笔数（范围内、录入不早于账上日期的收支） */
  n: number
  /** 平均延迟（小时）；n = 0 时 null */
  meanHours: number | null
  /** 当天记的（录入的北京日期 = 账上日期）笔数 */
  sameDay: number
  /** 拖过一天的笔数：录入日比账上日期晚两天及以上（9/1 的账，9/3 或更晚才记；隔天记不算） */
  late: number
  /** 范围内的收支里，因为是预记（录入早于账上日期）或录入时刻坏了而没算的笔数 */
  skipped: number
  /** 范围内的收支里，整批导入的、没算的笔数 */
  imported: number
}

/** 整批导入的那几分钟（created_at 取整到分钟的序号）：整本账里同一分钟录入 ≥ IMPORT_BATCH 笔 */
export function importMinutes(txs: Transaction[]): Set<number> {
  const per = new Map<number, number>()
  for (const t of txs) {
    const ms = Date.parse(t.created_at)
    if (Number.isNaN(ms)) continue
    const m = Math.floor(ms / MINUTE_MS)
    per.set(m, (per.get(m) ?? 0) + 1)
  }
  return new Set([...per].filter(([, n]) => n >= IMPORT_BATCH).map(([m]) => m))
}

/** 账上那天北京时间中午 12 点（= UTC 4 点）的毫秒数 */
function noonMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return Date.UTC(y, m - 1, d, 12 - 8)
}

export function delayStats(txs: Transaction[], start: string, end: string): DelayStats {
  let n = 0
  let sumMs = 0
  let sameDay = 0
  let late = 0
  let skipped = 0
  let imported = 0
  const batch = importMinutes(txs)
  for (const t of txs) {
    if (!isFlow(t) || t.date < start || t.date > end) continue
    const at = bjDateHour(t.created_at)
    if (at && batch.has(Math.floor(Date.parse(t.created_at) / MINUTE_MS))) {
      imported++
      continue
    }
    if (!at || at.date < t.date) {
      skipped++
      continue
    }
    n++
    sumMs += Math.max(0, Date.parse(t.created_at) - noonMs(t.date))
    if (at.date === t.date) sameDay++
    else if (daysBetween(t.date, at.date) >= 2) late++
  }
  return { n, meanHours: n ? sumMs / n / HOUR_MS : null, sameDay, late, skipped, imported }
}

/** 平均延迟的写法：一位小数；到 48 小时（按显示出来的那位小数算）就写成天 */
export function fmtDelay(hours: number): string {
  const h = Math.round(hours * 10) / 10
  return h >= DAYS_FROM_HOURS ? `${(hours / 24).toFixed(1)} 天` : `${h.toFixed(1)} 小时`
}

export function delay(inp: MoreInput): MoreChart {
  const s = delayStats(inp.txs, inp.start, inp.end)
  // 被当成导入、没算的有几笔，写在说明末尾：不写的话，导入过历史账的人看着「一共才记了 12 笔？」会以为算漏了
  const importNote = s.imported ? `整批导入的 ${s.imported} 笔不算（同一分钟录入 ${IMPORT_BATCH} 笔以上的算导入）。` : ''
  const base = {
    key: 'delay',
    title: '补记延迟',
    span: rangeSpan(inp.start, inp.end, inp.today),
    note: `这段时间的收入和支出，从账上那天中午 12 点（几点花的不知道，按中午估）到录入时刻隔了多久，当天上午记的算 0。拖过一天 = 隔了一整天以上才记（1 号的账 3 号及以后才记）。提前记的不算；转账、校准不算。${importNote}`,
    option: null,
  }
  if (s.n === 0 || s.meanHours === null) {
    const why = s.skipped && s.imported ? '提前记的或整批导入的' : s.skipped ? '提前记的' : s.imported ? '整批导入的' : ''
    const empty = why ? `这段时间的记录都是${why}，算不出延迟` : '这段时间没有收支记录'
    return { ...base, empty }
  }
  const tiles: MoreTile[] = [
    { label: '平均延迟', value: fmtDelay(s.meanHours) },
    { label: '当天记的', value: `${Math.round((s.sameDay / s.n) * 100)}%` },
    { label: '拖过一天的', value: `${s.late} 笔` },
  ]
  return { ...base, tiles }
}
