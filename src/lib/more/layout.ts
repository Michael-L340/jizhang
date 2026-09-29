// 进阶分析页「自定义」：哪几张图显示、按什么顺序。存在本机 localStorage（jz_more_charts）。
//
// 存的形状是 { order: 全部 key 的顺序, hidden: 不显示的 key }。读回来一律过一遍 normalizeLayout：
// 以后加了新图、删了旧图、或者存的东西坏了，页面都不能崩，也不能少一张图——
//   · 不认识的 key 丢掉（删掉的旧图）；重复的只留第一个；
//   · 缺的 key 补到末尾（新加的图），显不显示按默认来；
//   · 整个形状不对（不是对象、order / hidden 不是数组、JSON 坏了）→ 回到默认。
// 纯函数，不碰 localStorage；读写在页面里用 hooks.usePersistedState。

/**
 * 全部图的 key，也是「恢复默认」时的顺序。
 * 新加的图**只往末尾接**，不插到中间：老用户存过的布局读出来时，缺的图按这个顺序补到末尾（normalizeLayout），
 * 接在末尾的话，没动过顺序的老用户升级后和新装的人看到的清单一模一样（layout.test.ts 守着）。
 */
export const MORE_KEYS = [
  // 第一批（2026-09-28）
  'calendar', 'sankey', 'race', 'waterfall', 'saving', 'radar', 'credit', 'weekhour', 'histogram', 'habits',
  // 第二批（2026-09-29）：默认都不显示，要自己在「自定义」里打开
  'treemap', 'delta', 'position', 'fixed', 'engel', 'bigticket', 'places', 'assets', 'creditplan', 'delay',
] as const
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

// ---------- 「自定义」弹层 ----------
// 二十张图只列标题分不清、也看不出哪几张开着（审阅 #9）：弹层分「显示中 / 没显示」两组，
// 显示中那组的顺序就是页面上从上往下的顺序，箭头只在这一组里挪；没显示那组只有开关。

/** 弹层的两组：显示中（页面上的顺序）、没显示（登记顺序 / 用户排过的顺序） */
export function panelGroups(l: MoreLayout): { on: MoreKey[]; off: MoreKey[] } {
  return { on: shownKeys(l), off: l.order.filter((k) => !isShown(l, k)) }
}

/**
 * 弹层里点开关。
 *   关：原地关掉（toggleKey），挪到没显示那组里它原来的位置；
 *   开：**挪到显示中那组末尾**——页面上排在最后一张，刚打开的图往下一翻就看见，弹层里也是落在显示中那组的最底下。
 *       不像 toggleKey 那样回到它在 order 里的老位置：那样打开一张，它可能插进显示中那组的中间，用户得在二十行里找它去哪了。
 */
export function switchKey(l: MoreLayout, k: MoreKey): MoreLayout {
  if (isShown(l, k)) return toggleKey(l, k)
  const rest = l.order.filter((x) => x !== k)
  let at = 0
  rest.forEach((x, i) => {
    if (isShown(l, x)) at = i + 1
  })
  const order = [...rest.slice(0, at), k, ...rest.slice(at)]
  return { order, hidden: order.filter((x) => x !== k && l.hidden.includes(x)) }
}

/**
 * 弹层里的箭头：在显示中那组里往上（-1）/ 往下（+1）挪一格，**跳过中间夹着的没显示的图**。
 * 用 moveKey 的话，前面紧挨着的是一张关着的图时，点一下只是和它对调，页面上什么都没变，看着像没点上。
 * 已经是显示中那组的头 / 尾、或者这张图没显示，原样返回。
 */
export function moveShown(l: MoreLayout, k: MoreKey, dir: -1 | 1): MoreLayout {
  const on = shownKeys(l)
  const i = on.indexOf(k)
  const j = i + dir
  if (i < 0 || j < 0 || j >= on.length) return l
  const a = l.order.indexOf(k)
  const b = l.order.indexOf(on[j])
  const order = [...l.order]
  ;[order[a], order[b]] = [order[b], order[a]]
  return { order, hidden: order.filter((x) => l.hidden.includes(x)) }
}
