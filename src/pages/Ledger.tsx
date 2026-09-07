import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { AccountIcon } from '../components/AccountIcon'
import { ChipGroup } from '../components/ChipGroup'
import { MonthPicker } from '../components/MonthPicker'
import { Sheet } from '../components/Sheet'
import { TxRow } from '../components/TxRow'
import { groupByDay, inMonth, monthSummary, monthTotals, splitAccounts } from '../lib/compute'
import type { Category } from '../types'
import { searchSummary, searchTx, type SearchNames } from '../lib/search'
import { fmtDateRel, fmtDateZh, monthOf, today } from '../lib/date'
import { useAccountMap, useCategoryMap, useRecentState } from '../lib/hooks'
import { CHILD_NONE, CREDIT_ALL, isFiltered, matchesFilter, NO_FILTER, type LedgerFilter } from '../lib/filter'
import { fmtYuan } from '../lib/money'
import { useActiveAccounts, useStore } from '../lib/store'

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
  // 月份、搜索词、筛选都是「这次在看什么」：点进一笔改完回来还在，隔几个小时再开就回本月。
  // 从别的页带参数跳过来时参数优先。
  const [ym, setYm] = useRecentState('jz_ledger_ym', () => {
    const d = params.get('date')
    return d ? monthOf(d) : params.get('ym') || monthOf(today())
  })
  const [target, setTarget] = useState<string | null>(() => params.get('date'))
  const scrolledFor = useRef<string | null>(null)
  const stickyRef = useRef<HTMLDivElement>(null)

  // 从统计页跳过来时带着 ym / date，点二级分类进来还带着 type / cat / sub
  useEffect(() => {
    const qYm = params.get('ym')
    const qDate = params.get('date')
    const qCat = params.get('cat')
    // 没带参数就什么都不做：清空参数会让本 effect 再跑一次，
    // 那次不能把刚设好的状态冲掉
    if (!qYm && !qDate && !qCat) return
    if (qYm || qDate) {
      setYm(qDate ? monthOf(qDate) : (qYm as string))
      setTarget(qDate)
      scrolledFor.current = null
    }
    if (qCat) {
      // 搜索一开就无视月份，那样带过来的月份和分类会对不上，所以先关掉
      setQ('')
      setSearchOpen(false)
      setFilter({ type: params.get('type') || 'all', accountId: 'all', parentId: qCat, childId: params.get('sub') || 'all' })
    }
    setParams({}, { replace: true })
  }, [params, setParams])
  const [q, setQ] = useRecentState('jz_ledger_q', '')
  const [searchOpen, setSearchOpen] = useRecentState('jz_ledger_searchOpen', false)
  // 搜索是跨月的——要找三个月前那笔窗帘钱，不该先翻到那个月。
  // 所以一旦输入内容，月份就不参与过滤了，顶上的月份选择器也收起来。
  const searching = q.trim() !== ''
  const [filter, setFilter] = useRecentState<LedgerFilter>('jz_ledger_filter', NO_FILTER)
  const { type, accountId, parentId, childId } = filter
  const setType = (type: string) => setFilter({ ...filter, type })
  const setAccountId = (accountId: string) => setFilter({ ...filter, accountId })
  // 换一级分类就把二级清掉：上一个一级的二级挂在新一级下面是筛不出东西的
  const setParentId = (parentId: string) => setFilter({ ...filter, parentId, childId: 'all' })
  const setChildId = (childId: string) => setFilter({ ...filter, childId })
  const [open, setOpen] = useState(false)

  // 底部「流水」标签被再点一次时回到默认：本月、不筛选、不搜索、滚回顶部。
  // 和统计页共用 TabBar 那套 resetAt 机制。这里连月份一起重置——统计页刻意不重置，
  // 因为它的月份和时间范围是用户为了看某段趋势刚挑的；流水页的「默认」就是本月流水。
  const resetAt = (useLocation().state as { resetAt?: number } | null)?.resetAt
  useEffect(() => {
    if (!resetAt) return
    setYm(monthOf(today()))
    setQ('')
    setSearchOpen(false)
    setFilter(NO_FILTER)
    setTarget(null)
    setOpen(false)
    scrolledFor.current = null
    document.querySelector('.app-main')?.scrollTo({ top: 0 })
  }, [resetAt])

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

  // 账户筛选分两级：资产账户 + 「白条」，选到白条再展开四个平台（和记账页同一个样子）
  const { assets, credits } = useMemo(() => splitAccounts(accounts), [accounts])
  const creditIds = useMemo(() => new Set(credits.map((c) => c.id)), [credits])
  const onCredit = accountId === CREDIT_ALL || creditIds.has(accountId)
  // 归档的分类平时不出现在 chip 里，但「正在筛的那一个」必须留着：
  // 从统计页点一个归档分类跳过来时，列表是对的，chip 却一个都不高亮，看着像筛选坏了。
  const keep = (c: Category, current: string) => !c.is_archived || c.id === current
  const roots = useMemo(
    () => cats.filter((c) => !c.parent_id && keep(c, parentId)).sort((a, b) => (a.kind === b.kind ? a.sort - b.sort : a.kind === 'expense' ? -1 : 1)),
    [cats, parentId],
  )
  // 分类筛选也分两级：选了具体一级才展开它的二级（和账户里的白条同一个样子）
  const children = useMemo(
    () => (parentId === 'all' || parentId === 'none' ? [] : cats.filter((c) => c.parent_id === parentId && keep(c, childId)).sort((a, b) => a.sort - b.sort)),
    [cats, parentId, childId],
  )
  const label = (c: Category) => (c.is_archived ? `${c.name}（已归档）` : c.name)

  const list = useMemo(() => {
    const base = searching ? searchTx(txs, q, names) : txs
    const rootOf = (id: string) => {
      const c = catMap.get(id)
      return c ? (c.parent_id ?? c.id) : undefined
    }
    return base.filter((t) => (searching || inMonth(t, ym)) && matchesFilter(t, filter, rootOf, creditIds))
  }, [txs, ym, filter, catMap, searching, q, names, creditIds])

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
  const filtered = isFiltered(filter)

  return (
    <div className="pb-6">
      <div ref={stickyRef} className="sticky top-0 z-10 bg-bg px-4 pt-3 pb-2">
        {searchOpen ? (
          <div className="flex items-center gap-2 rounded-xl bg-card border border-line px-3 py-2 mb-2">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted shrink-0">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
            </svg>
            <input
              autoFocus
              className="flex-1 min-w-0 bg-transparent outline-none text-sm"
              placeholder="搜备注、分类、账户、金额"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <button
              type="button"
              className="text-muted text-sm px-1"
              aria-label="关闭搜索"
              onClick={() => {
                setQ('')
                setSearchOpen(false)
              }}
            >
              取消
            </button>
          </div>
        ) : null}
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
          <span className="flex items-center gap-1.5">
            {searchOpen ? null : (
              <button type="button" className="chip" style={{ padding: '5px 9px' }} aria-label="搜索" onClick={() => setSearchOpen(true)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <circle cx="11" cy="11" r="7" />
                  <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
                </svg>
              </button>
            )}
            <button type="button" className={`chip ${filtered ? 'on' : ''}`} style={{ padding: '5px 10px' }} onClick={() => setOpen(true)}>
              筛选{filtered ? ' ·' : ''}
            </button>
          </span>
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
        <ChipGroup
          options={[
            { id: 'all', label: '全部' },
            ...assets.map((a) => ({ id: a.id, label: a.name, node: <AccountIcon name={a.name} size={18} /> })),
            // 选了单个平台时这个 chip 只描一圈边（半选），提示「范围在白条里」但不假装是当前值
            ...(credits.length ? [{ id: CREDIT_ALL, label: '白条', node: <AccountIcon name="白条" size={18} />, className: onCredit && accountId !== CREDIT_ALL ? 'border-brand text-brand-ink' : undefined }] : []),
            { id: 'none', label: '未指定' },
          ]}
          value={accountId === CREDIT_ALL ? CREDIT_ALL : onCredit ? '' : accountId}
          onChange={(id) => {
            // 已经选了某个平台时再点「白条」，不该悄悄把范围放大回四个平台
            if (id === CREDIT_ALL && onCredit) return
            setAccountId(id)
          }}
          className={onCredit ? 'mb-2' : 'mb-4'}
        />
        {onCredit ? (
          <ChipGroup
            options={[{ id: CREDIT_ALL, label: '全部白条' }, ...credits.map((a) => ({ id: a.id, label: a.name, node: <AccountIcon name={a.name} size={18} /> }))]}
            value={accountId}
            onChange={setAccountId}
            className="mb-4 pl-2.5 border-l-2 border-brand"
          />
        ) : null}
        <div className="text-xs text-muted mb-2">分类</div>
        <ChipGroup
          options={[{ id: 'all', label: '全部' }, ...roots.map((c) => ({ id: c.id, label: label(c), icon: c.icon })), { id: 'none', label: '未分类' }]}
          value={parentId}
          onChange={setParentId}
          className={children.length ? 'mb-2' : 'mb-4'}
        />
        {children.length ? (
          <ChipGroup
            options={[
              { id: 'all', label: '全部' },
              ...children.map((c) => ({ id: c.id, label: label(c), icon: c.icon })),
              // 直接记在一级上、没选二级的那几笔，统计页饼图里也叫这个名字
              { id: CHILD_NONE, label: '未细分' },
            ]}
            value={childId ?? 'all'}
            onChange={setChildId}
            className="mb-4 pl-2.5 border-l-2 border-brand"
          />
        ) : null}
        <div className="flex gap-2">
          <button
            type="button"
            className="flex-1 chip text-center"
            onClick={() => setFilter(NO_FILTER)}
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
