import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AccountIcon, accountColor } from '../components/AccountIcon'
import { Sheet } from '../components/Sheet'
import { balances, totalOf, balanceShares, monthByAccount } from '../lib/compute'
import { fmtIsoZh, monthOf, nowIso, today } from '../lib/date'
import { newId } from '../lib/id'
import { calcDelta, fmtYuan, parseYuan } from '../lib/money'
import { useActiveAccounts, useStore } from '../lib/store'
import type { Account } from '../types'

export function Accounts() {
  const txs = useStore((s) => s.transactions)
  const addTx = useStore((s) => s.addTx)
  const showToast = useStore((s) => s.showToast)
  const lastSync = useStore((s) => s.lastSync)
  const syncFailed = useStore((s) => s.syncFailed)
  const accounts = useActiveAccounts()
  const bal = useMemo(() => balances(txs, accounts), [txs, accounts])
  // 原来在 accounts.map() 内部对全量流水扫描，而输入框每次按键都会重渲染整页。
  // 注意：adjust 记录只在「有差额」时才产生，所以这里得到的是「上次校准」而不是「上次核对」。
  const lastAdjusts = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of txs) {
      if (t.type !== 'adjust' || !t.account_id) continue
      const cur = m.get(t.account_id)
      if (!cur || t.created_at > cur) m.set(t.account_id, t.created_at)
    }
    return m
  }, [txs])
  const [target, setTarget] = useState<Account | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)

  const computed = target ? bal[target.id] ?? 0 : 0
  const real = parseYuan(input)
  const delta = calcDelta(input, computed) // 算式本体在 lib/money.ts，那里测得到

  function open(a: Account) {
    setTarget(a)
    setInput(fmtYuan(bal[a.id] ?? 0).replace(/,/g, ''))
  }

  async function confirm() {
    if (!target || delta === null) return
    // 没差额就不留痕：以前会写一条 0 元「余额核对」，只是为了同步「上次核对时间」，
    // 结果流水里全是 0 元行，用户嫌碍眼。核对本身不产生数据。
    if (delta === 0) {
      showToast(`${target.name} 核对无差异，没有产生记录`)
      setTarget(null)
      return
    }
    setBusy(true)
    const ok = await addTx({
      id: newId(),
      date: today(),
      type: 'adjust',
      amount: delta,
      account_id: target.id,
      to_account_id: null,
      category_id: null,
      note: '余额校准',
      created_at: nowIso(),
    })
    setBusy(false)
    if (ok) {
      showToast(`${target.name} 已校准 ${fmtYuan(delta, { sign: true })}`)
      setTarget(null)
    }
  }

  const ym = monthOf(today())
  const byAcc = useMemo(() => monthByAccount(txs, ym), [txs, ym])
  const nameOf = (id: string): string => accounts.find((a) => a.id === id)?.name ?? ''
  const shares = useMemo(() => balanceShares(bal, accounts.map((a) => a.id)), [bal, accounts])

  return (
    <div className="px-4 pb-6">
      <div className="flex items-center justify-between pt-4 pb-3">
        <span className="text-2xl font-bold">账户</span>
        <Link to="/settings" className="text-sm text-brand-ink px-2 py-1">
          设置
        </Link>
      </div>

      <div className="card p-4 mb-3">
        <div className="text-xs text-muted">总余额</div>
        <div className={`num text-3xl font-bold ${totalOf(bal) < 0 ? 'text-expense' : ''}`}>{fmtYuan(totalOf(bal), { symbol: true })}</div>
        <div className={`text-xs mt-1 ${syncFailed ? 'text-adjust' : 'text-muted'}`}>
          {lastSync ? `上次同步 ${fmtIsoZh(lastSync)}` : '尚未同步'}
          {syncFailed ? ' · 最近一次同步失败' : ''}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {accounts.map((a) => {
          const lc = lastAdjusts.get(a.id) ?? null
          return (
            <button key={a.id} type="button" className="card p-4 text-left flex items-center gap-3" onClick={() => open(a)}>
              <AccountIcon name={a.name} />
              <span className="flex-1 min-w-0">
                <span className="block font-medium">{a.name}</span>
                <span className="block text-xs text-muted">
                  {(() => {
                    const m = byAcc.get(a.id)
                    if (m) return `本月 ${m.count} 笔`
                    return lc ? `上次校准 ${fmtIsoZh(lc)}` : '点此输入实际余额核对'
                  })()}
                </span>
              </span>
              <span className="text-right">
                <span className={`block num text-lg font-semibold ${(bal[a.id] ?? 0) < 0 ? 'text-expense' : ''}`}>{fmtYuan(bal[a.id] ?? 0)}</span>
                {/* 本月这个账户进出了多少。转账两头都算、校准也算，所以它和余额的变化能对上。 */}
                {(() => {
                  const m = byAcc.get(a.id)
                  if (!m || m.delta === 0) return <span className="block text-[11px] text-muted">本月没动</span>
                  return (
                    <span className={`block num text-[11px] ${m.delta < 0 ? 'text-expense' : 'text-income'}`}>
                      本月 {fmtYuan(m.delta, { sign: true })}
                    </span>
                  )
                })()}
              </span>
            </button>
          )
        })}
      </div>

      {shares.length ? (
        <div className="card p-4 mt-3">
          <div className="text-xs text-muted mb-2">钱放在哪儿</div>
          <div className="flex h-2.5 rounded-full overflow-hidden bg-line">
            {shares.map((s) => (
              <span key={s.id} style={{ width: `${s.ratio * 100}%`, background: accountColor(nameOf(s.id)) }} />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2.5 text-[11px] text-muted">
            {shares.map((s) => (
              <span key={s.id} className="flex items-center gap-1.5">
                <i className="w-2 h-2 rounded-full" style={{ background: accountColor(nameOf(s.id)) }} />
                {nameOf(s.id)} {Math.round(s.ratio * 100)}%
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="text-xs text-muted mt-4 leading-relaxed">
        点账户输入实际余额。一致就什么都不记；不一致时，差额会记成一条「余额校准」，出现在流水里但不计入收入支出，随时可以删除或改成一笔正常收支。
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
        <button type="button" disabled={busy || delta === null} className="w-full rounded-2xl bg-brand text-on-brand py-3 font-semibold disabled:opacity-40" onClick={confirm}>
          {delta === 0 ? '无差异，直接关闭' : '生成校准记录'}
        </button>
      </Sheet>
    </div>
  )
}
