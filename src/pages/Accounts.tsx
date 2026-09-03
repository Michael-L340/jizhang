import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AccountIcon } from '../components/AccountIcon'
import { Sheet } from '../components/Sheet'
import { balances, lastCheck, totalOf } from '../lib/compute'
import { fmtIsoZh, nowIso, today } from '../lib/date'
import { newId } from '../lib/id'
import { fmtYuan, parseYuan } from '../lib/money'
import { useActiveAccounts, useStore } from '../lib/store'
import type { Account } from '../types'

export function Accounts() {
  const txs = useStore((s) => s.transactions)
  const addTx = useStore((s) => s.addTx)
  const showToast = useStore((s) => s.showToast)
  const lastSync = useStore((s) => s.lastSync)
  const accounts = useActiveAccounts()
  const bal = useMemo(() => balances(txs, accounts), [txs, accounts])
  const [target, setTarget] = useState<Account | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)

  const computed = target ? bal[target.id] ?? 0 : 0
  const real = parseYuan(input)
  const delta = real === null ? null : real - computed

  function open(a: Account) {
    setTarget(a)
    setInput(fmtYuan(bal[a.id] ?? 0).replace(/,/g, ''))
  }

  async function confirm() {
    if (!target || delta === null) return
    setBusy(true)
    const ok = await addTx({
      id: newId(),
      date: today(),
      type: 'adjust',
      amount: delta,
      account_id: target.id,
      to_account_id: null,
      category_id: null,
      note: delta === 0 ? '余额核对' : '余额校准',
      created_at: nowIso(),
    })
    setBusy(false)
    if (ok) {
      showToast(delta === 0 ? `${target.name} 核对无差异` : `${target.name} 已校准 ${fmtYuan(delta, { sign: true })}`)
      setTarget(null)
    }
  }

  return (
    <div className="px-4 pb-6">
      <div className="flex items-center justify-between pt-4 pb-3">
        <span className="text-2xl font-bold">账户</span>
        <Link to="/settings" className="text-sm text-brand px-2 py-1">
          设置
        </Link>
      </div>

      <div className="card p-4 mb-3">
        <div className="text-xs text-muted">总余额</div>
        <div className={`num text-3xl font-bold ${totalOf(bal) < 0 ? 'text-expense' : ''}`}>{fmtYuan(totalOf(bal), { symbol: true })}</div>
        <div className="text-xs text-muted mt-1">{lastSync ? `上次同步 ${fmtIsoZh(lastSync)}` : '尚未同步'}</div>
      </div>

      <div className="flex flex-col gap-2">
        {accounts.map((a) => {
          const lc = lastCheck(txs, a.id)
          return (
            <button key={a.id} type="button" className="card p-4 text-left flex items-center gap-3" onClick={() => open(a)}>
              <AccountIcon name={a.name} />
              <span className="flex-1 min-w-0">
                <span className="block font-medium">{a.name}</span>
                <span className="block text-xs text-muted">{lc ? `上次核对 ${fmtIsoZh(lc)}` : '从未核对，点此输入实际余额'}</span>
              </span>
              <span className={`num text-lg font-semibold ${(bal[a.id] ?? 0) < 0 ? 'text-expense' : ''}`}>{fmtYuan(bal[a.id] ?? 0)}</span>
            </button>
          )
        })}
      </div>

      <div className="text-xs text-muted mt-4 leading-relaxed">
        点账户输入实际余额。若与推算不一致，差额会记成一条「余额校准」，出现在流水里但不计入收入支出；随时可以删除或改成一笔正常收支。
      </div>

      <Sheet open={Boolean(target)} onClose={() => setTarget(null)} title={target ? `${target.name} · 输入实际余额` : ''}>
        <div className="flex items-center gap-2 mb-3">
          <span className="text-2xl">¥</span>
          <input
            autoFocus
            inputMode="decimal"
            className="flex-1 num text-2xl font-semibold bg-bg rounded-xl px-3 py-2"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && confirm()}
          />
        </div>
        <div className="text-sm flex flex-col gap-1 mb-4">
          <div className="flex justify-between">
            <span className="text-muted">推算余额</span>
            <span className="num">{fmtYuan(computed)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">实际余额</span>
            <span className="num">{real === null ? '—' : fmtYuan(real)}</span>
          </div>
          <div className="flex justify-between font-medium">
            <span className="text-muted">差额</span>
            <span className={`num ${delta === null ? '' : delta < 0 ? 'text-expense' : delta > 0 ? 'text-income' : ''}`}>
              {delta === null ? '—' : delta === 0 ? '无差异' : fmtYuan(delta, { sign: true })}
            </span>
          </div>
        </div>
        <button type="button" disabled={busy || delta === null} className="w-full rounded-2xl bg-brand text-white py-3 font-semibold disabled:opacity-40" onClick={confirm}>
          {delta === 0 ? '记录核对' : '生成校准记录'}
        </button>
      </Sheet>
    </div>
  )
}
