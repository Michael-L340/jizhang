// 流水行滑动手势的纯逻辑。守两条：
//   一、外页面下「外面隐藏」这个动作既不出现在清单里、也不生效（死规则，CLAUDE.md「里外页面」）；
//   二、触发判定：竖着滚不算滑、「不用」的那边拖不动、过线才触发。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SWIPE, effectiveSwipe, parseSwipe, SWIPE_LABEL, SWIPE_MAX_PX, SWIPE_TRIGGER_PX, swipeOffset, swipeOptions, swipeOutcome } from './gesture'

describe('外页面下没有「外面隐藏」', () => {
  it('清单：里页面六项，外页面五项且没有 hide', () => {
    // 变异：swipeOptions 不看 mode → 红
    expect(swipeOptions('inner')).toContain('hide')
    expect(swipeOptions('outer')).not.toContain('hide')
    expect(swipeOptions('outer')).toHaveLength(swipeOptions('inner').length - 1)
  })

  it('生效配置：外页面把 hide 当 none，两边各自换；里页面原样返回同一个对象', () => {
    // 变异：effectiveSwipe 只换 left → right 那条红
    const cfg = { left: 'hide', right: 'hide' } as const
    expect(effectiveSwipe(cfg, 'outer')).toEqual({ left: 'none', right: 'none' })
    expect(effectiveSwipe({ left: 'delete', right: 'hide' }, 'outer')).toEqual({ left: 'delete', right: 'none' })
    expect(effectiveSwipe(cfg, 'inner')).toBe(cfg)
    const plain = { left: 'delete', right: 'edit' } as const
    expect(effectiveSwipe(plain, 'outer')).toBe(plain)
  })

  it('设置页和手势组件不许自己写「外面隐藏」四个字，只能从清单和 effectiveSwipe 取', () => {
    // 页面测不了，守源码。变异：Settings 里直接列六个选项 → 红
    const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
    const settings = read('../pages/Settings.tsx')
    expect(settings).not.toMatch(/外面隐藏/)
    expect(settings).toMatch(/swipeOptions\(mode\)/)
    expect(settings).toMatch(/effectiveSwipe\(/)
    const swipe = read('../components/TxSwipe.tsx')
    expect(swipe).not.toMatch(/外面隐藏/)
    expect(swipe).toMatch(/effectiveSwipe\(/)
    expect(swipe).toMatch(/mode === 'inner'/) // 真正切换 hidden 的那一步还要再挡一道
    expect(SWIPE_LABEL.hide).toBe('外面隐藏') // 文案只在这一处
  })
})

describe('触发判定', () => {
  const cfg = DEFAULT_SWIPE
  it('竖着滚不算滑', () => {
    expect(swipeOutcome(-120, 200, cfg)).toBeNull()
    expect(swipeOutcome(120, -130, cfg)).toBeNull()
  })
  it('过线才触发，差一像素都不算', () => {
    expect(swipeOutcome(-SWIPE_TRIGGER_PX, 0, cfg)).toBe('left')
    expect(swipeOutcome(-SWIPE_TRIGGER_PX + 1, 0, cfg)).toBeNull()
    expect(swipeOutcome(SWIPE_TRIGGER_PX, 3, cfg)).toBe('right')
    expect(swipeOutcome(SWIPE_TRIGGER_PX - 1, 0, cfg)).toBeNull()
  })
  it('那一边「不用」就不触发、也拖不动', () => {
    // 变异：swipeOffset 不看 none → 红
    const c = { left: 'none', right: 'edit' } as const
    expect(swipeOutcome(-300, 0, c)).toBeNull()
    expect(swipeOffset(-80, c)).toBe(0)
    expect(swipeOffset(80, c)).toBe(80)
    expect(swipeOffset(400, c)).toBe(SWIPE_MAX_PX)
    expect(swipeOffset(-400, cfg)).toBe(-SWIPE_MAX_PX)
  })
})

describe('配置的读写', () => {
  it('默认左删右编辑；缓存坏了、键缺了、值不认识都退回默认', () => {
    expect(parseSwipe(null)).toEqual(DEFAULT_SWIPE)
    expect(parseSwipe('{')).toEqual(DEFAULT_SWIPE)
    expect(parseSwipe('{"left":"date"}')).toEqual({ left: 'date', right: 'edit' })
    expect(parseSwipe('{"left":"nuke","right":"hide"}')).toEqual({ left: 'delete', right: 'hide' })
  })
})
