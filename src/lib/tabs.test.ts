// 底部「统计」标签点下去去哪。输入是「现在在哪、上次在统计标签下停在哪」。
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isStatsPath, statsTabTarget } from './tabs'

describe('「统计」标签点下去去哪', () => {
  it('在进阶分析点图跳去流水，看完点「统计」→ 回进阶分析（接着看刚才那张卡），不是统计页', () => {
    // 变异：statsTabTarget 永远返回 '/stats'（改前的行为）→ 红
    expect(statsTabTarget('/ledger', '/stats/more')).toBe('/stats/more')
  })

  it('人就在进阶分析，点「统计」→ 回统计页首页；在统计页首页 → 还是它（TabBar 那边再点一次是回到顶上）', () => {
    // 变异：不看现在在哪、只看上次 → 在进阶分析点「统计」原地不动，红
    expect(statsTabTarget('/stats/more', '/stats/more')).toBe('/stats')
    expect(statsTabTarget('/stats', '/stats')).toBe('/stats')
  })

  it('上次停在统计页首页、或者从没去过 → 统计页首页', () => {
    // 变异：last 不校验（任何路径都照跳）→ 下面 '/accounts' 那条红
    expect(statsTabTarget('/', '/stats')).toBe('/stats')
    expect(statsTabTarget('/', null)).toBe('/stats')
    expect(statsTabTarget('/', '/accounts')).toBe('/stats')
    expect(isStatsPath('/statsx')).toBe(false)
  })

  it('TabBar 用的是这个函数，而且每次路由变了都记下统计标签下停在哪', () => {
    // 页面测不了（没有 DOM），守源码。变异：TabBar 的统计标签写回 to={t.to} → 红
    const src = readFileSync(new URL('../components/TabBar.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/statsTabTarget\(pathname, lastStats\.current\)/)
    expect(src).toMatch(/if \(isStatsPath\(pathname\)\) lastStats\.current = pathname/)
  })
})

describe('从进阶分析跳去流水、再回来：停在原来那张卡上', () => {
  // 页面测不了（没有 DOM），守源码。
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

  it('只有从统计页入口卡进来才滚回顶上；别的路回来（点「统计」、系统返回）滚回上次的位置', () => {
    // 变异：StatsMore 退回每次挂载都 scrollTo({ top: 0 })（改前的写法）→ 红
    // 变异：入口卡不带 state.fromEntry → 红
    expect(read('../pages/Stats.tsx')).toMatch(/nav\('\/stats\/more', \{ state: \{ fromEntry: true \} \}\)/)
    const src = read('../pages/StatsMore.tsx')
    expect(src).toMatch(/if \(fromEntry\) savedScroll = 0/)
    expect(src).toMatch(/el\.scrollTo\(\{ top: savedScroll \}\)/)
    expect(src).not.toMatch(/scrollTo\(\{ top: 0 \}\)/)
    // 进来之后把记号擦掉，系统返回回到这一条时不再当成「从入口进来」
    expect(src).toMatch(/if \(fromEntry\) nav\(loc\.pathname, \{ replace: true, state: null \}\)/)
  })
})
