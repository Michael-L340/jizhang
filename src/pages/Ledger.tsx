import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ChipGroup } from '../components/ChipGroup'
import { MonthPicker } from '../components/MonthPicker'
import { Sheet } from '../components/Sheet'
import { TxRow } from '../components/TxRow'
import { groupByDay, inMonth, monthSummary, monthTotals } from '../lib/compute'
import { searchSummary, searchTx, type SearchNames } from '../lib/search'
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
  const showToast = useStore((s) => s.showToast)

  const [params, setParams] = useSearchParams()
  const [ym, setYm] = useState(() => {
    const d = params.get('date')
    return d ? monthOf(d) : params.get('ym') || monthOf(today())
  })
  const [target, setTarget] = useState<string | null>(() => params.get('date'))
  const scrolledFor = useRef<string | null>(null)
  const stickyRef = useRef<HTMLDivElement>(null)

  // 从统计页跳过来时带着 ym / date
  useEffect(() => {
    const qYm = params.get('ym')
    const qDate = params.get('date')
    // 没带参数就什么都不做：清空参数会让本 effect 再跑一次，
    // 那次不能把刚设好的状态冲掉
    if (!qYm && !qDate) return
    setYm(qDate ? monthOf(qDate) : (qYm as string))
    setTarget(qDate)
    scrolledFor.current = null
    setParams({}, { replace: true })
  }, [params, setParams])
  const [q, setQ] = useState('')
  // 搜索是跨月的——要找三个月前那笔窗帘钱，不该先翻到那个月。
  // 所以一旦输入内容，月份就不参与过滤了，顶上的月份选择器也收起来。
  const searching = q.trim() !== ''
  const [type, setType] = useState<string>('all')
  const [accountId, setAccountId] = useState<string>('all')
  const [parentId, setParentId] = useState<string>('all')
  const [open, setOpen] = useState(false)

  // 分类给「一级 · 二级」，两级都能搜到；账户给账户名。搜索模块自己不认识 store。
  const names: SearchNames = useMemo(
    () => ({
      category: (id) => {
        const c = id ? catMap.get(id) : undefined
        if (!c) return ''
        const parent = c.parent_id ? catMap.get(c.parent_id) : undefined
        return parent ? `${parent.name} ${c.name}` : c.name
      },
      account: (id) => (id ? (accMap.get(id)?.name ?? '') : ''),
    }),
    [catMap, accMap],
  )

  const roots = useMemo(() => cats.filter((c) => !c.parent_id && !c.is_archived).sort((a, b) => (a.kind === b.kind ? a.sort - b.sort : a.kind === 'expense' ? -1 : 1)), [cats])

  const list = useMemo(() => {
    const base = searching ? searchTx(txs, q, names) : txs
    return base.filter((t) => {
      if (!searching && !inMonth(t, ym)) return false
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
  }, [txs, ym, type, accountId, parentId, catMap, searching, q, names])

  const totalsByMonth = useMemo(() => monthTotals(txs), [txs])
  const groups = useMemo(() => groupByDay(list), [list])

  // 吸顶栏的真实高度：写死的数字会随内容变化而失准，滚动就会过头
  useLayoutEffect(() => {
    const h = stickyRef.current?.offsetHeight
    if (h) document.documentElement.style.setProperty('--ledger-sticky-h', `${h}px`)
  })

  // 从图表或首页跳过来：定位到那一天并短暂高亮；那天没记录就提示一下
  useLayoutEffect(() => {
    if (!target || scrolledFor.current === target) return
    const el = document.getElementById(`day-${target}`)
    if (el) {
      scrolledFor.current = target
      // 目标是当月第一组（点「今日开支」进来几乎总是如此）就直接回到顶部，
      // 让吸顶栏和当天标题都完整可见，不做多余的滚动
      if (groups[0]?.date === target) {
        el.closest('.app-main')?.scrollTo({ top: 0, behavior: 'smooth' })
      } else {
        requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }))
      }
      const t = setTimeout(() => setTarget(null), 2400)
      return () => clearTimeout(t)
    }
    // 那个月一条记录都没有时也要收尾，否则提示永远不弹、target 永不清空
    scrolledFor.current = target
    showToast(`${fmtDateZh(target, false)} 没有记录`)
    setTarget(null)
  }, [target, groups, showToast])
  // 按筛选后的口径算。传全量 txs 的话，选了「微信」之后列表和每日小计都只剩微信，
  // 顶上这行却还是全月全账户的数，两个合计对不上会让人以为漏了记录。
  // list 已经按 inMonth 过滤过，monthSummary 里那次判断只是冗余。
  const sum = useMemo(() => monthSummary(list, ym), [list, ym])
  const hits = useMemo(() => searchSummary(list), [list])
  const filtered = type !== 'all' || accountId !== 'all' || parentId !== 'all'

  return (
    <div className="pb-6">
      <div ref={stickyRef} className="sticky top-0 z-10 bg-bg px-4 pt-3 pb-2">
        <div className="flex items-center gap-2 rounded-xl bg-card border border-line px-3 py-2 mb-2">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted shrink-0">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
          </svg>
          <input
            className="flex-1 min-w-0 bg-transparent outline-none text-sm"
            placeholder="搜备注、分类、账户、金额"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {searching ? (
            <button type="button" className="text-muted text-lg leading-none px-1" aria-label="清空搜索" onClick={() => setQ('')}>
              ×
            </button>
          ) : null}
        </div>
        {searching ? null : (
        <MonthPicker
          value={ym}
          onChange={(v) => {
            setTarget(null)
            setYm(v)
          }}
          totals={totalsByMonth}
        />
        )}
        <div className="flex items-center justify-between text-xs text-muted px-1">
          <span className="num">
            {searching ? (
              hits.count ? (
                <>
                  找到 {hits.count} 笔
                  {hits.expense ? (
                    <>
                      {' · '}支出 <span className="text-expense">{fmtYuan(hits.expense)}</span>
                    </>
                  ) : null}
                  {hits.income ? (
                    <>
                      {' · '}收入 <span className="text-income">{fmtYuan(hits.income)}</span>
                    </>
                  ) : null}
                </>
              ) : (
                '没有找到'
              )
            ) : (
              <>
            {filtered ? '已筛选 · ' : ''}
            {sum.expense || sum.income ? (
              <>
                {sum.expense ? (
                  <>
                    支出 <span className="text-expense">{fmtYuan(sum.expense)}</span>
                  </>
                ) : null}
                {sum.expense && sum.income ? ' · ' : ''}
                {sum.income ? (
                  <>
                    收入 <span className="text-income">{fmtYuan(sum.income)}</span>
                  </>
                ) : null}
              </>
            ) : (
              // 筛「转账」或「校准」时收支必然是 0（铁律：这两种不进收支统计）。
              // 显示两个 0.00 而下面列着十几笔，看起来更像坏了，所以改成显示笔数。
              `${list.length} 笔`
            )}
              </>
            )}
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
          <div key={g.date} id={`day-${g.date}`} className="mt-3" style={{ scrollMarginTop: 'var(--ledger-sticky-h, 92px)' }}>
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
            <div className={`card mx-4 divide-y divide-line overflow-hidden ${target === g.date ? 'day-flash' : ''}`}>
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
