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
    expect(all.length).toBeGreaterThanOrEqual(150)
    for (const g of ICON_GROUPS) expect(g.icons.length, g.name).toBeGreaterThan(0)
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
  const EMOJI_BY_DEFAULT = ['⌚', '☕', '⚡', '⚽', '⛽', '⭐']

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
