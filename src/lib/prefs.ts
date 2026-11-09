// 设置 → 参数（0014，2026-11-09）：用户自己调的几个数，存云端 prefs 表，一项一行。
// 纯函数；读写走 store 的 savePref / removePref（和用电备注同一套待传队列）。
//
// 每一项的 id 是登记表里写死的 uuid（不是随机的）：两台手机改同一项是同一行，按 id 覆盖。
// **登记过的 id 永远不改、不复用**：改了，云端那行就成了没人认的孤儿，这一项悄悄回到默认。
// 新参数只往后接，id 末尾编号 +1（prefs.test.ts 守着不重复）。
//
// 页面上的样子（用户 2026-11-09 看效果图选「甲」）：每项三个常用值的胶囊 + 一格「自定义」，点了出输入框；
// 只收范围内的整数，填坏了不改值。电价是输入框，可以不填。

import { parsePrice } from './meter'
import type { Pref } from '../types'

export type NumPrefKey = 'power.avgDays' | 'power.hourDays' | 'power.weekdayWeeks' | 'power.usageDays' | 'power.usageSegs'
export type PrefKey = NumPrefKey | 'power.price'

export interface NumPrefSpec {
  key: NumPrefKey
  id: string
  /** 没设过 / 设坏了就用它。和改成可调之前写死的那个数一样 */
  def: number
  min: number
  max: number
  /** 胶囊上的几个常用值和上面写的字 */
  presets: readonly (readonly [number, string])[]
  /** 自定义输入框前后的字：「近 [14] 天」 */
  pre: string
  unit: string
  /** 参数页上的名字和一行小字 */
  name: string
  sub: string
}

export const NUM_PREFS: readonly NumPrefSpec[] = [
  {
    key: 'power.avgDays',
    id: '70726566-0000-4000-8000-000000000001',
    def: 14,
    min: 1,
    max: 90,
    presets: [
      [7, '7 天'],
      [14, '14 天'],
      [30, '30 天'],
    ],
    pre: '近',
    unit: '天',
    name: '日均看近几天',
    sub: '首页那一行、「今天」卡、日用量图的虚线、本月预计',
  },
  {
    key: 'power.hourDays',
    id: '70726566-0000-4000-8000-000000000002',
    def: 30,
    min: 1,
    max: 365,
    presets: [
      [7, '7 天'],
      [30, '30 天'],
      [90, '90 天'],
    ],
    pre: '最近',
    unit: '天',
    name: '一天里几点最费电',
    sub: '看最近多少天的读数',
  },
  {
    key: 'power.weekdayWeeks',
    id: '70726566-0000-4000-8000-000000000003',
    def: 26,
    min: 1,
    max: 104,
    presets: [
      [13, '三个月'],
      [26, '半年'],
      [52, '一年'],
    ],
    pre: '最近',
    unit: '周',
    name: '一周里哪天最费电',
    sub: '看最近多久的读数',
  },
  {
    key: 'power.usageDays',
    id: '70726566-0000-4000-8000-000000000004',
    def: 30,
    // 再多手机上一根柱子不到 3 个像素，点不中
    min: 7,
    max: 90,
    presets: [
      [14, '14 天'],
      [30, '30 天'],
      [60, '60 天'],
    ],
    pre: '画',
    unit: '天',
    name: '每天用了多少度 · 按日',
    sub: '画几天的柱子',
  },
  {
    key: 'power.usageSegs',
    id: '70726566-0000-4000-8000-000000000005',
    def: 12,
    min: 3,
    max: 36,
    presets: [
      [6, '6 段'],
      [12, '12 段'],
      [24, '24 段'],
    ],
    pre: '最近',
    unit: '段',
    name: '每天用了多少度 · 按周按月',
    sub: '按周看几周、按月看几个月',
  },
]

/** 电价（元/度）。value '' = 没填；云端一行都没有 = 还没决定（store 拿这台手机上原来存的电价补上，见 store.ts 的 adoptLocalPrice） */
export const PRICE_PREF = { key: 'power.price', id: '70726566-0000-4000-8000-000000000006' } as const

export function numSpec(key: NumPrefKey): NumPrefSpec {
  const s = NUM_PREFS.find((p) => p.key === key)
  if (!s) throw new Error(`没有登记的参数：${key}`)
  return s
}

/** 输入框里的字 → 这一项的值。不是范围内的整数 = undefined（不改，还是原来的数） */
export function parseNum(text: string, spec: NumPrefSpec): number | undefined {
  const s = text.trim()
  if (!/^\d{1,6}$/.test(s)) return undefined
  const n = Number(s)
  return n >= spec.min && n <= spec.max ? n : undefined
}

function rowOf(prefs: readonly Pref[], id: string): Pref | undefined {
  return prefs.find((p) => p.id === id)
}

/** 现在生效的值：没设过、或云端那行解析不了（别的版本写坏的、范围改过的）就是默认 */
export function numPref(prefs: readonly Pref[], key: NumPrefKey): number {
  const spec = numSpec(key)
  const row = rowOf(prefs, spec.id)
  return (row && parseNum(row.value, spec)) ?? spec.def
}

/** 改过（和默认不一样）的有几项，设置页那一行的副标题用 */
export function changedCount(prefs: readonly Pref[]): number {
  return NUM_PREFS.filter((s) => numPref(prefs, s.key) !== s.def).length
}

/** 胶囊上的字；不是常用值就是 null（那格「自定义」上写这个数） */
export function presetLabel(spec: NumPrefSpec, v: number): string | null {
  return spec.presets.find(([n]) => n === v)?.[1] ?? null
}

/** 一个值怎么念：常用值用胶囊上的字（「半年」），别的写「20 周」 */
export function valueLabel(spec: NumPrefSpec, v: number): string {
  return presetLabel(spec, v) ?? `${v} ${spec.unit}`
}

/** 电价：没这一行 = undefined（还没决定）；'' 或解析不了 = null（没填，只显示度数）；否则元/度 */
export function pricePref(prefs: readonly Pref[]): number | null | undefined {
  const row = rowOf(prefs, PRICE_PREF.id)
  if (!row) return undefined
  return parsePrice(row.value) ?? null
}

export function prefRow(id: string, key: PrefKey, value: string, now: string): Pref {
  return { id, key, value, updated_at: now }
}
