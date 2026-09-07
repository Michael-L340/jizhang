// 全项目唯一的数据形状定义。改字段先改这里，再跑 npm run check 看哪里受影响。

export type TxType = 'expense' | 'income' | 'transfer' | 'adjust'
export type CatKind = 'expense' | 'income'

export interface Account {
  id: string
  name: string
  /** credit = 白条：余额为负表示欠款，下单记支出、还款记转账 */
  kind: 'bank' | 'wallet' | 'credit'
  sort: number
  is_archived: boolean
  /**
   * 白条每月几号还款。到期日 = 下单日之后最近的那个还款日（京东 17、花呗和美团 1）。
   * null = 没有固定还款日（拼多多先用后付逐笔扣款），未结清的一律算进本月应还。
   * 1–31，遇到短月由 date.ts 落到当月最后一天。
   */
  repay_day: number | null
}

export interface Category {
  id: string
  kind: CatKind
  parent_id: string | null // null = 一级分类
  name: string
  icon: string | null
  sort: number
  is_archived: boolean
  /** 含义说明，如「通勤、水电、房租」 */
  note: string | null
}

/** 金额单位：分（整数）。只有 adjust 类型允许为负或为 0。 */
export interface Transaction {
  id: string
  date: string // YYYY-MM-DD，北京时间自然日
  type: TxType
  amount: number
  /** 可为空：expense/income 允许不指定账户（不影响任何账户余额）；transfer/adjust 必填 */
  account_id: string | null
  to_account_id: string | null // 仅 transfer
  category_id: string | null // 仅 expense / income
  note: string | null
  /** 白条分期期数，只对白条账户上的支出有意义；null 按 1 期算。第 1 期在下单后最近的还款日，之后每期 +1 个月 */
  installments: number | null
  /**
   * 这笔还款结清了哪几单，存被结清的支出 id。只对「转进白条账户」的转账有意义。
   * 挂在还款这一侧：一次还款只写一条记录，删掉它结清关系跟着消失。
   * 只对「一次还清」的订单用；分期订单按账单走，不参与勾选。指向已删记录的 id 显示时忽略。
   */
  settles: string[] | null
  created_at: string // ISO
}

export interface Snapshot {
  accounts: Account[]
  categories: Category[]
  transactions: Transaction[]
}

export const TX_TYPE_LABEL: Record<TxType, string> = {
  expense: '支出',
  income: '收入',
  transfer: '转账',
  adjust: '校准',
}
