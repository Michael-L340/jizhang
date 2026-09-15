// 「换图标」面板的分页。像微信表情包那样：底下一排分组标签，左右滑翻页，页码圆点。
//
// 为什么要把这些算成纯函数、而不是在组件里边滑边算：面板的每一个行为都是「第几组第几页」
// 的函数（标签高亮、圆点、标题、点标签跳到哪），滑动本身是 DOM 的事，但页表不是。
// 单测跑在 node 里没有 DOM，逻辑留在组件里就一条都测不到（CLAUDE.md 的测试纪律）。
//
// 一页固定 8 列 × 5 行 = 40 个：面板高度写死，图标少的组也占满一页，
// 翻页时格子不会忽高忽低（高度会跳的话 scroll-snap 的吸附点跟着变，滑一下能弹回去）。

export interface IconGroup {
  name: string
  /** 底部标签栏上的代表 emoji */
  tab: string
  icons: string[]
  /**
   * 这一组装的是「历史」而不是某一类图标的归属地——只有「最近用过」是。
   * 定位初始分组时要跳过它：一个 emoji 同时在「最近用过」和它自己那一组里时，
   * 该落在它自己那一组，否则点开看到的是一片和当前分类无关的历史。
   * 「我的图」不算：`img:` 图标本来就只住在那里。
   */
  virtual?: boolean
}

export interface IconPage {
  /** 在传进来的 groups 里的下标 */
  groupIndex: number
  /** 在本组内是第几页，从 0 起 */
  pageInGroup: number
  /** 本组共几页 */
  pagesInGroup: number
  items: string[]
}

/** 8 列 × 5 行 */
export const PER_PAGE = 40

/** 「最近用过」最多留几个：正好一行八个 × 两行，第三行起就不是「最近」了 */
export const RECENT_MAX = 16

export const RECENT_KEY = 'iconRecent'

/**
 * 把每一组切成若干页。
 * 空组也要出一页（items 为空）——「最近用过」一开始就是空的，
 * 不给它页的话底部标签点下去没有任何反应，看起来像坏了。
 */
export function buildPages(groups: IconGroup[], perPage = PER_PAGE): IconPage[] {
  const pages: IconPage[] = []
  groups.forEach((g, groupIndex) => {
    const pagesInGroup = Math.max(1, Math.ceil(g.icons.length / perPage))
    for (let p = 0; p < pagesInGroup; p++) {
      pages.push({ groupIndex, pageInGroup: p, pagesInGroup, items: g.icons.slice(p * perPage, (p + 1) * perPage) })
    }
  })
  return pages
}

/**
 * 滑到哪一页了。四舍五入而不是向下取整：scroll-snap 吸附完成前 scrollLeft 停在两页之间，
 * 向下取整会让「刚过一半」还显示上一页，标签跟着慢半拍。
 */
export function pageIndexOf(scrollLeft: number, pageWidth: number): number {
  if (!(pageWidth > 0)) return 0
  return Math.max(0, Math.round(scrollLeft / pageWidth))
}

/** 某一组的第一页在 pages 里的下标；没有这一组时退回第 0 页 */
export function firstPageOfGroup(pages: IconPage[], groupIndex: number): number {
  const i = pages.findIndex((p) => p.groupIndex === groupIndex)
  return i < 0 ? 0 : i
}

/**
 * 打开面板时该停在哪一组。
 * 先在真分组里找（img: 只可能在「我的图」这个虚拟组里，所以第二轮再找全部），
 * 都找不到就用 fallbackName 那一组，再不行就第 0 组。
 */
export function groupIndexOfIcon(groups: IconGroup[], icon: string | null | undefined, fallbackName: string): number {
  if (icon) {
    const real = groups.findIndex((g) => !g.virtual && g.icons.includes(icon))
    if (real >= 0) return real
    const any = groups.findIndex((g) => g.icons.includes(icon))
    if (any >= 0) return any
  }
  const fb = groups.findIndex((g) => g.name === fallbackName)
  return fb < 0 ? 0 : fb
}

/** 刚用过的排到最前面，去重，超过 max 就截断。原数组不动（React 的 state 要新引用） */
export function pushRecent(list: string[], icon: string, max = RECENT_MAX): string[] {
  return [icon, ...list.filter((x) => x !== icon)].slice(0, max)
}

/** 读「最近用过」。存储被禁用、内容被人改坏都当没有——一个图标面板不值得为此崩掉 */
export function loadRecentIcons(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : []
  } catch {
    return []
  }
}

export function saveRecentIcons(list: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list))
  } catch {
    /* 存储被禁用时只影响「最近用过」，不影响选图标本身 */
  }
}
