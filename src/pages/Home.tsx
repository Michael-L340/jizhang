import { lazy, Suspense, useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AccountIcon, accountTint } from '../components/AccountIcon'
import { TxRow } from '../components/TxRow'
import { balances, byCategory, debtOf, dueInMonth, monthSummary, sortTxs, splitAccounts } from '../lib/compute'
import { fmtDateZh, fmtMonthZh, monthOf, today } from '../lib/date'
import { useAccountMap, useCategoryMap, useTabReset } from '../lib/hooks'
import { fmtYuan } from '../lib/money'
import { categoryColor } from '../lib/palette'
import { useActiveAccounts, useStore } from '../lib/store'

const Chart = lazy(() => import('../components/Chart'))

export function Home() {
  const txs = useStore((s) => s.transactions)
  const cats = useStore((s) => s.categories)
  const syncing = useStore((s) => s.syncing)
  const syncFailed = useStore((s) => s.syncFailed)
  const refresh = useStore((s) => s.refresh)
  const outboxCount = useStore((s) => s.outboxCount)
  const flushOutbox = useStore((s) => s.flushOutbox)
  const accounts = useActiveAccounts()
  const { assets, credits } = useMemo(() => splitAccounts(accounts), [accounts])
  const accMap = useAccountMap()
  const catMap = useCategoryMap()
  const nav = useNavigate()
  // 首页没有任何会记住的状态，再点一次「首页」就是滚回顶部
  useTabReset()

  const ym = monthOf(today())
  const sum = useMemo(() => monthSummary(txs, ym), [txs, ym])
  const bal = useMemo(() => balances(txs, accounts), [txs, accounts])
  // 白条：bal 里白条是负数，大数字要加回 debt 才是资产账户之和；欠款单独一行「待还 / 本月应还」
  const debt = debtOf(bal, credits)
  const assetTotal = useMemo(() => assets.reduce((s, a) => s + (bal[a.id] ?? 0), 0), [assets, bal])
  // 白条余额为正 = 多还了，平台欠你钱。少见但要说清楚，否则这笔钱在界面上无处可寻
  const overpaid = useMemo(() => credits.reduce((s, a) => s + Math.max(0, bal[a.id] ?? 0), 0), [credits, bal])
  const dueTotal = useMemo(() => [...dueInMonth(txs, credits, ym).values()].reduce((s, v) => s + v, 0), [txs, credits, ym])
  const agg = useMemo(() => byCategory(txs, cats, ym, 'expense'), [txs, cats, ym])
  // 和统计页共用 categoryColor：分类颜色跟着名字走，不跟名次走。
  // 以前这里是一串写死的颜色按名次发，同一个分类在两页颜色不一样，对着看会错乱；
  // 而且那串还是 09-05 换暖色主题之前的冷色。
  const pieColors = useMemo(() => agg.map((a, i) => categoryColor(a.name, i)), [agg])
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
      color: pieColors,
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
    [agg, pieColors],
  )

  return (
    <div className="px-4 pb-6">
      <div className="flex items-baseline justify-between pt-4 pb-3">
        <Link to="/ledger" className="text-2xl font-bold">
          {fmtMonthZh(ym)}
        </Link>
        <span className="text-xs text-muted">{syncing ? '同步中…' : ''}</span>
      </div>

      {/* 同步失败时首页要看得见：账户页那行字要翻到账户页才看得到，
          而首页是打开最多的一页。文案必须一行放得下，所以只说结论不解释原因。 */}
      {outboxCount > 0 ? (
        <div className="card mb-3 flex items-center gap-2 px-3 py-2.5 bg-brand-soft border border-brand">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-brand-ink shrink-0">
            <path d="M12 16V4M8 8l4-4 4 4M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2" />
          </svg>
          <span className="flex-1 min-w-0 truncate text-xs text-brand-ink">{outboxCount} 笔还没上传，联网后自动补</span>
          <button
            type="button"
            className="shrink-0 rounded-full bg-brand text-on-brand text-xs font-medium px-3 py-1 disabled:opacity-60"
            disabled={syncing}
            onClick={() => void flushOutbox()}
          >
            {syncing ? '上传中' : '立即上传'}
          </button>
        </div>
      ) : syncFailed ? (
        <div className="card mb-3 flex items-center gap-2 px-3 py-2.5 bg-expense-soft border border-expense/25">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-expense shrink-0">
            <path d="M12 9v4.5M12 17h.01M10.6 3.9L2.5 17.6A1.6 1.6 0 003.9 20h16.2a1.6 1.6 0 001.4-2.4L13.4 3.9a1.6 1.6 0 00-2.8 0z" />
          </svg>
          <span className="flex-1 min-w-0 truncate text-xs text-expense">同步失败，数据可能不是最新</span>
          <button
            type="button"
            className="shrink-0 rounded-full bg-expense text-white text-xs font-medium px-3 py-1 disabled:opacity-60"
            disabled={syncing}
            onClick={() => void refresh()}
          >
            {syncing ? '重试中' : '重试'}
          </button>
        </div>
      ) : null}

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
          {/* 笔数用户说不需要看，只留一个「可以点」的箭头 */}
          <span className="block text-xs text-muted mt-0.5">{dayStat.count ? '›' : '还没记账 ›'}</span>
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
        <div className="flex justify-between items-baseline">
          <span className="text-xs text-muted">总资产</span>
          <Link to="/accounts" className="text-xs text-brand-ink">
            账户 ›
          </Link>
        </div>
        {/* 合计原来是右上角一行小字，和「账户」二字一样大，容易滑过去。
            升成大数字打头，四张明细卡退到下面：先看总数，再看拆分。 */}
        {/* 大数字就是下面四张卡之和。不能用 totalOf(bal)+debt：debt 只加回负余额，
            某个白条多还成正数时那笔会留在合计里，卡片却没有它，两个数对不上。 */}
        <div className="num text-3xl font-semibold tracking-tight mb-3">{fmtYuan(assetTotal, { symbol: true })}</div>
        <div className="grid grid-cols-2 gap-2">
          {assets.map((a) => (
            // 底色是各家品牌色兑白到 7%（accountTint）。原来是 bg-bg，而它等于页面背景色，
            // 格子压在白卡片上根本分不开，四个账户看着像一段文字
            <Link key={a.id} to="/accounts" className="rounded-xl px-3 py-2.5 flex items-center gap-2" style={{ background: accountTint(a.name) }}>
              <AccountIcon name={a.name} size={28} />
              <span className="min-w-0">
                <span className="block text-xs text-muted truncate">{a.name}</span>
                <span className={`block num font-semibold ${(bal[a.id] ?? 0) < 0 ? 'text-expense' : ''}`}>{fmtYuan(bal[a.id] ?? 0)}</span>
              </span>
            </Link>
          ))}
        </div>
        {credits.length && (debt > 0 || dueTotal > 0 || overpaid > 0) ? (
          <Link to="/accounts" className="mt-2.5 pt-2.5 border-t border-line flex justify-between items-baseline text-xs">
            <span className="text-muted">{debt > 0 || !overpaid ? '白条待还' : '白条多还'}</span>
            <span className="num">
              {debt > 0 ? <span className="text-expense font-medium">{fmtYuan(-debt)}</span> : <span className="text-income font-medium">{fmtYuan(overpaid)}</span>}
              {dueTotal > 0 ? <span className="text-muted"> · 本月应还 {fmtYuan(dueTotal)}</span> : null}
              <span className="text-brand-ink"> ›</span>
            </span>
          </Link>
        ) : null}
      </div>

      <div className="card p-4 mb-3">
        <div className="flex justify-between items-baseline mb-2">
          <span className="text-sm text-muted">本月支出用途</span>
          <Link to="/stats" className="text-xs text-brand-ink">
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
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: pieColors[i % pieColors.length] }} />
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
          <Link to="/ledger" className="text-xs text-brand-ink">
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
