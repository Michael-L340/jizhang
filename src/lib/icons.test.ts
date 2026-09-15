import { describe, expect, it } from 'vitest'
import { GUESSED_ICONS, guessIcon, ICON_GROUPS } from './icons'

describe('按名字猜二级分类的图标', () => {
  it('同一个大类下的二级必须各不相同——原来它们共用一级的图标，连着几行长得一样', () => {
    const 日常 = ['早餐', '午餐', '晚餐', '夜宵', '咖啡奶茶', '零食水果']
    const icons = 日常.map((n) => guessIcon(n))
    expect(icons.every(Boolean)).toBe(true)
    expect(new Set(icons).size).toBe(日常.length)
  })

  it('用户现有的二级分类基本都能猜出来', () => {
    const all = [
      '早餐', '午餐', '晚餐', '夜宵', '咖啡奶茶', '零食水果',
      '聚餐下馆子', '游戏充值', '影音会员', '电影演出', '旅行出游', '运动健身',
      '房租', '水电燃气', '通勤交通', '话费网费', '日用百货', '洗衣理发',
      '服饰鞋包', '数码电器', '礼物人情', '学习充电', '医疗健康', '家居家装',
      '罚款赔偿', '维修损坏', '手续费利息', '代付垫付',
    ]
    const missed = all.filter((n) => !guessIcon(n))
    expect(missed).toEqual([])
  })

  it('按关键词而不是全名匹配，改名了照样认得', () => {
    expect(guessIcon('午饭')).toBe(guessIcon('午餐'))
    expect(guessIcon('打车')).toBe(guessIcon('通勤交通'))
    expect(guessIcon('买衣服')).toBe(guessIcon('服饰鞋包'))
  })

  it('先匹配更具体的词：晚餐是晚餐，不能被「餐」抢走', () => {
    expect(guessIcon('晚餐')).not.toBe(guessIcon('聚餐下馆子'))
    expect(guessIcon('学习充电')).not.toBe(guessIcon('水电燃气'))
    expect(guessIcon('话费网费')).not.toBe(guessIcon('手续费利息'))
  })

  it('猜不出就返回 null，交给调用方退回一级的图标', () => {
    expect(guessIcon('其他')).toBeNull()
    expect(guessIcon('zzz')).toBeNull()
  })

  it('收入分类也认得', () => {
    for (const n of ['工资/实习', '生活费', '奖学金', '理财收益', '退款']) expect(guessIcon(n)).toBeTruthy()
  })
})

describe('图标库', () => {
  const all = ICON_GROUPS.flatMap((g) => g.icons)

  it('没有重复——同一个图标出现两次会让人以为选错了', () => {
    expect(new Set(all).size).toBe(all.length)
  })

  it('数量够用，且每组都不为空', () => {
    expect(all.length).toBeGreaterThanOrEqual(600)
    for (const g of ICON_GROUPS) expect(g.icons.length, g.name).toBeGreaterThan(0)
  })

  it('每一组的标签 emoji 都是本组里的一个——点标签进去就该在第一页看见它', () => {
    for (const g of ICON_GROUPS) expect(g.icons, `${g.name} 的标签 ${g.tab} 不在本组里`).toContain(g.tab)
  })

  it('每一个「猜」得出来的图标都必须在库里，否则用户想改回去时找不到', () => {
    // 抽查几个是不够的：第一版这条只抽了 10 个名字，漏掉了 🍽️ 📶 ↩️ 三个
    for (const g of GUESSED_ICONS) expect(all, `${g} 不在图标库里`).toContain(g)
  })
})

describe('emoji 渲染', () => {
  // Unicode 基本平面里的符号默认是「文字外观」，必须跟一个 U+FE0F 变体选择符才会
  // 渲染成彩色 emoji；少了它，iOS 上会显示成黑白的文字符号，一排彩色图标里格外突兀。
  // 下面这几个是例外：它们的 Emoji_Presentation 属性本来就是 Yes，不带 FE0F 也是彩色的。
  const EMOJI_BY_DEFAULT = [
    '⌚', '⌛', '⏰', '⏳', '☔', '☕', '⚡', '⚪', '⚫', '⚽', '⚾',
    '⛄', '⛅', '⛪', '⛳', '⛵', '⛺', '⛽', '✅', '✨', '❌', '❓', '❗', '➕', '➖', '➗', '⭐',
  ]

  it('该带变体选择符的都带了', () => {
    const all = [...ICON_GROUPS.flatMap((g) => g.icons), ...GUESSED_ICONS]
    for (const e of all) {
      const cps = [...e].map((c) => c.codePointAt(0) ?? 0)
      const needsVs = cps[0] < 0x1f000 && !EMOJI_BY_DEFAULT.includes(e)
      if (needsVs) {
        expect(cps, `${e}（${cps.map((c) => 'U+' + c.toString(16).toUpperCase()).join(' ')}）缺少 U+FE0F`).toContain(0xfe0f)
      }
    }
  })
})

describe('只收 Emoji 14 及以前的字形', () => {
  // iOS 缺字形时画的是豆腐块（▯），不是退回文字——用户选完看着是个方块，会以为自己点错了。
  // 全量比对 Unicode 的 emoji-data 太重（还得把数据文件抄进仓库），这里挡的是
  // 「顺手从网上抄一串新 emoji 进来」这一种：Emoji 15 / 15.1 / 16 新增的码点一个不收。
  // 现成的教训：🪮（U+1FAAE，Emoji 15）在草稿里待过，iOS 16.4 以下全是方块。
  const TOO_NEW = new Set([
    // Emoji 15.0
    0x1fa75, 0x1fa76, 0x1fa77, 0x1fa87, 0x1fa88, 0x1faad, 0x1faae, 0x1faaf,
    0x1fabb, 0x1fabc, 0x1fabd, 0x1fabf, 0x1face, 0x1facf, 0x1fada, 0x1fadb, 0x1fae8, 0x1faf7, 0x1faf8, 0x1f6dc,
    // Emoji 16.0
    0x1fa89, 0x1fa8f, 0x1fabe, 0x1fac6, 0x1fadc, 0x1fae9,
  ])

  it('没有 Emoji 15 以后才有的字形', () => {
    for (const e of [...ICON_GROUPS.flatMap((g) => g.icons), ...ICON_GROUPS.map((g) => g.tab), ...GUESSED_ICONS]) {
      for (const c of e) {
        const cp = c.codePointAt(0) ?? 0
        expect(TOO_NEW.has(cp), `${e}（U+${cp.toString(16).toUpperCase()}）是 Emoji 15 以后才有的`).toBe(false)
      }
    }
  })
})
