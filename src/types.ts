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
  /**
   * 京东白条那种规矩：**这个还款周期里已经还过款之后再下的单，算进下一期**。
   * 平台账单已经出了，新单只能进下一期账单，到期日顺延一个还款日。
   *
   * 只有京东这样（用户 2026-09-09 实测），所以做成账户上的开关而不是全局规则；
   * 也不按账户名判「包含京东」——改个名字行为就会静默变掉。
   * null / false = 不启用。`repay_day` 为空的账户没有周期，这个开关对它没意义。
   *
   * App 判「有没有还过款」只看你自己记的那笔转账（银行 → 白条），读不到平台账单。
   */
  defer_after_repay: boolean | null
  /**
   * 0007，**已退役**（2026-09-27 里外校准分家）：老模型「外页面显示的余额 = 真实余额 + 这个偏移量」。
   * 新模型改用 facade_adjusts 表（见 FacadeAdjust），代码不再读这一列，但**值留在库里不动**：
   * 回退到旧版本时旧代码照常用它；导入 0010 之前的老备份时 parseImport 也靠它换算出外页面校准记录。
   * 整数「分」，null = 没修饰过。
   */
  facade_offset: number | null
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
  /**
   * 0009：「外面隐藏」。里页面打的记号，外页面**当这一笔不存在**：列表、余额、余额曲线、
   * 收入支出统计全都不算它（facade.outerTxs 是唯一入口）。里页面一切照常。
   * 做过一版「只藏列表那一行、钱照算」，两套账本对不上，2026-09-16 当天改成一本账。
   * 涉及白条账户的记录不打这个记号（白条不参与里外）。null / false = 正常显示。
   */
  hidden: boolean | null
  created_at: string // ISO
}

/**
 * 0010：外页面自己的校准记录（里外校准分家，2026-09-27）。
 *
 * 外页面的余额和曲线 = 真实流水 − 藏掉的 − 非白条账户的真实校准 + 这些记录；里页面看不见它。
 * 一条 = 「从 date 这天起，外页面这个账户的余额加 cents」，以前的点不动——和里页面的真实校准一个脾气，
 * 不再是老模型那种一改整条曲线上下移的固定差值（`Account.facade_offset`）。
 *
 * `cents` 是整数「分」，可正可负；数据库里也是整数（bigint），不走元↔分换算，备份脚本就少一处会算错 100 倍的地方。
 * 单独一张表而不是流水表加一列：回退旧版本时旧代码看不见这张表，不会把假校准当真校准算进里页面。
 */
export interface FacadeAdjust {
  id: string
  account_id: string
  date: string // YYYY-MM-DD
  cents: number
  created_at: string // ISO
}

export interface Snapshot {
  accounts: Account[]
  categories: Category[]
  transactions: Transaction[]
  /** 0010：外页面校准记录。老备份文件没有这一节，parseImport 会按老偏移量换算出来 */
  facade_adjusts: FacadeAdjust[]
}

export const TX_TYPE_LABEL: Record<TxType, string> = {
  expense: '支出',
  income: '收入',
  transfer: '转账',
  adjust: '校准',
}
