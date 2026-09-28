// 进阶分析页「自定义」：哪几张图显示、按什么顺序。存在本机 localStorage（jz_more_charts）。
//
// 存的形状是 { order: 全部 key 的顺序, hidden: 不显示的 key }。读回来一律过一遍 normalizeLayout：
// 以后加了新图、删了旧图、或者存的东西坏了，页面都不能崩，也不能少一张图——
//   · 不认识的 key 丢掉（删掉的旧图）；重复的只留第一个；
//   · 缺的 key 补到末尾（新加的图），显不显示按默认来；
//   · 整个形状不对（不是对象、order / hidden 不是数组、JSON 坏了）→ 回到默认。
// 纯函数，不碰 localStorage；读写在页面里用 hooks.usePersistedState。

/** 十张图的 key，也是「恢复默认」时的顺序 */
export const MORE_KEYS = ['calendar', 'sankey', 'race', 'waterfall', 'saving', 'radar', 'credit', 'weekhour', 'histogram', 'habits'] as const
export type MoreKey = (typeof MORE_KEYS)[number]

/** 第一次打开默认显示的三张，其余要自己在「自定义」里打开 */
export const DEFAULT_SHOWN: readonly MoreKey[] = ['calendar', 'sankey', 'race']

export const LAYOUT_STORAGE_KEY = 'jz_more_charts'

export interface MoreLayout {
  order: MoreKey[]
  hidden: MoreKey[]
}

export function isMoreKey(k: unknown): k is MoreKey {
  return typeof k === 'string' && (MORE_KEYS as readonly string[]).includes(k)
}

export function defaultLayout(): MoreLayout {
  return { order: [...MORE_KEYS], hidden: MORE_KEYS.filter((k) => !DEFAULT_SHOWN.includes(k)) }
}

/** 认得的、去重（留第一个） */
function known(a: unknown[]): MoreKey[] {
  const out: MoreKey[] = []
  for (const k of a) if (isMoreKey(k) && !out.includes(k)) out.push(k)
  return out
}

/** 任意值 → 一份合法的布局 */
export function normalizeLayout(v: unknown): MoreLayout {
  if (typeof v !== 'object' || v === null) return defaultLayout()
  const o = v as { order?: unknown; hidden?: unknown }
  if (!Array.isArray(o.order) || !Array.isArray(o.hidden)) return defaultLayout()
  const order = known(o.order)
  const off = new Set(known(o.hidden))
  for (const k of MORE_KEYS) {
    if (order.includes(k)) continue
    order.push(k)
    // 存的时候还没有这张图：显不显示按默认来，不能因为「不在 hidden 里」就当成用户要看
    if (!DEFAULT_SHOWN.includes(k)) off.add(k)
  }
  return { order, hidden: order.filter((k) => off.has(k)) }
}

/** localStorage 里的原文 → 布局。null（从没存过）、坏 JSON 都回到默认 */
export function parseLayout(raw: string | null): MoreLayout {
  if (raw === null) return defaultLayout()
  try {
    return normalizeLayout(JSON.parse(raw))
  } catch {
    return defaultLayout()
  }
}

export function isShown(l: MoreLayout, k: MoreKey): boolean {
  return !l.hidden.includes(k)
}

/** 要画的那几张，按排好的顺序 */
export function shownKeys(l: MoreLayout): MoreKey[] {
  return l.order.filter((k) => isShown(l, k))
}

/** 开 ↔ 关 */
export function toggleKey(l: MoreLayout, k: MoreKey): MoreLayout {
  const off = isShown(l, k) ? [...l.hidden, k] : l.hidden.filter((x) => x !== k)
  return { order: l.order, hidden: l.order.filter((x) => off.includes(x)) }
}

/** 往上（-1）/ 往下（+1）挪一格；已经在头 / 尾就原样返回 */
export function moveKey(l: MoreLayout, k: MoreKey, dir: -1 | 1): MoreLayout {
  const i = l.order.indexOf(k)
  const j = i + dir
  if (i < 0 || j < 0 || j >= l.order.length) return l
  const order = [...l.order]
  ;[order[i], order[j]] = [order[j], order[i]]
  return { order, hidden: order.filter((x) => l.hidden.includes(x)) }
}
