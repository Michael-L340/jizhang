import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AccountIcon, accountColor } from '../components/AccountIcon'
import { ChipGroup } from '../components/ChipGroup'
import { Sheet } from '../components/Sheet'
import { activePlans, balances, balanceShares, debtOf, dueInMonth, monthByAccount, splitAccounts, totalOf } from '../lib/compute'
import { fmtIsoZh, monthOf, nowIso, today } from '../lib/date'
import { useCategoryMap, usePersistedState } from '../lib/hooks'
import { newId } from '../lib/id'
import { guessIcon } from '../lib/icons'
import { calcDelta, fmtYuan, parseYuan } from '../lib/money'
import { useActiveAccounts, useStore } from '../lib/store'
import type { Account } from '../types'

export function Accounts() {
  const txs = useStore((s) => s.transactions)
  const addTx = useStore((s) => s.addTx)
  const removeTx = useStore((s) => s.removeTx)
  const showToast = useStore((s) => s.showToast)
  const lastSync = useStore((s) => s.lastSync)
  const syncFailed = useStore((s) => s.syncFailed)
  const accounts = useActiveAccounts()
  const catMap = useCategoryMap()
  const { assets, credits } = useMemo(() => splitAccounts(accounts), [accounts])
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

  // 白条：余额为负是欠款。核对时让用户输「待还」（正数），差额再翻回余额的方向。
  const creditTarget = target ? credits.some((c) => c.id === target.id) : false
  const computed = target ? bal[target.id] ?? 0 : 0
  const shown = creditTarget ? -computed : computed
  const real = parseYuan(input)
  const rawDelta = calcDelta(input, shown) // 算式本体在 lib/money.ts，那里测得到
  const delta = rawDelta === null ? null : creditTarget ? -rawDelta : rawDelta

  function open(a: Account) {
    setTarget(a)
    const v = credits.some((c) => c.id === a.id) ? -(bal[a.id] ?? 0) : bal[a.id] ?? 0
    setInput(fmtYuan(v).replace(/,/g, ''))
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
      installments: null,
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
  const shares = useMemo(() => balanceShares(bal, assets.map((a) => a.id)), [bal, assets])

  // ---- 白条 ----
  const creditIds = useMemo(() => new Set(credits.map((c) => c.id)), [credits])
  const due = useMemo(() => dueInMonth(txs, creditIds, ym), [txs, creditIds, ym])
  const dueTotal = [...due.values()].reduce((s, v) => s + v, 0)
  const debt = debtOf(bal, credits)
  const withDebt = credits.filter((c) => (bal[c.id] ?? 0) < 0).length
  const [creditOpen, setCreditOpen] = usePersistedState('jz_acc_creditOpen', false)
  const [creditTarget2, setCreditTarget2] = useState<Account | null>(null)
  const plans = useMemo(() => (creditTarget2 ? activePlans(txs, creditTarget2.id, ym) : []), [txs, creditTarget2, ym])
  const [repayFrom, setRepayFrom] = usePersistedState<string | null>('jz_repay_from', null)
  const [repayInput, setRepayInput] = useState('')
  const repayCents = parseYuan(repayInput)
  const fromAcc = assets.find((a) => a.id === repayFrom) ?? assets[0]

  function openCredit(a: Account) {
    setCreditTarget2(a)
    const d = due.get(a.id) ?? 0
    const owed = Math.max(0, -(bal[a.id] ?? 0))
    // 金额按本月应还填好；这个月没有到期的就填全部欠款；没欠就留空
    setRepayInput(d > 0 ? fmtYuan(d).replace(/,/g, '') : owed > 0 ? fmtYuan(owed).replace(/,/g, '') : '')
  }

  async function repay() {
    if (!creditTarget2 || !fromAcc || !repayCents || repayCents <= 0) return
    const credit = creditTarget2
    setBusy(true)
    const tx = {
      id: newId(),
      date: today(),
      type: 'transfer' as const,
      amount: repayCents,
      account_id: fromAcc.id,
      to_account_id: credit.id,
      category_id: null,
      note: '还款',
      installments: null,
      created_at: nowIso(),
    }
    const ok = await addTx(tx)
    setBusy(false)
    if (!ok) return
    setCreditTarget2(null)
    showToast(`已记还款 ¥${fmtYuan(repayCents)} · ${fromAcc.name} → ${credit.name}`, async () => {
      const removed = await removeTx(tx.id)
      if (removed) showToast(`已撤销还款 ¥${fmtYuan(repayCents)}`)
    })
  }

  const planTitle = (categoryId: string | null, note: string | null): { icon: string; title: string } => {
    const c = categoryId ? catMap.get(categoryId) : undefined
    const parent = c?.parent_id ? catMap.get(c.parent_id) : c
    const name = c ? (c.parent_id ? `${parent?.name ?? ''} · ${c.name}` : c.name) : '未分类'
    const icon = (c?.parent_id ? c.icon ?? guessIcon(c.name) : null) ?? parent?.icon ?? '🧾'
    return { icon, title: note ? `${name} · ${note}` : name }
  }

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
        {credits.length && debt > 0 ? (
          <div className="num text-xs text-muted mt-1">
            资产 {fmtYuan(totalOf(bal) + debt, { symbol: true })} · 白条待还 {fmtYuan(debt, { symbol: true })}
          </div>
        ) : null}
        <div className={`text-xs mt-1 ${syncFailed ? 'text-adjust' : 'text-muted'}`}>
          {lastSync ? `上次同步 ${fmtIsoZh(lastSync)}` : '尚未同步'}
          {syncFailed ? ' · 最近一次同步失败' : ''}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {assets.map((a) => {
          const lc = lastAdjusts.get(a.id) ?? null
          return (
            <button key={a.id} type="button" className="card p-4 text-left flex items-center gap-3" onClick={() => open(a)}>
              <AccountIcon name={a.name} />
              <span className="flex-1 min-w-0">
                <span className="block font-medium">{a.name}</span>
                <span className="block text-xs text-muted">{lc ? `上次校准 ${fmtIsoZh(lc)}` : '点此输入实际余额核对'}</span>
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

        {/* 白条平时收成一行：欠款合计 + 本月应还。点开才展开各平台，再点收起。 */}
        {credits.length ? (
          <div className="card p-4 pt-3">
            <button type="button" className="w-full text-left flex items-center gap-3" onClick={() => setCreditOpen(!creditOpen)}>
              <AccountIcon name="白条" />
              <span className="flex-1 min-w-0">
                <span className="block font-medium">白条</span>
                <span className="block text-xs text-muted">
                  {credits.length} 个平台 · {withDebt ? `${withDebt} 个有欠款` : '没有欠款'}
                </span>
              </span>
              <span className="text-right">
                <span className={`block num text-lg font-semibold ${debt > 0 ? 'text-expense' : 'text-muted'}`}>{debt > 0 ? `欠 ${fmtYuan(debt)}` : '已还清'}</span>
                <span className="block num text-[11px] text-muted">
                  {dueTotal > 0 ? `本月应还 ${fmtYuan(dueTotal)}` : '本月没有到期'} {creditOpen ? '⌄' : '›'}
                </span>
              </span>
            </button>
            {creditOpen ? (
              <div className="mt-2 ml-5 pl-3 border-l-2 border-brand">
                {credits.map((c) => {
                  const owed = Math.max(0, -(bal[c.id] ?? 0))
                  const d = due.get(c.id) ?? 0
                  const n = activePlans(txs, c.id, ym).length
                  return (
                    <button key={c.id} type="button" className="w-full text-left flex items-center gap-2.5 py-2.5" onClick={() => openCredit(c)}>
                      <AccountIcon name={c.name} size={28} />
                      <span className="flex-1 min-w-0">
                        <span className="block text-[15px]">{c.name}</span>
                        <span className="block text-[11px] text-muted">{n ? `${n} 笔分期中` : owed ? '点开记还款' : '没有欠款'}</span>
                      </span>
                      <span className="text-right">
                        <span className={`block num font-semibold ${owed > 0 ? 'text-expense' : 'text-muted text-sm'}`}>{owed > 0 ? `欠 ${fmtYuan(owed)}` : '已还清'}</span>
                        {d > 0 ? <span className="block num text-[11px] text-muted">本月应还 {fmtYuan(d)}</span> : null}
                      </span>
                    </button>
                  )
                })}
              </div>
            ) : null}
          </div>
        ) : null}
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
        {credits.length ? ' 白条：下单时记支出（账户选白条、填分几期），平台扣款时点开白条记还款，记成转账，不会把同一笔算两次。' : ''}
      </div>

      {/* 白条弹层：分期明细 + 一键还款 + 核对待还 */}
      <Sheet open={Boolean(creditTarget2)} onClose={() => setCreditTarget2(null)} title={creditTarget2 ? `${creditTarget2.name} · ${(bal[creditTarget2.id] ?? 0) < 0 ? `欠 ${fmtYuan(-(bal[creditTarget2.id] ?? 0), { symbol: true })}` : '已还清'}` : ''}>
        {creditTarget2 ? (
          <>
            {plans.length ? (
              <>
                <div className="text-xs text-muted mb-1">分期中</div>
                <div className="mb-4">
                  {plans.map((p) => {
                    const { icon, title } = planTitle(p.tx.category_id, p.tx.note)
                    const n = p.plan.length
                    return (
                      <div key={p.tx.id} className="flex items-center gap-2.5 py-2 border-t border-line first:border-t-0">
                        <span className="text-xl w-7 text-center shrink-0">{icon}</span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm truncate">{title}</span>
                          <span className="block text-[11px] text-muted num">
                            {Number(p.tx.date.slice(5, 7))}/{Number(p.tx.date.slice(8))} 下单 ¥{fmtYuan(p.tx.amount)} · {n === 1 ? '下月一次还' : `分 ${n} 期`}
                          </span>
                        </span>
                        <span className="text-right shrink-0">
                          <span className="block num text-sm font-medium">¥{fmtYuan((p.current ?? p.plan[p.done] ?? p.plan[n - 1]).amount)}</span>
                          <span className="block num text-[11px] text-muted">{p.current ? `本月第 ${p.current.seq}/${n} 期` : `${p.done}/${n} 期已到期`}</span>
                        </span>
                      </div>
                    )
                  })}
                </div>
              </>
            ) : null}

            <div className="text-xs text-muted mb-1">记一笔还款</div>
            <ChipGroup
              options={assets.map((a) => ({ id: a.id, label: a.name, node: <AccountIcon name={a.name} size={18} /> }))}
              value={fromAcc?.id ?? ''}
              onChange={setRepayFrom}
              className="mb-2"
            />
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm text-muted flex-1 truncate">
                {fromAcc?.name ?? '?'} → {creditTarget2.name}
              </span>
              <span className="text-xl">¥</span>
              <input inputMode="decimal" className="w-32 num text-xl font-semibold bg-bg rounded-xl px-3 py-2 text-right" value={repayInput} onChange={(e) => setRepayInput(e.target.value)} />
            </div>
            <div className="text-[11px] text-muted mb-3">金额按本月应还填好，扣得不一样可以改。记成转账，不进收支统计。</div>
            <button
              type="button"
              disabled={busy || !fromAcc || !repayCents || repayCents <= 0}
              className="w-full rounded-2xl bg-brand text-on-brand py-3 font-semibold disabled:opacity-40"
              onClick={repay}
            >
              记这笔还款
            </button>
            <button
              type="button"
              className="w-full rounded-2xl bg-brand-soft text-brand-ink py-3 font-medium mt-2"
              onClick={() => {
                const a = creditTarget2
                setCreditTarget2(null)
                open(a)
              }}
            >
              核对待还 · 输入平台里显示的数字
            </button>
          </>
        ) : null}
      </Sheet>

      <Sheet open={Boolean(target)} onClose={() => setTarget(null)} title={target ? `${target.name} · ${creditTarget ? '输入待还金额' : '输入实际余额'}` : ''}>
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
            <span className="text-muted">{creditTarget ? '推算待还' : '推算余额'}</span>
            <span className="num">{fmtYuan(shown)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">{creditTarget ? '实际待还' : '实际余额'}</span>
            <span className="num">{real === null ? '—' : fmtYuan(real)}</span>
          </div>
          <div className="flex justify-between font-medium">
            <span className="text-muted">{creditTarget ? '校准（负数 = 欠得更多）' : '差额'}</span>
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
