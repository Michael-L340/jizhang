// 只给测试用（registry.test.ts、components/ChartMore.test.ts）：一本「像真的」的一年账，十张图都有东西可画。
// App 代码不 import 它，打包时不会带进去。
//
// 固定种子的 LCG，红了能复现。今天 2026-09-28，顶上停在 9 月，范围近一年。
import type { Account, Category, Transaction } from '../../types'
import { addDays } from '../date'
import type { MoreInput } from './types'

const acc = (id: string, name: string, kind: Account['kind'], sort: number, repay_day: number | null = null): Account => ({
  id, name, kind, sort, is_archived: false, repay_day, defer_after_repay: null, facade_offset: null,
})
const cat = (id: string, kind: Category['kind'], parent_id: string | null, name: string, sort: number): Category => ({
  id, kind, parent_id, name, icon: null, sort, is_archived: false, note: null,
})

export const SAMPLE_ACCOUNTS: Account[] = [
  acc('boc', '中国银行', 'bank', 1),
  acc('wx', '微信', 'wallet', 2),
  acc('zfb', '支付宝', 'wallet', 3),
  acc('jd', '京东白条', 'credit', 5, 17),
  acc('hb', '花呗', 'credit', 6, 1),
]

export const SAMPLE_CATS: Category[] = [
  cat('food', 'expense', null, '日常餐饮', 1),
  cat('lunch', 'expense', 'food', '午餐', 1),
  cat('dinner', 'expense', 'food', '晚餐', 2),
  cat('life', 'expense', null, '经常生活开支', 2),
  cat('rent', 'expense', 'life', '房租', 1),
  cat('bus', 'expense', 'life', '通勤', 2),
  cat('big', 'expense', null, '非经常生活消费', 3),
  cat('fun', 'expense', null, '娱乐消费', 4),
  cat('game', 'expense', 'fun', '游戏', 1),
  cat('oops', 'expense', null, '意外开支', 5),
  cat('salary', 'income', null, '工资', 1),
  cat('refund', 'income', null, '退款', 2),
]

export const SAMPLE_TODAY = '2026-09-28'

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** 北京时间 date 那天 hour 点录入的 created_at */
function enteredAt(date: string, hour: number, min: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, hour - 8, min)).toISOString()
}

export function sampleTxs(seed = 7): Transaction[] {
  const r = rng(seed)
  const out: Transaction[] = []
  let n = 0
  const push = (date: string, type: Transaction['type'], amount: number, account_id: string | null, over: Partial<Transaction> = {}) => {
    n++
    // 大多数当天记，少数隔几天补记（weekhour 只认当天记的）
    const late = r() < 0.15 ? Math.floor(r() * 4) + 1 : 0
    out.push({
      id: `s${n}`, date, type, amount, account_id, to_account_id: null, category_id: null, note: null,
      installments: null, settles: null, hidden: null,
      created_at: enteredAt(addDays(date, late), 7 + Math.floor(r() * 16), Math.floor(r() * 60)),
      ...over,
    })
  }
  const spendCats = ['lunch', 'dinner', 'food', 'rent', 'bus', 'big', 'fun', 'game', 'oops']
  const payFrom = ['wx', 'zfb', 'boc', 'jd', 'hb', null]
  for (let d = '2025-09-01'; d <= SAMPLE_TODAY; d = addDays(d, 1)) {
    if (d.endsWith('-10')) push(d, 'income', 1200000 + Math.floor(r() * 300000), 'boc', { category_id: 'salary' })
    if (d.endsWith('-01')) push(d, 'expense', 350000, 'boc', { category_id: 'rent' })
    if (d.endsWith('-17')) push(d, 'transfer', 20000 + Math.floor(r() * 50000), 'boc', { to_account_id: 'jd' })
    if (d.endsWith('-02')) push(d, 'transfer', 10000 + Math.floor(r() * 20000), 'boc', { to_account_id: 'hb' })
    if (d.endsWith('-20')) push(d, 'adjust', Math.floor(r() * 2000) - 1000, 'wx')
    // 有些天一笔不花（零支出天数、日历留白）
    const k = r() < 0.2 ? 0 : 1 + Math.floor(r() * 3)
    for (let i = 0; i < k; i++) {
      const c = spendCats[Math.floor(r() * spendCats.length)]
      const big = r() < 0.03
      push(d, 'expense', big ? 100000 + Math.floor(r() * 400000) : 500 + Math.floor(r() * 12000), payFrom[Math.floor(r() * payFrom.length)], {
        category_id: c,
        installments: big && r() < 0.5 ? 3 : null,
      })
    }
    if (r() < 0.02) push(d, 'income', 1000 + Math.floor(r() * 20000), 'wx', { category_id: 'refund' })
  }
  return out
}

export function sampleInput(over: Partial<MoreInput> = {}): MoreInput {
  return {
    txs: sampleTxs(),
    accounts: SAMPLE_ACCOUNTS,
    cats: SAMPLE_CATS,
    ym: '2026-09',
    start: '2025-10-01',
    end: SAMPLE_TODAY,
    today: SAMPLE_TODAY,
    ...over,
  }
}
