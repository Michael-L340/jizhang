// 进阶分析页的十张图：key → 标题 + 怎么算。页面和「自定义」弹层都从这里取，不自己列清单。
//
// 标题在这里写一份静态的，是给「自定义」弹层用的：弹层要列出全部十张，
// 但没打开的图不该为了拿个标题把整本账算一遍。registry.test.ts 守着它和各图自己吐出来的 title 一致。
import { calendar } from './calendar'
import { creditChart } from './credit'
import { habits } from './habits'
import { histogram } from './histogram'
import type { MoreKey } from './layout'
import { race } from './race'
import { radarChart } from './radar'
import { sankeyChart } from './sankey'
import { saving } from './saving'
import type { MoreChart, MoreInput } from './types'
import { waterfall } from './waterfall'
import { weekhour } from './weekhour'

export interface BuildCtx {
  /** 整张图的宽度（px）= 卡片内宽。纯函数量不到屏幕，页面传进来 */
  chartWidth: number
  /** 图里 x 轴能用的宽度（px）：卡片内宽减去 y 轴那列数字 */
  axisWidth: number
}

export interface MoreEntry {
  title: string
  /**
   * 顶上两个控件里，这张图跟着哪个走：
   *   'range' = 时间段按钮（近一年、本月……）；'month' = 只看月份选择器（那个月，或到那个月为止的 12 个月）。
   * 页面据此写「钱的流向按这段时间算」；registry.test.ts 守着它和各图标题旁的区间真的一致。
   */
  scope: 'range' | 'month'
  build: (inp: MoreInput, ctx: BuildCtx) => MoreChart
}

/**
 * Record 而不是数组：漏登记一张，类型检查直接报错。
 * 标题不写「本月」「这个月」「五大类」：翻到 8 月、或者加了第六个一级分类时文不对题；月份写在标题旁的区间里。
 */
export const MORE_CHARTS: Record<MoreKey, MoreEntry> = {
  calendar: { title: '消费日历', scope: 'month', build: (i, c) => calendar(i, c.chartWidth) },
  sankey: { title: '钱的流向', scope: 'range', build: (i) => sankeyChart(i) },
  race: { title: '累计支出 vs 上月', scope: 'month', build: (i) => race(i) },
  waterfall: { title: '钱去哪了', scope: 'month', build: (i, c) => waterfall(i, c.axisWidth) },
  saving: { title: '储蓄率 12 个月', scope: 'month', build: (i) => saving(i) },
  radar: { title: '支出大类对比', scope: 'month', build: (i) => radarChart(i) },
  credit: { title: '白条', scope: 'range', build: (i, c) => creditChart(i, c.axisWidth) },
  weekhour: { title: '什么时候最爱花钱', scope: 'range', build: (i) => weekhour(i) },
  histogram: { title: '单笔多大', scope: 'range', build: (i) => histogram(i) },
  habits: { title: '记账习惯', scope: 'range', build: (i) => habits(i) },
}

/**
 * 顶上时间段按钮旁那句话：现在打开的图里，哪几张跟着它走。null = 一张都没有（按钮换了也没图会变）。
 * 原来写的是「不按月份的图，按这段时间算」，用户得自己猜哪张是「不按月份的图」。
 */
export function rangeHint(keys: readonly MoreKey[]): string | null {
  const titles = keys.filter((k) => MORE_CHARTS[k].scope === 'range').map((k) => `「${MORE_CHARTS[k].title}」`)
  if (!titles.length) return null
  return `${titles.length <= 2 ? titles.join('') : `${titles[0]}等 ${titles.length} 张图`}按这段时间算`
}

/**
 * 这张图怎么接「点一下看明细、再点一下看流水」（components/Chart.tsx 的两种两下点法）：
 *   'axis' = 有直角坐标（xAxis）的：点绘图区任意位置按最近的 x 下标算，折线上比点中圆点好点得多；
 *   'item' = 没有直角坐标的（日历）：得点中某个格子。Chart 的 onAxisClick 靠
 *            containPixel({ gridIndex: 0 }) 判断，没有 grid 的图永远不会触发，所以要走另一条；
 *   null   = 没有 onPoint，或者没有图（只有数字 / 空状态）：不接点击。
 */
export function pointMode(c: MoreChart): 'axis' | 'item' | null {
  if (!c.onPoint || !c.option || c.empty) return null
  return 'xAxis' in c.option ? 'axis' : 'item'
}

/** 统计页那句话，四张图统一：点一下只出提示框，不说的话用户会以为点坏了 */
export const TAP_HINT = '点一下看明细，再点一下看流水。'

/** 卡片底下那行小字：图自己的口径，能点的再补一句怎么点 */
export function noteWithTap(c: MoreChart): string {
  if (!pointMode(c)) return c.note
  const n = c.note.trimEnd()
  return n ? `${n}${/[。！？.!?]$/.test(n) ? '' : '。'}${TAP_HINT}` : TAP_HINT
}

/**
 * 算一张图。某一张图的算法出了错，只让那一张卡说「出错了」，别的卡照常——
 * 不然整页掉进页面级的 ErrorBoundary，九张好好的图跟着一起看不见。
 */
export function buildSafely(k: MoreKey, inp: MoreInput, ctx: BuildCtx): MoreChart {
  try {
    return MORE_CHARTS[k].build(inp, ctx)
  } catch (e) {
    console.error(`进阶分析「${k}」算不出来`, e)
    return { key: k, title: MORE_CHARTS[k].title, note: '', option: null, empty: '这张图算的时候出错了，别的图不受影响' }
  }
}
