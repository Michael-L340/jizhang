// 进阶分析每张卡标题旁边那行小字：这张图实际算的是哪段时间。
//
// 年份永远带着（和统计页 x 轴同一条规矩，用户 2026-09-08 定）：「25.10–26.9」，不写「10月–9月」。
import { monthOf, monthRange } from '../date'

const ymText = (ym: string) => `${ym.slice(2, 4)}.${+ym.slice(5, 7)}`
const dayText = (d: string) => `${ymText(d)}.${+d.slice(8, 10)}`

/** 从 fromYm 到 toYm 这几个整月：同一个月写「26.9」，否则「25.10–26.9」 */
export function monthSpan(fromYm: string, toYm: string): string {
  return fromYm === toYm ? ymText(fromYm) : `${ymText(fromYm)}–${ymText(toYm)}`
}

/**
 * 一段日期（含两端）。起点是月初、终点是月底或今天（这个月还没过完）→ 按整月写「25.10–26.9」；
 * 否则写到日「26.9.5–26.9.20」——自定义的半截月份写成「26.9」会被当成整个 9 月。
 */
export function rangeSpan(start: string, end: string, today: string): string {
  const wholeMonths = start.slice(8) === '01' && (end === monthRange(monthOf(end)).end || end === today)
  if (wholeMonths) return monthSpan(monthOf(start), monthOf(end))
  return start === end ? dayText(start) : `${dayText(start)}–${dayText(end)}`
}
