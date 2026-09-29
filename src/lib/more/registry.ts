// 进阶分析页的全部图（两批共二十张）：key → 标题 + 怎么算。页面和「自定义」弹层都从这里取，不自己列清单。
//
// 标题在这里写一份静态的，是给「自定义」弹层用的：弹层要列出全部二十张，
// 但没打开的图不该为了拿个标题把整本账算一遍。registry.test.ts 守着它和各图自己吐出来的 title 一致。
import type { ColorOf } from './acctcolor'
import { assetsChart } from './assets'
import { bigticket } from './bigticket'
import { calendar } from './calendar'
import { creditChart } from './credit'
import { creditPlanChart } from './creditplan'
import { delay } from './delay'
import { delta } from './delta'
import { engel } from './engel'
import { fixedChart } from './fixed'
import { habits } from './habits'
import { histogram } from './histogram'
import type { MoreKey } from './layout'
import { places } from './places'
import { positionChart } from './position'
import { race } from './race'
import { radarChart } from './radar'
import { sankeyChart } from './sankey'
import { saving } from './saving'
import { treemap } from './treemap'
import type { MoreChart, MoreInput } from './types'
import { waterfall } from './waterfall'
import { weekhour } from './weekhour'

export interface BuildCtx {
  /** 整张图的宽度（px）= 卡片内宽。纯函数量不到屏幕，页面传进来 */
  chartWidth: number
  /** 图里 x 轴能用的宽度（px）：卡片内宽减去 y 轴那列数字 */
  axisWidth: number
  /**
   * 账户名 → 品牌色（按账户分色的「资产结构变化」「白条未来负担」用）。
   * 品牌色在 components/AccountIcon 的 accountColor 里，lib 不许往上 import components，由页面传进来；
   * 不传（测试）就用 palette.CHART 起的同色系。
   */
  colorOf?: ColorOf
}

export interface MoreEntry {
  title: string
  /**
   * 「自定义」弹层里标题下那行 11px 小字：一句话说这张图画的是什么（「大类→二级，面积=金额」）。
   * 二十行只有标题分不清哪张是哪张（审阅 #9）。要短，手机上一行放得下（registry.test.ts 量着宽度）；
   * 这一页外页面下照常打开，也不许出现「隐」「外页面」「外面」（同一个测试守着）。
   */
  desc: string
  /**
   * 顶上两个控件里，这张图跟着哪个走：
   *   'range' = 时间段按钮（近一年、本月……）；'month' = 只看月份选择器（那个月，或到那个月为止的 12 个月）；
   *   'now'   = 两个都不管，永远从今天往后看（白条未来负担：还没到期的账，和翻到哪个月、选哪段时间都没关系）。
   * 页面据此写「钱的流向按这段时间算」；registry.test.ts 守着它和各图标题旁的区间真的一致。
   */
  scope: 'range' | 'month' | 'now'
  build: (inp: MoreInput, ctx: BuildCtx) => MoreChart
}

/**
 * Record 而不是数组：漏登记一张，类型检查直接报错。
 * 标题不写「本月」「这个月」「五大类」：翻到 8 月、或者加了第六个一级分类时文不对题；月份写在标题旁的区间里。
 */
export const MORE_CHARTS: Record<MoreKey, MoreEntry> = {
  calendar: { title: '消费日历', desc: '每天花了多少，越红花得越多', scope: 'month', build: (i, c) => calendar(i, c.chartWidth) },
  sankey: { title: '钱的流向', desc: '钱从哪个账户出去、花进了哪类', scope: 'range', build: (i) => sankeyChart(i) },
  race: { title: '累计支出 vs 上月', desc: '按几号累计，和上月同期比', scope: 'month', build: (i) => race(i) },
  waterfall: { title: '钱去哪了', desc: '收入一段段扣掉支出，剩下是结余', scope: 'month', build: (i, c) => waterfall(i, c.axisWidth) },
  saving: { title: '储蓄率 12 个月', desc: '每月存下了收入的几成', scope: 'month', build: (i) => saving(i) },
  radar: { title: '支出大类对比', desc: '各大类所选月份和上月比', scope: 'month', build: (i) => radarChart(i) },
  credit: { title: '白条', desc: '每月月底白条欠多少', scope: 'range', build: (i, c) => creditChart(i, c.axisWidth) },
  weekhour: { title: '什么时候最爱花钱', desc: '星期几、几点花得最多', scope: 'range', build: (i) => weekhour(i) },
  histogram: { title: '单笔多大', desc: '每笔多少钱，按金额分档数笔数', scope: 'range', build: (i) => histogram(i) },
  habits: { title: '记账习惯', desc: '连续记账几天、每天记几笔', scope: 'range', build: (i) => habits(i) },
  // ---- 第二批（默认都不显示） ----
  treemap: { title: '支出版图', desc: '大类→二级，面积=金额', scope: 'range', build: (i) => treemap(i) },
  delta: { title: '环比涨跌榜', desc: '比上月多花、少花最多的分类', scope: 'month', build: (i, c) => delta(i, c.chartWidth) },
  position: { title: '所选月份在历史里的位置', desc: '所选月份和往前 12 个月同期比', scope: 'month', build: (i) => positionChart(i) },
  fixed: { title: '固定开销', desc: '每月都有、金额差不多的开销', scope: 'month', build: (i) => fixedChart(i) },
  // 找不到名字像吃饭的分类时，卡片上的标题会换成「<花得最多的那一类>占多少」；这里是「自定义」里列的那个
  engel: { title: '吃饭占多少', desc: '吃饭占支出的几成，按月看', scope: 'month', build: (i, c) => engel(i, c.axisWidth) },
  bigticket: { title: '大额消费', desc: '500 元以上的单笔，圈越大越贵', scope: 'range', build: (i, c) => bigticket(i, c.chartWidth) },
  places: { title: '备注里常写的', desc: '支出备注拆成词，数各出现几次', scope: 'range', build: (i) => places(i) },
  assets: { title: '资产结构变化', desc: '各资产账户月底余额叠在一起', scope: 'range', build: (i, c) => assetsChart(i, { axisWidth: c.axisWidth, chartWidth: c.chartWidth, colorOf: c.colorOf }) },
  creditplan: { title: '白条未来负担', desc: '往后 12 个月每月要还多少白条', scope: 'now', build: (i, c) => creditPlanChart(i, { axisWidth: c.axisWidth, chartWidth: c.chartWidth, colorOf: c.colorOf }) },
  delay: { title: '补记延迟', desc: '花完钱多久才记上', scope: 'range', build: (i) => delay(i) },
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
 *   'axis' = 有直角坐标（xAxis）的：点绘图区任意位置按最近的类目下标算，折线上比点中圆点好点得多。
 *            类目轴在哪边取哪边（lib/tap.ts 的 categoryAxisOf）：横着的条形图（环比涨跌榜）取的是 y 的下标；
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
 * 不然整页掉进页面级的 ErrorBoundary，别的好好的图跟着一起看不见。
 */
export function buildSafely(k: MoreKey, inp: MoreInput, ctx: BuildCtx): MoreChart {
  try {
    return MORE_CHARTS[k].build(inp, ctx)
  } catch (e) {
    console.error(`进阶分析「${k}」算不出来`, e)
    return { key: k, title: MORE_CHARTS[k].title, note: '', option: null, empty: '这张图算的时候出错了，别的图不受影响' }
  }
}
