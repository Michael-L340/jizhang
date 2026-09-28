// 统计页顶上「月份 + 时间范围」换算成一段具体日期（含两端）。
//
// 统计页和进阶分析页读同一对钥匙（jz_stats_ym / jz_stats_range），也必须用同一个算法，
// 否则两页同一个「近一年」各算各的，数对不上。原来这段写在 Stats.tsx 的 useMemo 里，
// 2026-09-28 抽出来给两页共用，行为逐格没变（range.test.ts 拿旧写法对过账）。
//
// 纯函数：今天从外面传进来，测试才能定住日期。
import { monthOf, monthRange, shiftMonth } from './date'

/**
 * 和 components/RangeSheet.tsx 的 RangeValue 同形（那边是 UI 的类型，lib 不能反过来 import 组件）。
 * 那边往 RangeKind 里加一项而这里没跟上，Stats.tsx 调用处会类型报错，不会悄悄落到默认分支。
 */
export interface RangeSpec {
  kind: 'month' | 'ytd' | 'quarter' | 'half' | 'year' | 'all' | 'custom'
  /** kind = 'custom' 时有效 */
  start?: string
  end?: string
}

/**
 * 终点跟着选中的月份走（选的是本月就到今天为止），起点由范围决定：
 *   本月 = 这个月 1 号；本年 = 这一年 1 月 1 号；近三个月 / 近半年 / 近一年 = 往前数 3 / 6 / 12 个整月；
 *   全部记录 = 第一笔收支那天（比终点还晚时就从终点起，区间只剩一天，不会倒过来）；
 *   自定义 = 原样，不看月份。自定义缺了哪一头，按近一年算。
 */
export function rangeBounds(range: RangeSpec, ym: string, earliest: string, today: string): { start: string; end: string } {
  if (range.kind === 'custom' && range.start && range.end) return { start: range.start, end: range.end }
  const monthEnd = monthRange(ym).end
  const end = monthEnd > today ? today : monthEnd
  if (range.kind === 'all') return { start: earliest < end ? earliest : end, end }
  if (range.kind === 'month') return { start: monthRange(ym).start, end }
  if (range.kind === 'ytd') return { start: `${ym.slice(0, 4)}-01-01`, end }
  const back = range.kind === 'quarter' ? 3 : range.kind === 'half' ? 6 : 12
  return { start: monthRange(shiftMonth(monthOf(end), -(back - 1))).start, end }
}
