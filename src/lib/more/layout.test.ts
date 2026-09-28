// 进阶分析页「自定义」：哪几张图显示、什么顺序，存在本机（jz_more_charts）。
//
// 用户视角：「第一次打开看到哪几张」「升级后多了一张新图 / 少了一张旧图，打开看到什么」「存的东西坏了会不会崩」。
// 每条用例的「变异：xxx → 红」都实际改过 layout.ts、跑过、再改回来。
import { describe, expect, it } from 'vitest'
import { defaultLayout, DEFAULT_SHOWN, isShown, MORE_KEYS, moveKey, normalizeLayout, parseLayout, shownKeys, toggleKey, type MoreKey, type MoreLayout } from './layout'

const ALL = [...MORE_KEYS]

describe('第一次打开', () => {
  it('从没存过：只显示消费日历、钱的流向、本月累计三张，其余七张在「自定义」里', () => {
    // 变异：DEFAULT_SHOWN 少写一个 race → 红；defaultLayout 的 hidden 写成 [] → 十张全出来，红
    const l = parseLayout(null)
    expect(shownKeys(l)).toEqual(['calendar', 'sankey', 'race'])
    expect(l.order).toEqual(ALL)
    expect(l.hidden).toHaveLength(7)
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
    expect(l.order).toEqual([...saved.order, 'credit', 'habits'])
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
    expect(moveKey(l0, 'habits', 1)).toBe(l0)
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
    const n = Math.floor(r() * 14)
    for (let i = 0; i < n; i++) order.push(r() < 0.8 ? pick(r, ALL) : pick(r, junk))
    const m = Math.floor(r() * 8)
    for (let i = 0; i < m; i++) hidden.push(r() < 0.8 ? pick(r, ALL) : pick(r, junk))
    return { order, hidden }
  }

  function ok(l: MoreLayout): string | null {
    if (l.order.length !== MORE_KEYS.length || new Set(l.order).size !== MORE_KEYS.length) return 'order 不是十张图的一个排列'
    if (!l.order.every((k) => (MORE_KEYS as readonly string[]).includes(k))) return 'order 里有不认识的'
    if (!l.hidden.every((k) => l.order.includes(k))) return 'hidden 里有不认识的'
    if (new Set(l.hidden).size !== l.hidden.length) return 'hidden 有重复'
    // hidden 按 order 的顺序排：存下来的东西是确定的，两份一样的布局存出来的字节也一样
    if (l.hidden.join() !== l.order.filter((k) => l.hidden.includes(k)).join()) return 'hidden 没按 order 排'
    return null
  }

  it('读出来永远是十张图的一个排列；再读一遍不变；存下去再读回来一模一样', () => {
    // 变异：normalizeLayout 的 hidden 不按 order 排（直接 [...off]）→ 「没按 order 排」红
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
        l = r() < 0.5 ? toggleKey(l, k) : moveKey(l, k, r() < 0.5 ? -1 : 1)
        // 点开关：显示的张数正好 ±1；挪位置：张数不变
        const d = shownKeys(l).length - before
        if (d !== 0 && d !== (was ? -1 : 1)) expect.fail(`第 ${s} 份第 ${step} 步：显示张数变了 ${d}`)
      }
    }
  })

  it('默认显示的那几张确实在默认布局里是开着的，其余关着', () => {
    // 变异：defaultLayout 的 hidden 写成 [] → 七张该关的开着，红
    for (const k of MORE_KEYS) expect(isShown(defaultLayout(), k), k).toBe(DEFAULT_SHOWN.includes(k))
  })
})
