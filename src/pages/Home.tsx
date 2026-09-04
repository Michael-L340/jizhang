import { lazy, Suspense, useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AccountIcon } from '../components/AccountIcon'
import { TxRow } from '../components/TxRow'
import { balances, byCategory, monthSummary, sortTxs, totalOf } from '../lib/compute'
import { fmtDateZh, fmtMonthZh, monthOf, today } from '../lib/date'
import { useAccountMap, useCategoryMap } from '../lib/hooks'
import { fmtYuan } from '../lib/money'
import { useActiveAccounts, useStore } from '../lib/store'

const Chart = lazy(() => import('../components/Chart'))

const PIE_COLORS = ['#2f6fed', '#f5a524', '#1f9d55', '#e5484d', '#7c5cff', '#0ea5e9', '#f97316']

export function Home() {
  const txs = useStore((s) => s.transactions)
  const cats = useStore((s) => s.categories)
  const syncing = useStore((s) => s.syncing)
  const accounts = useActiveAccounts()
  const accMap = useAccountMap()
  const catMap = useCategoryMap()
  const nav = useNavigate()

  const ym = monthOf(today())
  const sum = useMemo(() => monthSummary(txs, ym), [txs, ym])
  const bal = useMemo(() => balances(txs, accounts), [txs, accounts])
  const agg = useMemo(() => byCategory(txs, cats, ym, 'expense'), [txs, cats, ym])
  const recent = useMemo(() => sortTxs(txs).slice(0, 5), [txs])

  const td = today()
  const dayStat = useMemo(() => {
    let expense = 0
    let income = 0
    let count = 0 // 只数支出笔数，这张卡讲的是今天花了多少
    for (const t of txs) {
      if (t.date !== td) continue
      if (t.type === 'expense') {
        expense += t.amount
        count++
      } else if (t.type === 'income') {
        income += t.amount
      }
    }
    return { expense, income, count }
  }, [txs, td])

  const pieOption = useMemo(
    () => ({
      color: PIE_COLORS,
      // series 的 value 是元，fmtYuan 只接受分，必须先折回分再格式化
      tooltip: { trigger: 'item', valueFormatter: (v: number) => `¥${fmtYuan(Math.round(v * 100))}` },
      series: [
        {
          type: 'pie',
          radius: ['55%', '85%'],
          center: ['50%', '50%'],
          avoidLabelOverlap: false,
          label: { show: false },
          data: agg.map((a) => ({ name: a.name, value: a.amount / 100 })),
        },
      ],
    }),
    [agg],
  )

  return (
    <div className="px-4 pb-6">
      <div className="flex items-baseline justify-between pt-4 pb-3">
        <Link to="/ledger" className="text-2xl font-bold">
          {fmtMonthZh(ym)}
        </Link>
        <span className="text-xs text-muted">{syncing ? '同步中…' : ''}</span>
      </div>

      <Link to={`/ledger?date=${td}`} className="card p-4 mb-3 flex items-center gap-4">
        <span className="flex-1 min-w-0">
          <span className="block text-xs text-muted">今日开支 · {fmtDateZh(td)}</span>
          <span className={`block num text-2xl font-bold leading-tight mt-0.5 ${dayStat.expense ? 'text-expense' : 'text-muted'}`}>
            {dayStat.expense ? `-${fmtYuan(dayStat.expense)}` : fmtYuan(0)}
          </span>
        </span>
        <span className="text-right shrink-0">
          {dayStat.income ? (
            <span className="block num text-sm font-medium text-income">今日收入 +{fmtYuan(dayStat.income)}</span>
          ) : null}
          <span className="block text-xs text-muted mt-0.5">{dayStat.count ? `${dayStat.count} 笔 ›` : '还没记账 ›'}</span>
        </span>
      </Link>

      <div className="card p-4 mb-3">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <div className="text-xs text-muted">支出</div>
            <div className="num text-lg font-semibold text-expense">{fmtYuan(sum.expense)}</div>
          </div>
          <div>
            <div className="text-xs text-muted">收入</div>
            <div className="num text-lg font-semibold text-income">{fmtYuan(sum.income)}</div>
          </div>
          <div>
            <div className="text-xs text-muted">结余</div>
            <div className={`num text-lg font-semibold ${sum.net < 0 ? 'text-expense' : ''}`}>{fmtYuan(sum.net)}</div>
          </div>
        </div>
        <div className="mt-3 pt-3 border-t border-line flex justify-between items-baseline text-sm">
          <span className="text-muted">
            储蓄率<span className="text-[11px] ml-1.5">结余 ÷ 收入</span>
          </span>
          <span className="num font-medium">
            {sum.savingRate === null ? <span className="text-muted">本月没有收入</span> : `${(sum.savingRate * 100).toFixed(1)}%`}
          </span>
        </div>
      </div>

      <div className="card p-4 mb-3">
        <div className="flex justify-between items-baseline mb-3">
          <span className="text-sm text-muted">账户</span>
          <Link to="/accounts" className="num text-sm font-semibold">
            合计 {fmtYuan(totalOf(bal), { symbol: true })}
          </Link>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {accounts.map((a) => (
            <Link key={a.id} to="/accounts" className="rounded-xl bg-bg px-3 py-2.5 flex items-center gap-2">
              <AccountIcon name={a.name} size={28} />
              <span className="min-w-0">
                <span className="block text-xs text-muted truncate">{a.name}</span>
                <span className={`block num font-semibold ${(bal[a.id] ?? 0) < 0 ? 'text-expense' : ''}`}>{fmtYuan(bal[a.id] ?? 0)}</span>
              </span>
            </Link>
          ))}
        </div>
      </div>

      <div className="card p-4 mb-3">
        <div className="flex justify-between items-baseline mb-2">
          <span className="text-sm text-muted">本月支出用途</span>
          <Link to="/stats" className="text-xs text-brand">
            统计 ›
          </Link>
        </div>
        {agg.length === 0 ? (
          <div className="text-sm text-muted py-6 text-center">本月还没有支出</div>
        ) : (
          <div className="flex items-center gap-3">
            <div className="w-28 shrink-0">
              <Suspense fallback={<div style={{ height: 112 }} />}>
                <Chart option={pieOption} height={112} />
              </Suspense>
            </div>
            <div className="flex-1 min-w-0 flex flex-col gap-1.5">
              {agg.slice(0, 5).map((a, i) => (
                <div key={a.id} className="flex items-center gap-2 text-sm">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                  <span className="flex-1 truncate">{a.name}</span>
                  <span className="num text-muted text-xs">{sum.expense ? Math.round((a.amount / sum.expense) * 100) : 0}%</span>
                  <span className="num w-20 text-right">{fmtYuan(a.amount)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="card mb-3">
        <div className="flex justify-between items-baseline px-4 pt-4 pb-1">
          <span className="text-sm text-muted">最近流水</span>
          <Link to="/ledger" className="text-xs text-brand">
            全部 ›
          </Link>
        </div>
        {recent.length === 0 ? (
          <div className="text-sm text-muted py-6 text-center">还没有记录，点下方 ＋ 记一笔</div>
        ) : (
          <div className="divide-y divide-line">
            {recent.map((t) => (
              <TxRow key={t.id} tx={t} accounts={accMap} categories={catMap} showDate={t.date.slice(5).replace('-', '/')} onClick={() => nav(`/add?id=${t.id}`)} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
