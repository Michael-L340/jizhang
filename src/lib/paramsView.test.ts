// 参数页、用电页上跟着参数变的字。问的是「页面上看到什么」。
import { describe, expect, it } from 'vitest'
import { numHint, numRowView, numToSave, PRICE_HINT, priceHint, priceText, priceToSave, usageWindowLabel, weeksWindowLabel } from './paramsView'
import { effectivePrice } from './powerPrice'
import { numSpec, PRICE_PREF, prefRow } from './prefs'

const AVG = numSpec('power.avgDays')
const AT = '2026-11-09T05:00:00.000Z'

describe('用电页上跟着参数变的小字', () => {
  it('哪天最费电：常用值写「最近半年」「最近三个月」，自定义的写「最近 20 周」', () => {
    // 变异：一律写「最近 N 周」→ 默认时成了「最近 26 周」，和改之前的「最近半年」对不上，红
    expect(weeksWindowLabel(26)).toBe('最近半年')
    expect(weeksWindowLabel(13)).toBe('最近三个月')
    expect(weeksWindowLabel(52)).toBe('最近一年')
    expect(weeksWindowLabel(20)).toBe('最近 20 周')
  })
  it('每天用了多少度：日写天数，周 / 月写段数；默认和改之前一字不差', () => {
    expect(usageWindowLabel('day', 30, 12)).toBe('最近 30 天')
    expect(usageWindowLabel('week', 30, 12)).toBe('最近 12 周 · 周一到周日')
    expect(usageWindowLabel('month', 30, 12)).toBe('最近 12 个月')
    expect(usageWindowLabel('day', 60, 24)).toBe('最近 60 天')
    expect(usageWindowLabel('month', 60, 24)).toBe('最近 24 个月')
  })
})

describe('参数页一行：三个常用值 + 自定义', () => {
  it('值是常用值：那格亮，「自定义」那格写「自定义」，不出输入框', () => {
    expect(numRowView(AVG, 14, false)).toEqual({ lit: 14, customText: '自定义', showInput: false })
  })
  it('值不是常用值：「自定义」那格亮、写着这个数，出输入框', () => {
    // 变异：customText 一律写「自定义」→ 看不出现在是几天，红
    expect(numRowView(AVG, 21, false)).toEqual({ lit: 'custom', customText: '21 天', showInput: true })
  })
  it('刚点了「自定义」：即使现在是常用值，也亮「自定义」、出输入框', () => {
    expect(numRowView(AVG, 14, true)).toEqual({ lit: 'custom', customText: '自定义', showInput: true })
  })
  it('输入框旁的小字：填坏了变红、说清楚没改；空着不算坏', () => {
    expect(numHint(AVG, '')).toEqual({ bad: false, text: '可以填 1–90' })
    expect(numHint(AVG, '21')).toEqual({ bad: false, text: '可以填 1–90' })
    expect(numHint(AVG, '0')).toEqual({ bad: true, text: '只能填 1–90 的整数，没改' })
    expect(numHint(AVG, '1.5').bad).toBe(true)
    expect(numHint(numSpec('power.usageDays'), '5')).toEqual({ bad: true, text: '只能填 7–90 的整数，没改' })
  })
  it('失焦 / 回车才存：范围内、和现在不一样才存；坏的、一样的不存', () => {
    // 变异：去掉「和现在一样不存」→ 什么都没改点一下框再点走也发一次请求，红
    expect(numToSave(AVG, '21', 14)).toBe(21)
    expect(numToSave(AVG, ' 7 ', 14)).toBe(7)
    expect(numToSave(AVG, '14', 14)).toBeNull()
    expect(numToSave(AVG, '200', 14)).toBeNull()
    expect(numToSave(AVG, '', 14)).toBeNull()
  })
})

describe('参数页的电价', () => {
  it('清空 = 存空串（没填）；合法的数照存；填坏了、和现在一样都不存', () => {
    // 变异：清空时不存（当成填坏了）→ 清不掉电价，红
    expect(priceToSave('', 0.56)).toBe('')
    expect(priceToSave(' 0.6 ', 0.56)).toBe('0.6')
    expect(priceToSave('0.56', 0.56)).toBeNull()
    expect(priceToSave('', null)).toBeNull()
    expect(priceToSave('abc', 0.56)).toBeNull()
    expect(priceToSave('-1', 0.56)).toBeNull()
  })
  it('小字和框里的初值', () => {
    expect(priceHint('')).toEqual({ bad: false, text: PRICE_HINT })
    expect(priceHint('1.23456').bad).toBe(true)
    expect(priceText(null)).toBe('')
    expect(priceText(0.56)).toBe('0.56')
  })
  it('现在生效的电价：云端有那一行听云端的（空串 = 没填，不再读本机的），没有那一行才用这台手机以前存的', () => {
    // 变异：云端 '' 也退回本机的 → 清空了电价，刷新又冒出来，红
    const local = () => 0.5
    expect(effectivePrice([], local)).toBe(0.5)
    expect(effectivePrice([], () => null)).toBeNull()
    expect(effectivePrice([prefRow(PRICE_PREF.id, PRICE_PREF.key, '0.6', AT)], local)).toBe(0.6)
    expect(effectivePrice([prefRow(PRICE_PREF.id, PRICE_PREF.key, '', AT)], local)).toBeNull()
  })
})
