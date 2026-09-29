// 进阶分析页「自定义」：哪几张图显示、什么顺序，存在本机（jz_more_charts）。
//
// 用户视角：「第一次打开看到哪几张」「升级后多了一张新图 / 少了一张旧图，打开看到什么」「存的东西坏了会不会崩」。
// 每条用例的「变异：xxx → 红」都实际改过 layout.ts、跑过、再改回来。
import { describe, expect, it } from 'vitest'
import { defaultLayout, DEFAULT_SHOWN, isShown, MORE_KEYS, moveKey, moveShown, normalizeLayout, panelGroups, parseLayout, shownKeys, switchKey, toggleKey, type MoreKey, type MoreLayout } from './layout'

const ALL = [...MORE_KEYS]
/** 第一批（2026-09-28 做好的那十张）和第二批（2026-09-29 整合进来的十张）：照抄一份，不从 MORE_KEYS 推——推出来的就守不住它 */
const FIRST: MoreKey[] = ['calendar', 'sankey', 'race', 'waterfall', 'saving', 'radar', 'credit', 'weekhour', 'histogram', 'habits']
const SECOND: MoreKey[] = ['treemap', 'delta', 'position', 'fixed', 'engel', 'bigticket', 'places', 'assets', 'creditplan', 'delay']

describe('第一次打开', () => {
  it('从没存过：只显示消费日历、钱的流向、本月累计三张，其余十七张（第一批七张 + 第二批十张）在「自定义」里', () => {
    // 变异：DEFAULT_SHOWN 少写一个 race → 红；defaultLayout 的 hidden 写成 [] → 二十张全出来，红
    const l = parseLayout(null)
    expect(shownKeys(l)).toEqual(['calendar', 'sankey', 'race'])
    expect(l.order).toEqual(ALL)
    expect(l.order).toEqual([...FIRST, ...SECOND])
    expect(l.hidden).toHaveLength(17)
  })

  it('存的东西坏了（不是 JSON、不是对象、order / hidden 不是数组）：回到默认，不崩', () => {
    // 页面拿到的是 usePersistedState 已经 JSON.parse 过的值，直接喂 normalizeLayout，没有 parseLayout 那层 try 兜着。
    // 变异：去掉「order / hidden 不是数组就回默认」→ {} 那份在 for…of undefined 上抛错，红
    for (const v of [null, 42, 'abc', [], {}, { order: 'calendar', hidden: [] }, { order: [], hidden: {} }, { order: ['race'], hidden: 'race' }]) {
      expect(normalizeLayout(v), JSON.stringify(v)).toEqual(defaultLayout())
    }
    expect(parseLayout('{')).toEqual(defaultLayout())
  })
})

describe('升级之后', () => {
  it('存的时候还没有「记账习惯」「白条」：补到末尾，按默认不显示；原来的顺序和开关一个不动', () => {
    // 变异：补进来的一律算显示（不看 DEFAULT_SHOWN）→ habits / credit 冒出来，红
    const saved = { order: ['race', 'saving', 'calendar', 'sankey', 'waterfall', 'radar', 'weekhour', 'histogram'], hidden: ['sankey', 'radar', 'weekhour', 'histogram'] }
    const l = parseLayout(JSON.stringify(saved))
    expect(l.order).toEqual([...saved.order, 'credit', 'habits', ...SECOND])
    expect(shownKeys(l)).toEqual(['race', 'saving', 'calendar', 'waterfall'])
  })

  it('默认该显示的那几张要是缺了，补进来是显示的（新加一张默认图时，老用户也看得到）', () => {
    // 变异：缺的一律塞进 hidden → race 看不见，红
    const saved = { order: ['saving', 'calendar'], hidden: [] }
    const l = parseLayout(JSON.stringify(saved))
    expect(shownKeys(l)).toEqual(['saving', 'calendar', 'sankey', 'race'])
  })

  it('删掉了的旧图、拼错的 key、非字符串：丢掉；重复的只留第一个', () => {
    // 变异：known 不去重 → order 里 race 出现两次，红；不过滤不认识的 → 'pie' 留着，红
    const saved = { order: ['pie', 'race', 7, 'race', 'calendar', null], hidden: ['pie', 'calendar', 'calendar'] }
    const l = normalizeLayout(saved)
    expect(l.order.slice(0, 2)).toEqual(['race', 'calendar'])
    expect(l.order).toHaveLength(MORE_KEYS.length)
    expect(new Set(l.order).size).toBe(MORE_KEYS.length)
    expect(isShown(l, 'calendar')).toBe(false)
    expect(isShown(l, 'race')).toBe(true)
  })
})

describe('升级到第二批（二十张）：老用户本机存的是第一批十张时的布局', () => {
  it('调过顺序、开过几张的：第二批十张按登记顺序接在末尾、全部关着；原来的顺序和开关一个不动，打开页面看到的还是原来那几张', () => {
    // 变异：normalizeLayout 补进来的不看 DEFAULT_SHOWN、一律算显示 → 十张新图全冒出来，红
    // 变异：缺的 key 插到最前面（order.unshift）→ 原来的顺序被挤到后面，红
    const mine = { order: ['race', 'saving', 'calendar', 'sankey', 'waterfall', 'radar', 'credit', 'weekhour', 'histogram', 'habits'], hidden: ['sankey', 'radar', 'weekhour'] }
    const l = parseLayout(JSON.stringify(mine))
    expect(l.order).toEqual([...mine.order, ...SECOND])
    expect(l.hidden).toEqual([...mine.hidden, ...SECOND])
    expect(shownKeys(l)).toEqual(['race', 'saving', 'calendar', 'waterfall', 'credit', 'histogram', 'habits'])
    for (const k of SECOND) expect(isShown(l, k), k).toBe(false)
  })

  it('第一批十张全打开过（hidden 是空的）：第二批照样全关着——「不在 hidden 里」不等于「用户要看」', () => {
    // 变异：同上，补进来的一律算显示 → 红
    const l = normalizeLayout({ order: FIRST, hidden: [] })
    expect(shownKeys(l)).toEqual(FIRST)
    expect(l.hidden).toEqual(SECOND)
  })

  it('从没动过「自定义」（存下来的就是第一批的默认布局）：读出来和新装的人看到的一模一样', () => {
    // 新图只往 MORE_KEYS 末尾接：插到中间的话，老用户的新图在末尾、新用户的在中间，「恢复默认」一点清单就跳一下。
    // 变异：MORE_KEYS 里把 treemap 插到 waterfall 后面 → 红
    const oldDefault = { order: FIRST, hidden: FIRST.filter((k) => !['calendar', 'sankey', 'race'].includes(k)) }
    expect(parseLayout(JSON.stringify(oldDefault))).toEqual(defaultLayout())
  })

  it('打开一张新图：它就在清单末尾那一段里，页面上排在原来那几张后面', () => {
    // 变异：缺的 key 插到最前面（order.unshift）→ fixed 排到第一张，红
    const l = toggleKey(parseLayout(JSON.stringify({ order: FIRST, hidden: FIRST.slice(3) })), 'fixed')
    expect(shownKeys(l)).toEqual(['calendar', 'sankey', 'race', 'fixed'])
  })
})

describe('在「自定义」里点', () => {
  const l0 = defaultLayout()

  it('关掉日历：只剩两张；再点一下又回来，还在原来的位置', () => {
    // 变异：toggleKey 打开时把 key 挪到末尾 → 位置变了，红
    const off = toggleKey(l0, 'calendar')
    expect(shownKeys(off)).toEqual(['sankey', 'race'])
    const on = toggleKey(off, 'calendar')
    expect(shownKeys(on)).toEqual(['calendar', 'sankey', 'race'])
    expect(on.order).toEqual(l0.order)
  })

  it('打开储蓄率：出现在它排的位置上（本月累计之后隔一张瀑布图，那张没开）', () => {
    // 变异：toggleKey 打开时把 key 插到最前面 → 储蓄率跑到第一张，红
    expect(shownKeys(toggleKey(l0, 'saving'))).toEqual(['calendar', 'sankey', 'race', 'saving'])
  })

  it('本月累计往上挪一格：排到钱的流向前面；第一张再往上、最后一张再往下，原样不动', () => {
    // 变异：moveKey 不查边界 → 越界换出 undefined，红
    expect(shownKeys(moveKey(l0, 'race', -1))).toEqual(['calendar', 'race', 'sankey'])
    expect(moveKey(l0, 'calendar', -1)).toBe(l0)
    expect(moveKey(l0, MORE_KEYS[MORE_KEYS.length - 1], 1)).toBe(l0)
  })

  it('挪动时开关跟着图走，不跟着位置走', () => {
    // 变异：moveKey 里 hidden 按下标对换 → 红
    const l = moveKey(l0, 'race', 1) // race（开）和 waterfall（关）对调
    expect(isShown(l, 'race')).toBe(true)
    expect(isShown(l, 'waterfall')).toBe(false)
    expect(shownKeys(l)).toEqual(['calendar', 'sankey', 'race'])
  })

  it('不改原来那份（页面拿它比较有没有变）', () => {
    // 变异：toggleKey 关的时候直接 l.hidden.push(k) → 原来那份也变了，红
    const snap = JSON.stringify(l0)
    toggleKey(l0, 'race')
    moveKey(l0, 'race', 1)
    expect(JSON.stringify(l0)).toBe(snap)
  })
})

describe('「自定义」弹层：分两组、打开就排到最后、箭头只在显示中那组里挪', () => {
  const l0 = defaultLayout()

  it('第一次打开弹层：显示中是日历、流向、累计三张；没显示是其余十七张，按登记顺序', () => {
    // 变异：off 组写成 l.hidden 以外的（取反）→ 红
    const g = panelGroups(l0)
    expect(g.on).toEqual(['calendar', 'sankey', 'race'])
    expect(g.off).toEqual(ALL.filter((k) => !DEFAULT_SHOWN.includes(k)))
    expect(g.off).toHaveLength(17)
  })

  it('打开「大额消费」、再打开「储蓄率」：一张接一张排到显示中那组末尾（页面上也是最后两张），不回它们在清单里的老位置', () => {
    // 用 toggleKey 的话储蓄率在清单里排第五，打开后插在累计后面、大额消费前面——用户在弹层里找不到刚点的那张去哪了。
    // 变异：switchKey 打开时直接 toggleKey → 储蓄率排到大额消费前面，红
    const a = switchKey(l0, 'bigticket')
    expect(panelGroups(a).on).toEqual(['calendar', 'sankey', 'race', 'bigticket'])
    const b = switchKey(a, 'saving')
    expect(shownKeys(b)).toEqual(['calendar', 'sankey', 'race', 'bigticket', 'saving'])
    expect(panelGroups(b).off).not.toContain('saving')
    expect(panelGroups(b).off).toHaveLength(15)
  })

  it('关掉「钱的流向」：它回到没显示那组（按清单顺序排在最前）；再打开就排到显示中末尾', () => {
    // 变异：switchKey 关的时候也挪到末尾 → 没显示那组里它跑到最后，红
    const off = switchKey(l0, 'sankey')
    expect(panelGroups(off).on).toEqual(['calendar', 'race'])
    expect(panelGroups(off).off[0]).toBe('sankey')
    expect(shownKeys(switchKey(off, 'sankey'))).toEqual(['calendar', 'race', 'sankey'])
  })

  it('一张都没开的时候打开一张：就它一张', () => {
    // 变异：找不到开着的图就原样返回（`if (!at) return l`）→ 点了没反应、还是一张都没有，红
    let l = l0
    for (const k of shownKeys(l0)) l = switchKey(l, k)
    expect(shownKeys(l)).toEqual([])
    const one = switchKey(l, 'delay')
    expect(shownKeys(one)).toEqual(['delay'])
    expect(one.order).toHaveLength(MORE_KEYS.length)
  })

  it('箭头跳过中间关着的图：关掉「钱的流向」后，「累计」往上一格就排到日历前面（moveKey 只会和关着的流向对调，页面上看不出动静）', () => {
    // 变异：moveShown 直接调 moveKey → 显示中还是日历、累计，红
    const l = switchKey(l0, 'sankey')
    expect(shownKeys(moveShown(l, 'race', -1))).toEqual(['race', 'calendar'])
    // 没显示那组一动不动
    expect(panelGroups(moveShown(l, 'race', -1)).off).toEqual(panelGroups(l).off)
  })

  it('箭头在头尾、或者点的是没显示的图：原样不动（同一个对象，页面不重存）', () => {
    // 变异：去掉边界判断 → on[j] 是 undefined，order 里多出一个 undefined，红
    expect(moveShown(l0, 'calendar', -1)).toBe(l0)
    expect(moveShown(l0, 'race', 1)).toBe(l0)
    expect(moveShown(l0, 'delay', -1)).toBe(l0)
  })
})

// ---------- 不变量 ----------

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

describe('不变量：600 份随机存档 × 随机点 30 下', () => {
  const junk: unknown[] = ['pie', '', 3, null, 'Calendar', 'race ', {}]
  const pick = <T,>(r: () => number, a: T[]) => a[Math.floor(r() * a.length)]

  function randomSaved(r: () => number): unknown {
    const order: unknown[] = []
    const hidden: unknown[] = []
    // 存档长度随便取到比全部图还多几个（带重复、带垃圾），图再加也覆盖得到「存的比认得的还多」
    const n = Math.floor(r() * (MORE_KEYS.length + 4))
    for (let i = 0; i < n; i++) order.push(r() < 0.8 ? pick(r, ALL) : pick(r, junk))
    const m = Math.floor(r() * 8)
    for (let i = 0; i < m; i++) hidden.push(r() < 0.8 ? pick(r, ALL) : pick(r, junk))
    return { order, hidden }
  }

  function ok(l: MoreLayout): string | null {
    if (l.order.length !== MORE_KEYS.length || new Set(l.order).size !== MORE_KEYS.length) return 'order 不是全部图的一个排列'
    if (!l.order.every((k) => (MORE_KEYS as readonly string[]).includes(k))) return 'order 里有不认识的'
    if (!l.hidden.every((k) => l.order.includes(k))) return 'hidden 里有不认识的'
    if (new Set(l.hidden).size !== l.hidden.length) return 'hidden 有重复'
    // hidden 按 order 的顺序排：存下来的东西是确定的，两份一样的布局存出来的字节也一样
    if (l.hidden.join() !== l.order.filter((k) => l.hidden.includes(k)).join()) return 'hidden 没按 order 排'
    return null
  }

  it('读出来永远是全部图的一个排列；再读一遍不变；存下去再读回来一模一样；弹层里点开关、点箭头的结果和手算的一样', () => {
    // 变异：normalizeLayout 的 hidden 不按 order 排（直接 [...off]）→ 「没按 order 排」红
    // 变异：moveShown 在头尾时不原样返回、绕到另一头 → 「挪不动的时候显示中变了」红
    const r = rng(20260928)
    for (let s = 0; s < 600; s++) {
      let l = normalizeLayout(randomSaved(r))
      for (let step = 0; step <= 30; step++) {
        const bad = ok(l)
        if (bad) expect.fail(`第 ${s} 份第 ${step} 步：${bad} ${JSON.stringify(l)}`)
        if (JSON.stringify(normalizeLayout(l)) !== JSON.stringify(l)) expect.fail(`第 ${s} 份：再读一遍变了`)
        if (JSON.stringify(parseLayout(JSON.stringify(l))) !== JSON.stringify(l)) expect.fail(`第 ${s} 份：存了再读变了`)
        const k = pick(r, ALL) as MoreKey
        const before = shownKeys(l).length
        const was = isShown(l, k)
        const onBefore = shownKeys(l)
        const offBefore = panelGroups(l).off
        const op = r()
        const dir = r() < 0.5 ? -1 : 1
        l = op < 0.25 ? toggleKey(l, k) : op < 0.5 ? moveKey(l, k, dir) : op < 0.75 ? switchKey(l, k) : moveShown(l, k, dir)
        // 点开关：显示的张数正好 ±1；挪位置：张数不变
        const d = shownKeys(l).length - before
        if (d !== 0 && d !== (was ? -1 : 1)) expect.fail(`第 ${s} 份第 ${step} 步：显示张数变了 ${d}`)
        const on = shownKeys(l)
        const g = panelGroups(l)
        if (g.on.join() !== on.join() || [...g.on, ...g.off].sort().join() !== [...MORE_KEYS].sort().join()) expect.fail(`第 ${s} 份第 ${step} 步：两组不是全部图的一个划分`)
        if (op >= 0.5 && op < 0.75) {
          // 弹层里点开关：开 → 排到显示中那组末尾、原来开着的顺序不动；关 → 原来开着的少了它、顺序不动
          const wantOn = was ? onBefore.filter((x) => x !== k) : [...onBefore, k]
          if (on.join() !== wantOn.join()) expect.fail(`第 ${s} 份第 ${step} 步：点开关后显示中是 ${on}，该是 ${wantOn}`)
          const wantOff = was ? null : offBefore.filter((x) => x !== k)
          if (wantOff && g.off.join() !== wantOff.join()) expect.fail(`第 ${s} 份第 ${step} 步：打开一张，没显示那组的顺序变了`)
        }
        if (op >= 0.75) {
          // 弹层里的箭头：开着的还是那几张（顺序可以变）、关着的那组一动不动；开着的就一定动了（除非在头尾）
          if ([...on].sort().join() !== [...onBefore].sort().join() || g.off.join() !== offBefore.join()) expect.fail(`第 ${s} 份第 ${step} 步：箭头把开关 / 没显示那组动了`)
          const i = onBefore.indexOf(k)
          const moved = i >= 0 && i + dir >= 0 && i + dir < onBefore.length
          if (moved && on[i + dir] !== k) expect.fail(`第 ${s} 份第 ${step} 步：${k} 该挪到第 ${i + dir} 个，实际 ${on}`)
          if (!moved && on.join() !== onBefore.join()) expect.fail(`第 ${s} 份第 ${step} 步：挪不动的时候显示中变了`)
        }
      }
    }
  })

  it('默认显示的那几张确实在默认布局里是开着的，其余关着', () => {
    // 变异：defaultLayout 的 hidden 写成 [] → 十七张该关的开着，红
    for (const k of MORE_KEYS) expect(isShown(defaultLayout(), k), k).toBe(DEFAULT_SHOWN.includes(k))
  })
})
