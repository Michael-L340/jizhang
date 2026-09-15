// 「换图标」面板的翻页逻辑。面板本身没法在 node 里跑（没有 DOM），
// 所以每一个「用户看到什么」都必须先变成这里的一个纯函数才测得到。
//
// 输入取用户视角：「面板里有这么几组、一页装 40 个，第 3 页显示的是什么、点第 5 个标签跳到哪」，
// 不拿实现内部的下标当已知条件。每条用例都先证明过会红（变异法写在各自注释里）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildPages,
  firstPageOfGroup,
  groupIndexOfIcon,
  loadRecentIcons,
  pageIndexOf,
  PER_PAGE,
  pushRecent,
  RECENT_KEY,
  RECENT_MAX,
  saveRecentIcons,
  type IconGroup,
} from './iconPages'

/** n 个互不相同的假图标 */
const fake = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`)

const groups: IconGroup[] = [
  { name: '最近用过', tab: '♡', icons: [], virtual: true },
  { name: '我的图', tab: '🖼️', icons: ['img:bag', 'img:lunch'] },
  { name: '主食餐饭', tab: '🍚', icons: ['🍚', ...fake('a', 49)] },
  { name: '饮品甜点', tab: '☕', icons: ['☕', ...fake('b', 31)] },
]

describe('分页', () => {
  // 变异：把 Math.max(1, …) 去掉 → 空的「最近用过」一页都没有，这条红
  it('空组也占一页——不然底部的「最近用过」点下去毫无反应，看着像坏了', () => {
    const pages = buildPages(groups, 40)
    const recent = pages.filter((p) => p.groupIndex === 0)
    expect(recent.length).toBe(1)
    expect(recent[0].items).toEqual([])
    expect(recent[0].pagesInGroup).toBe(1)
  })

  // 变异：把 Math.ceil 改成 Math.floor → 50 个图标只切出 1 页，第 41 个起消失，这条红
  it('一组装不下就往后接，一个图标都不能丢', () => {
    const pages = buildPages(groups, 40)
    const g2 = pages.filter((p) => p.groupIndex === 2)
    expect(g2.length).toBe(2)
    expect(g2.flatMap((p) => p.items)).toEqual(groups[2].icons)
    expect(g2[0].items.length).toBe(40)
    expect(g2[1].items.length).toBe(10)
  })

  // 变异：把 pagesInGroup 写成 pages.length（全局总页数）→ 标题会显示「第 1/7 页」，这条红
  it('每页都知道自己是本组第几页、本组共几页——标题和圆点就靠这两个数', () => {
    const pages = buildPages(groups, 40)
    const g2 = pages.filter((p) => p.groupIndex === 2)
    expect(g2.map((p) => p.pageInGroup)).toEqual([0, 1])
    expect(g2.every((p) => p.pagesInGroup === 2)).toBe(true)
    // 别的组只有一页，它们的 pagesInGroup 不该被全局页数污染
    expect(pages.filter((p) => p.groupIndex === 3).every((p) => p.pagesInGroup === 1)).toBe(true)
  })

  // 变异：把 slice(p * perPage, (p + 1) * perPage) 的起点写成 p * perPage + 1 → 每页漏一个，这条红
  it('切开再拼回来，顺序和内容和原组一模一样', () => {
    const pages = buildPages(groups, 7)
    for (let gi = 0; gi < groups.length; gi++) {
      expect(pages.filter((p) => p.groupIndex === gi).flatMap((p) => p.items), groups[gi].name).toEqual(groups[gi].icons)
    }
  })

  it('默认一页 8 列 × 5 行', () => {
    expect(PER_PAGE).toBe(40)
  })
})

describe('滑到第几页', () => {
  // 变异：把 Math.round 换成 Math.floor → 刚滑过一半时还报上一页，标签慢半拍，这条红
  it('过了半页就算翻过去了——scroll-snap 吸附完成前 scrollLeft 停在两页之间', () => {
    expect(pageIndexOf(0, 400)).toBe(0)
    expect(pageIndexOf(199, 400)).toBe(0)
    expect(pageIndexOf(201, 400)).toBe(1)
    expect(pageIndexOf(400, 400)).toBe(1)
    expect(pageIndexOf(1000, 400)).toBe(3)
  })

  // 变异：去掉 `if (!(pageWidth > 0)) return 0` → 返回 NaN 或 Infinity，页号一崩整个面板空白，这条红
  it('弹层还没量到宽度时返回第 0 页，不能是 NaN', () => {
    expect(pageIndexOf(0, 0)).toBe(0)
    expect(pageIndexOf(500, 0)).toBe(0)
    expect(pageIndexOf(500, NaN)).toBe(0)
  })

  // 变异：去掉 Math.max(0, …) → iOS 的橡皮筋回弹会给出负的 scrollLeft，页号变 -1，这条红
  it('iOS 往左拉出边界（scrollLeft 是负的）还算第 0 页', () => {
    expect(pageIndexOf(-30, 400)).toBe(0)
  })
})

describe('点底部标签跳到哪一页', () => {
  // 变异：把 findIndex 换成 findLastIndex → 点「主食餐饭」落在它的最后一页，这条红
  it('跳到那一组的第一页，不是最后一页', () => {
    const pages = buildPages(groups, 40)
    expect(firstPageOfGroup(pages, 0)).toBe(0)
    expect(firstPageOfGroup(pages, 2)).toBe(2)
    expect(pages[firstPageOfGroup(pages, 2)].pageInGroup).toBe(0)
    expect(firstPageOfGroup(pages, 3)).toBe(4)
  })

  // 变异：把 `i < 0 ? 0 : i` 改成直接 return i → 返回 -1，scrollTo 到负数，面板停在空白处，这条红
  it('没有这一组时退回第 0 页', () => {
    expect(firstPageOfGroup(buildPages(groups, 40), 99)).toBe(0)
  })
})

describe('打开面板停在哪一组', () => {
  // 变异：把「先找真分组」那一轮去掉（只留 findIndex 全量找）→ 落在「最近用过」，这条红
  it('当前图标在「最近用过」里也要停在它自己那一组——历史那一页和这个分类没关系', () => {
    const withRecent: IconGroup[] = [{ ...groups[0], icons: ['☕', '🍚'] }, ...groups.slice(1)]
    expect(groupIndexOfIcon(withRecent, '☕', '主食餐饭')).toBe(3)
  })

  // 变异：把 groupIndexOfIcon 里 `if (icon) { … }` 整块去掉 → 落到 fallback 组（下标 2），这条红
  it('img: 图标停在「我的图」', () => {
    expect(groupIndexOfIcon(groups, 'img:lunch', '主食餐饭')).toBe(1)
  })

  // 变异：把第二轮（含虚拟组的那一次 findIndex）去掉 → 掉回 fallback 组，这条红
  it('只在「最近用过」里还留着的图标（图标库后来把它删了）也要能定位到', () => {
    const withRecent: IconGroup[] = [{ ...groups[0], icons: ['🦖'] }, ...groups.slice(1)]
    expect(groupIndexOfIcon(withRecent, '🦖', '主食餐饭')).toBe(0)
  })

  // 变异：把 fallbackName 那一段改成 return 0 → 没设图标的分类打开是空的「最近用过」，这条红
  it('没设图标就停在 fallback 那一组，而不是第 0 组（第 0 组通常是空的「最近用过」）', () => {
    expect(groupIndexOfIcon(groups, null, '主食餐饭')).toBe(2)
    expect(groupIndexOfIcon(groups, undefined, '主食餐饭')).toBe(2)
    expect(groupIndexOfIcon(groups, '', '主食餐饭')).toBe(2)
  })

  it('连 fallback 那一组都没有时退回第 0 组', () => {
    expect(groupIndexOfIcon(groups, '不存在的图标', '并没有这一组')).toBe(0)
  })
})

describe('最近用过', () => {
  // 变异：把 filter 去掉（改成 [icon, ...list]）→ 同一个图标越选越多，这条红
  it('再选一次只是提到最前面，不会多出一份', () => {
    const after = pushRecent(['🍚', '☕', '🍜'], '☕')
    expect(after).toEqual(['☕', '🍚', '🍜'])
  })

  // 变异：把 [icon, ...rest] 写成 [...rest, icon] → 刚选的排在最后，翻到第二行才看得见，这条红
  it('最新的在最前面', () => {
    expect(pushRecent([], '🍚')).toEqual(['🍚'])
    expect(pushRecent(['🍚'], '☕')[0]).toBe('☕')
  })

  // 变异：把 slice(0, max) 去掉 → 「最近用过」无限长，翻好几页全是历史，这条红
  it('超过上限就截断，留最新的那些', () => {
    const many = fake('x', RECENT_MAX + 5)
    const after = many.reduce((acc, i) => pushRecent(acc, i), [] as string[])
    expect(after.length).toBe(RECENT_MAX)
    expect(after[0]).toBe(many[many.length - 1])
    expect(after).not.toContain(many[0])
  })

  // 变异：把 pushRecent 改成原地 unshift/splice 再 return list → 引用没变，React 不重渲染，这条红
  it('不改原数组——React 的 state 靠引用变没变来决定要不要重画', () => {
    const before = ['🍚', '☕']
    const after = pushRecent(before, '🍜')
    expect(before).toEqual(['🍚', '☕'])
    expect(after).not.toBe(before)
  })
})

describe('最近用过的存取', () => {
  // node 环境没有 localStorage，自己搭一个最小的
  const store = new Map<string, string>()
  beforeEach(() => {
    store.clear()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  // 变异：把 RECENT_KEY 改成别的名字 → 这条红。
  // 键名要钉死字面量而不是拿常量对常量：改名不报错，只是所有人的「最近用过」当场清空
  it('存了能读回来，键名是 iconRecent', () => {
    expect(RECENT_KEY).toBe('iconRecent')
    saveRecentIcons(['🍚', 'img:bag'])
    expect(store.get('iconRecent')).toBeTruthy()
    expect(loadRecentIcons()).toEqual(['🍚', 'img:bag'])
  })

  // 变异：去掉 loadRecentIcons 的 try/catch 或 Array.isArray 判断 → 抛异常，整个分类页白屏，这条红
  it('存储里是坏内容（被人改过、版本不一样）就当没有，不能让分类页崩掉', () => {
    store.set(RECENT_KEY, '不是 JSON')
    expect(loadRecentIcons()).toEqual([])
    store.set(RECENT_KEY, '{"v":1}')
    expect(loadRecentIcons()).toEqual([])
    store.set(RECENT_KEY, '[1, 2, "🍚", null]')
    expect(loadRecentIcons()).toEqual(['🍚'])
  })

  it('没存过就是空的', () => {
    expect(loadRecentIcons()).toEqual([])
  })

  // 变异：去掉 saveRecentIcons 的 try/catch → 无痕模式下选图标直接抛异常，这条红
  it('存储被禁用（无痕模式）时静默——选图标本身不该因此失败', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    })
    expect(() => saveRecentIcons(['🍚'])).not.toThrow()
    expect(loadRecentIcons()).toEqual([])
  })
})
