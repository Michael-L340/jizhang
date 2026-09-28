// 进阶统计（统计页底部「进阶分析 ›」进去的那一页）九张图共用的输入 / 输出形状。
// 每张图一个纯函数文件 lib/more/<name>.ts：吃 MoreInput，吐 MoreChart；不碰 store、不碰 DOM、不看 hidden。
import type { Account, Category, Transaction } from '../../types'

export interface MoreInput {
  /**
   * 当前模式那本账：页面传进来的已经是 facade.outerBook 的结果（外页面藏掉的、真实校准都不在），
   * 这里**只准用它**，不许再去看 t.hidden（死规则，CLAUDE.md「里外页面」）。
   */
  txs: Transaction[]
  /** 活跃账户（含白条）；资产 / 白条自己用 compute.splitAccounts 分 */
  accounts: Account[]
  cats: Category[]
  /** 统计页顶上选中的月份 YYYY-MM */
  ym: string
  /** 统计页选中的时间范围（含两端），YYYY-MM-DD */
  start: string
  end: string
  /** 今天 YYYY-MM-DD（传进来而不是自己取，测试才能定住日期） */
  today: string
}

/** 一张卡片上的小数字（「27 天」「4.2 笔」这种） */
export interface MoreTile {
  label: string
  value: string
  /** 点这一格跳去哪（流水页的 query，同 onPoint）；不填 = 不能点 */
  go?: string
}

export interface MoreChart {
  /** 唯一键，也是设置里开关 / 排序用的 id */
  key: string
  title: string
  /**
   * 这张图实际按哪段时间算，写在标题旁边（「25.10–26.9」「26.9」）。
   * 顶上有月份和时间段两个控件，各管几张图——不写出来，用户会把「近一年的流向」当成「9 月的流向」。
   */
  span?: string
  /** 卡片底下一行小字：口径说明，写死的人话 */
  note: string
  /** ECharts option；null = 这张图不用画（只有 tiles，或者没数据） */
  option: object | null
  tiles?: MoreTile[]
  /** 没数据时显示的一句话（有它就不画图） */
  empty?: string
  /** 图的高度（px），不填按 220 */
  height?: number
  /** 点图上某个点要跳去哪（可选）：返回流水页的 query，比如 `ym=2026-09&date=2026-09-12` */
  onPoint?: (dataIndex: number, seriesIndex: number) => string | null
}
