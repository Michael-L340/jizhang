// 设置 → 参数页、用电页上跟着参数变的那几行字。纯函数，页面里只管渲染（页面没有单测，逻辑放这里才测得到）。
// 参数本身的登记表、默认值、范围在 lib/prefs.ts。

import { parsePrice, type UsageUnit } from './meter'
import { numSpec, parseNum, presetLabel, type NumPrefSpec } from './prefs'

/** 「一周里哪天最费电」标题旁的小字：常用值用胶囊上的字（「最近半年」），自定义的写「最近 20 周」 */
export function weeksWindowLabel(weeks: number): string {
  const p = presetLabel(numSpec('power.weekdayWeeks'), weeks)
  return p ? `最近${p}` : `最近 ${weeks} 周`
}

/** 「每天用了多少度」标题下的小字：日看几天、周 / 月看几段 */
export function usageWindowLabel(unit: UsageUnit, days: number, segs: number): string {
  return unit === 'day' ? `最近 ${days} 天` : unit === 'week' ? `最近 ${segs} 周 · 周一到周日` : `最近 ${segs} 个月`
}

export interface NumRowView {
  /** 亮着的那格：一个常用值，或「自定义」 */
  lit: number | 'custom'
  /** 「自定义」那格上写什么：值是常用值时写「自定义」，不是时写这个数（「21 天」） */
  customText: string
  /** 下面出不出输入框 */
  showInput: boolean
}

/**
 * 参数页一行的样子（用户 2026-11-09 看效果图选「甲」）：三个常用值的胶囊 + 一格「自定义」。
 * 值不是常用值、或者刚点了「自定义」（customOpen），就亮「自定义」、下面出输入框。
 */
export function numRowView(spec: NumPrefSpec, value: number, customOpen: boolean): NumRowView {
  const isPreset = presetLabel(spec, value) !== null
  const custom = customOpen || !isPreset
  return { lit: custom ? 'custom' : value, customText: isPreset ? '自定义' : `${value} ${spec.unit}`, showInput: custom }
}

/** 输入框旁边那行小字：填坏了变红、说清楚「没改」 */
export function numHint(spec: NumPrefSpec, text: string): { bad: boolean; text: string } {
  const t = text.trim()
  if (t !== '' && parseNum(t, spec) === undefined) return { bad: true, text: `只能填 ${spec.min}–${spec.max} 的整数，没改` }
  return { bad: false, text: `可以填 ${spec.min}–${spec.max}` }
}

/** 失焦 / 回车时存不存：范围内的整数、而且和现在不一样才存（返回要存的数），否则 null */
export function numToSave(spec: NumPrefSpec, text: string, current: number): number | null {
  const n = parseNum(text, spec)
  return n === undefined || n === current ? null : n
}

export const PRICE_HINT = '问房东每度电多少钱'

/** 电价输入框旁边那行小字 */
export function priceHint(text: string): { bad: boolean; text: string } {
  return parsePrice(text) === undefined ? { bad: true, text: '只能填正数，最多四位小数，没改' } : { bad: false, text: PRICE_HINT }
}

/**
 * 电价失焦 / 回车时存什么（prefs 那一行的 value）：清空 → ''（没填）；合法 → 这个数；填坏了、或和现在一样 → null（不存）。
 * current 是现在显示的那个电价（云端没有那一行时是本机兜底的）：没改就别存，本机那份由 store 同步后传上去。
 */
export function priceToSave(text: string, current: number | null): string | null {
  const v = parsePrice(text)
  if (v === undefined || v === current) return null
  return v === null ? '' : String(v)
}

/** 电价输入框里一开始写什么 */
export function priceText(price: number | null): string {
  return price === null ? '' : String(price)
}
