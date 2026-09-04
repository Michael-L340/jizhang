import type { Account, Category, Transaction } from '../types'
import { AccountIcon } from './AccountIcon'
import { categoryColor } from '../lib/palette'
import { fmtYuan } from '../lib/money'

interface Props {
  tx: Transaction
  accounts: Map<string, Account>
  categories: Map<string, Category>
  onClick?: () => void
  showDate?: string
}

export function describeTx(tx: Transaction, accounts: Map<string, Account>, categories: Map<string, Category>) {
  const acc = tx.account_id ? accounts.get(tx.account_id)?.name ?? '未知账户' : '未指定账户'
  if (tx.type === 'transfer') {
    const to = tx.to_account_id ? accounts.get(tx.to_account_id)?.name ?? '未知账户' : '?'
    return { icon: '🔁', title: '转账', sub: `${acc} → ${to}`, tint: '#7c5cff' }
  }
  if (tx.type === 'adjust') {
    return { icon: '⚖️', title: tx.amount === 0 ? '余额核对' : '余额校准', sub: acc, tint: '#b8860b' }
  }
  const c = tx.category_id ? categories.get(tx.category_id) : undefined
  const parent = c?.parent_id ? categories.get(c.parent_id) : c
  const title = c ? (c.parent_id ? `${parent?.name ?? ''} · ${c.name}` : c.name) : '未分类'
  return {
    icon: parent?.icon ?? (tx.type === 'income' ? '💰' : '🧾'),
    title,
    sub: acc,
    tint: parent ? categoryColor(parent.name) : '#7a808c',
  }
}

export function amountClass(tx: Transaction): string {
  if (tx.type === 'expense') return 'text-expense'
  if (tx.type === 'income') return 'text-income'
  if (tx.type === 'transfer') return 'text-transfer'
  return 'text-adjust'
}

export function amountText(tx: Transaction): string {
  if (tx.type === 'expense') return `-${fmtYuan(tx.amount)}`
  if (tx.type === 'income') return `+${fmtYuan(tx.amount)}`
  if (tx.type === 'adjust') return fmtYuan(tx.amount, { sign: true })
  return fmtYuan(tx.amount)
}

export function TxRow({ tx, accounts, categories, onClick, showDate }: Props) {
  const d = describeTx(tx, accounts, categories)
  const muted = tx.type === 'adjust' && tx.amount === 0
  return (
    <button type="button" onClick={onClick} className={`w-full flex items-center gap-3 px-4 py-3 text-left active:bg-bg ${muted ? 'opacity-60' : ''}`}>
      {tx.type === 'transfer' || tx.type === 'adjust' ? (
        <AccountIcon name={accounts.get(tx.account_id ?? '')?.name ?? ''} />
      ) : (
        <span className="w-10 h-10 rounded-full flex items-center justify-center text-[23px] leading-none shrink-0" style={{ background: `${d.tint}1f` }}>
          {d.icon}
        </span>
      )}
      <span className="flex-1 min-w-0">
        <span className="block truncate text-[15px]">{d.title}</span>
        <span className="block truncate text-xs text-muted">
          {showDate ? `${showDate} · ` : ''}
          {d.sub}
          {tx.note ? ` · ${tx.note}` : ''}
        </span>
      </span>
      <span className={`num text-[15px] font-medium ${amountClass(tx)}`}>{amountText(tx)}</span>
    </button>
  )
}
