// 一次性开支（用户 2026-11-25 定的，看过自己的真实账本之后）：
//   · 一级「日常开支」「经常生活开支」整类不算——天天有、月月有的；
//   · 一级「非经常生活消费」「意外开支」整类都算——分类名本身就是这个意思；
//   · 其他一级（娱乐消费、恋爱，以后新加的也一样）看备注：
//       写了备注、而且同一个一级里这条备注往前 90 天只出现这一次 → 算（「城市天际线2」）；重复出现 → 不算（会员续费）；
//       没写备注 → 这个「一级·二级」往前 90 天不超过 2 笔才算（偶尔一次的「纪念日节日」）。
//   「Excel 导入」这种导入时自动写的备注当没写。
// 90 天从「问的那段时间的最后一天」往前数（问去年 10 月，就按去年 10 月底往前看，不是从今天）。
// 只看真实的正向支出：抵消（退款、垫付）、转账、校准、收入都不参与，也不算进频次。
// 分类按名字认（名字在这里集中登记）：改了这几个一级的名字要回来改这张表，oneoff.test.ts 守着名字和行为。
import { catMapOf, catPathOf } from './book'
import { addDays } from '../date'
import type { Category, Transaction } from '../../types'

export const NEVER_ONEOFF = ['日常开支', '经常生活开支'] as const
export const ALWAYS_ONEOFF = ['非经常生活消费', '意外开支'] as const
/** 导入工具自动写的备注，当没写 */
export const AUTO_NOTES = ['Excel 导入'] as const
export const ONEOFF_WINDOW_DAYS = 90
export const ONEOFF_RARE_MAX = 2

/** 备注规范化：全角转半角、去首尾空白、连续空白并一个；自动备注当空 */
export function normNote(note: string | null | undefined): string {
  const s = (note ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ')
  return (AUTO_NOTES as readonly string[]).includes(s) ? '' : s
}

/** 真实的正向支出（不是抵消、金额 > 0）：一次性只在这些里面挑，频次也只数这些 */
const realSpend = (t: Transaction) => t.type === 'expense' && t.is_offset !== true && t.amount > 0

/**
 * from..to 里哪些支出是一次性的。txs 用当前模式那本账（首页的 otxs 或原始 txs 都行：抵消换过的那笔 amount ≤ 0，自然不算）。
 * 窗口 = [to − 89 天, to]，和「这一笔自己的日期」无关：同一个问题里判断口径一致，结果可复现。
 */
export function oneoffSpends(txs: readonly Transaction[], cats: readonly Category[], from: string, to: string): Transaction[] {
  const byId = catMapOf(cats)
  const winFrom = addDays(to, -(ONEOFF_WINDOW_DAYS - 1))
  const win = txs.filter((t) => realSpend(t) && t.date >= winFrom && t.date <= to)
  // 频次表：同一个一级里同一条备注出现几次；同一个「一级·二级」出现几次
  const noteCount = new Map<string, number>()
  const catCount = new Map<string, number>()
  for (const t of win) {
    const p = catPathOf(t, byId)
    if (!p) continue
    const n = normNote(t.note)
    if (n) noteCount.set(`${p.parent.id}|${n}`, (noteCount.get(`${p.parent.id}|${n}`) ?? 0) + 1)
    const ck = `${p.parent.id}|${p.child?.id ?? ''}`
    catCount.set(ck, (catCount.get(ck) ?? 0) + 1)
  }
  // 查的范围比 90 天长时，窗口外那几笔按它自己往前 90 天数（不然一年前的东西全成了「只出现一次」）
  const isRareAt = (t: Transaction, pid: string, cid: string, n: string): boolean => {
    const lo = addDays(t.date, -(ONEOFF_WINDOW_DAYS - 1))
    let k = 0
    for (const x of txs) {
      if (!realSpend(x) || x.date < lo || x.date > t.date) continue
      const q = catPathOf(x, byId)
      if (!q || q.parent.id !== pid) continue
      if (n ? normNote(x.note) === n : (q.child?.id ?? '') === cid) k++
    }
    return n ? k <= 1 : k <= ONEOFF_RARE_MAX
  }
  const out: Transaction[] = []
  for (const t of txs) {
    if (!realSpend(t) || t.date < from || t.date > to) continue
    const p = catPathOf(t, byId)
    if (!p) continue // 没分类的不判（说不清是什么）
    const root = p.parent.name
    if ((NEVER_ONEOFF as readonly string[]).includes(root)) continue
    if ((ALWAYS_ONEOFF as readonly string[]).includes(root)) {
      out.push(t)
      continue
    }
    const n = normNote(t.note)
    if (t.date >= winFrom) {
      if (n ? (noteCount.get(`${p.parent.id}|${n}`) ?? 0) <= 1 : (catCount.get(`${p.parent.id}|${p.child?.id ?? ''}`) ?? 0) <= ONEOFF_RARE_MAX) out.push(t)
    } else if (isRareAt(t, p.parent.id, p.child?.id ?? '', n)) out.push(t)
  }
  return out.sort((a, b) => b.amount - a.amount || (a.date < b.date ? 1 : -1))
}
