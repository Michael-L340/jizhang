import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChipGroup } from '../components/ChipGroup'
import { MonthPicker } from '../components/MonthPicker'
import { Sheet } from '../components/Sheet'
import { TxRow } from '../components/TxRow'
import { groupByDay, inMonth, monthSummary, monthTotals } from '../lib/compute'
import { fmtDateRel, fmtDateZh, monthOf, today } from '../lib/date'
import { useAccountMap, useCategoryMap } from '../lib/hooks'
import { fmtYuan } from '../lib/money'
import { useActiveAccounts, useStore } from '../lib/store'
import type { TxType } from '../types'

const TYPE_OPTS: { id: string; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'expense', label: '支出' },
  { id: 'income', label: '收入' },
  { id: 'transfer', label: '转账' },
  { id: 'adjust', label: '校准' },
]

export function Ledger() {
  const txs = useStore((s) => s.transactions)
  const cats = useStore((s) => s.categories)
  const accounts = useActiveAccounts()
  const accMap = useAccountMap()
  const catMap = useCategoryMap()
  const nav = useNavigate()

  const [ym, setYm] = useState(monthOf(today()))
  const [type, setType] = useState<string>('all')
  const [accountId, setAccountId] = useState<string>('all')
  const [parentId, setParentId] = useState<string>('all')
  const [open, setOpen] = useState(false)

  const roots = useMemo(() => cats.filter((c) => !c.parent_id && !c.is_archived).sort((a, b) => (a.kind === b.kind ? a.sort - b.sort : a.kind === 'expense' ? -1 : 1)), [cats])

  const list = useMemo(() => {
    return txs.filter((t) => {
      if (!inMonth(t, ym)) return false
      if (type !== 'all' && t.type !== (type as TxType)) return false
      if (accountId === 'none' && t.account_id) return false
      if (accountId !== 'all' && accountId !== 'none' && t.account_id !== accountId && t.to_account_id !== accountId) return false
      if (parentId !== 'all') {
        if (!t.category_id) return false
        const c = catMap.get(t.category_id)
        const p = c?.parent_id ?? c?.id
        if (p !== parentId) return false
      }
      return true
    })
  }, [txs, ym, type, accountId, parentId, catMap])

  const totalsByMonth = useMemo(() => monthTotals(txs), [txs])
  const groups = useMemo(() => groupByDay(list), [list])
  const sum = useMemo(() => monthSummary(txs, ym), [txs, ym])
  const filtered = type !== 'all' || accountId !== 'all' || parentId !== 'all'

  return (
    <div className="pb-6">
      <div className="sticky top-0 z-10 bg-bg px-4 pt-3 pb-2">
        <MonthPicker value={ym} onChange={setYm} totals={totalsByMonth} />
        <div className="flex items-center justify-between text-xs text-muted px-1">
          <span className="num">
            支出 <span className="text-expense">{fmtYuan(sum.expense)}</span> · 收入 <span className="text-income">{fmtYuan(sum.income)}</span>
          </span>
          <button type="button" className={`chip ${filtered ? 'on' : ''}`} style={{ padding: '5px 10px' }} onClick={() => setOpen(true)}>
            筛选{filtered ? ' ·' : ''}
          </button>
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="text-center text-muted text-sm py-16">这个月没有记录</div>
      ) : (
        groups.map((g) => (
          <div key={g.date} className="mt-3">
            <div className="flex justify-between px-4 pb-1 text-xs text-muted">
              <span>
                {fmtDateZh(g.date)}
                {fmtDateRel(g.date) === '今天' || fmtDateRel(g.date) === '昨天' ? ` · ${fmtDateRel(g.date)}` : ''}
              </span>
              <span className="num">
                {g.expense ? `支出 ${fmtYuan(g.expense)}` : ''}
                {g.expense && g.income ? ' · ' : ''}
                {g.income ? `收入 ${fmtYuan(g.income)}` : ''}
              </span>
            </div>
            <div className="card mx-4 divide-y divide-line overflow-hidden">
              {g.items.map((t) => (
                <TxRow key={t.id} tx={t} accounts={accMap} categories={catMap} onClick={() => nav(`/add?id=${t.id}`)} />
              ))}
            </div>
          </div>
        ))
      )}

      <Sheet open={open} onClose={() => setOpen(false)} title="筛选">
        <div className="text-xs text-muted mb-2">类型</div>
        <ChipGroup options={TYPE_OPTS} value={type} onChange={setType} className="mb-4" />
        <div className="text-xs text-muted mb-2">账户</div>
        <ChipGroup options={[{ id: 'all', label: '全部' }, ...accounts.map((a) => ({ id: a.id, label: a.name })), { id: 'none', label: '未指定' }]} value={accountId} onChange={setAccountId} className="mb-4" />
        <div className="text-xs text-muted mb-2">分类</div>
        <ChipGroup options={[{ id: 'all', label: '全部' }, ...roots.map((c) => ({ id: c.id, label: c.name, icon: c.icon }))]} value={parentId} onChange={setParentId} className="mb-4" />
        <div className="flex gap-2">
          <button
            type="button"
            className="flex-1 chip text-center"
            onClick={() => {
              setType('all')
              setAccountId('all')
              setParentId('all')
            }}
          >
            清除
          </button>
          <button type="button" className="flex-1 chip on text-center" onClick={() => setOpen(false)}>
            完成
          </button>
        </div>
      </Sheet>
    </div>
  )
}
