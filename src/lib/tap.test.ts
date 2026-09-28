// 日历「再点一下看流水」：第二下怎么算。输入是「第一下点在哪、第二下点在哪、点中了哪一格」，
// 断言的是「跳走 / 改看那一天 / 没反应」。每条的「变异：… → 红」都实际改过、跑过。
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { itemTapStep, TAP_SLOP_PX, type ArmedTap } from './tap'

// 375 宽的手机上，日历一格 ≈ 5.4 px 宽、10 px 高。第一下点在 9/12 那格（下标 200）的 (150, 40)
const d912: ArmedTap = { seriesIndex: 0, dataIndex: 200, x: 150, y: 40 }
const d913 = { seriesIndex: 0, dataIndex: 201 } // 下面一格（周六 → 周日）
const d919 = { seriesIndex: 0, dataIndex: 206 } // 右边一格（下一周）
const d501 = { seriesIndex: 0, dataIndex: 120 } // 四个多月以前

describe('日历第二下', () => {
  it('第一下点中 9/12：只弹提示框、不跳', () => {
    // 变异：没选中过也直接 go → 红
    expect(itemTapStep(null, { seriesIndex: 0, dataIndex: 200 }, 150, 40)).toEqual({ arm: d912 })
  })

  it('第二下点回同一格 → 跳 9/12（格子比误差大的时候，同一格的另一头也算）', () => {
    // 变异：去掉 `same ||`，只看距离 → 红
    expect(itemTapStep(d912, { seriesIndex: 0, dataIndex: 200 }, 150, 40 + TAP_SLOP_PX + 1)).toEqual({ go: { seriesIndex: 0, dataIndex: 200 } })
  })

  it('第二下手指偏了 3 px，落到 9/13 或 9/19 的格子上 → 还是跳 9/12，不是换成那一天的提示框重新数', () => {
    // 变异：去掉距离判断（改回「必须同一格」）→ 两条都成了 arm，红
    expect(itemTapStep(d912, d913, 150, 43)).toEqual({ go: { seriesIndex: 0, dataIndex: 200 } })
    expect(itemTapStep(d912, d919, 153, 40)).toEqual({ go: { seriesIndex: 0, dataIndex: 200 } })
  })

  it('第二下落在旁边没花钱的空格上（没有数据图形）→ 跳 9/12', () => {
    // 变异：hit 为 null 时直接返回 null（只认点中图形）→ 红
    expect(itemTapStep(d912, null, 147, 45)).toEqual({ go: { seriesIndex: 0, dataIndex: 200 } })
  })

  it('第二下点在四个月以前那一格 → 改看那一天（弹它的提示框），不跳', () => {
    // 变异：选中过之后点哪儿都跳 armed → 红
    expect(itemTapStep(d912, d501, 60, 30)).toEqual({ arm: { ...d501, x: 60, y: 30 } })
  })

  it('离得远的空白处 → 什么都不做，选中的那天留着', () => {
    // 变异：选中过之后，离得远的空白处也当成 go（只要选中过就跳）→ 红
    expect(itemTapStep(d912, null, 290, 70)).toBeNull()
    expect(itemTapStep(null, null, 150, 40)).toBeNull()
  })

  it('Chart.tsx 的日历两下点法走的是这个函数', () => {
    // 页面测不了（没有 DOM），守源码。变异：Chart.tsx 退回自己比「系列:下标」→ 红
    const src = readFileSync(new URL('../components/Chart.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/itemTapStep\(/)
    expect(src).not.toMatch(/itemArmedRef\.current === key/)
  })
})
