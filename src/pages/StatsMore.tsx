// 进阶分析：统计页底部「进阶分析 ›」进来的一页，一张图一张卡。
//
// 图怎么算全在 lib/more/*.ts（纯函数），这里只管三件事：备好那本账和时间、按「自定义」排好的顺序画卡、接点击。
// 月份和时间范围不另起炉灶——和统计页读同一对钥匙、调同一个 rangeBounds，两页的「近一年」是同一段。
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { ChartOption } from '../components/Chart'
import { MonthPicker } from '../components/MonthPicker'
import { RANGE_LABEL, RangeSheet, type RangeValue } from '../components/RangeSheet'
import { Sheet } from '../components/Sheet'
import { firstFlowDate, monthTotals } from '../lib/compute'
import { fmtDateZh, monthOf, today } from '../lib/date'
import { outerBook } from '../lib/facade'
import { usePersistedState, useRecentState } from '../lib/hooks'
import { defaultLayout, isShown, LAYOUT_STORAGE_KEY, moveKey, normalizeLayout, shownKeys, toggleKey, type MoreKey, type MoreLayout } from '../lib/more/layout'
import { buildSafely, MORE_CHARTS, noteWithTap, pointMode, rangeHint } from '../lib/more/registry'
import type { MoreChart, MoreInput, MoreTile } from '../lib/more/types'
import { rangeBounds } from '../lib/range'
import { useActiveAccounts, useStore } from '../lib/store'

// 多注册了桑基、日历、雷达那几个模块的 Chart；统计页用的那个不背这些
const Chart = lazy(() => import('../components/ChartMore'))
/** y 轴那列数字要占掉的宽度，和统计页同一个数 */
const AXIS_GUTTER = 44

/**
 * 上次离开这一页时滚到了哪（.app-main 的 scrollTop）。只放内存：从这一页点图跳去流水、
 * 再点底部「统计」回来（TabBar 记得上次停在进阶分析），接着看刚才那张卡，不用从头找。
 * 只有从统计页的入口卡进来才回到顶上（入口卡带 state.fromEntry）。
 */
let savedScroll = 0

export function StatsMore() {
  const txs = useStore((s) => s.transactions)
  const cats = useStore((s) => s.categories)
  const mode = useStore((s) => s.mode)
  const fadj = useStore((s) => s.facade_adjusts)
  // 活跃账户（含白条）：白条那张图要认得白条；outerBook 也要靠账户种类认白条
  const accounts = useActiveAccounts()
  // 当前模式那本账。这一页每张图只吃它，原始 txs 除了这一行哪儿都不许碰（facade.test.ts 守着）
  const otxs = useMemo(() => outerBook(txs, accounts, fadj, mode), [txs, accounts, fadj, mode])
  const nav = useNavigate()
  const loc = useLocation()

  // 和统计页同一对钥匙：这边翻了月份、换了范围，回统计页也是这个
  const [ym, setYm] = useRecentState('jz_stats_ym', () => monthOf(today()))
  const [range, setRange] = usePersistedState<RangeValue>('jz_stats_range', { kind: 'year' })
  const [rangeOpen, setRangeOpen] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)

  // 存的是原样，读出来一律过 normalizeLayout：不认识的丢掉、缺的补到末尾、坏了回默认
  const [stored, setStored] = usePersistedState<unknown>(LAYOUT_STORAGE_KEY, null)
  const layout = useMemo(() => normalizeLayout(stored), [stored])
  const save = (l: MoreLayout) => setStored(l)

  const earliest = useMemo(() => firstFlowDate(otxs), [otxs])
  const { start, end } = useMemo(() => rangeBounds(range, ym, earliest, today()), [range, ym, earliest])
  const t = today()
  const input = useMemo<MoreInput>(() => ({ txs: otxs, accounts, cats, ym, start, end, today: t }), [otxs, accounts, cats, ym, start, end, t])
  const totalsByMonth = useMemo(() => monthTotals(otxs), [otxs])

  // 卡片内宽 = 整页（最宽 430）减去页面和卡片的左右内边距，和统计页一样估
  const chartW = Math.min(typeof window === 'undefined' ? 393 : window.innerWidth, 430) - 64
  const axisWidth = chartW - AXIS_GUTTER

  // 算过的图按 key 缓存：开关、调顺序时别的卡不重算，也就不会整页重放一遍入场动画。
  // 账本、月份、范围、宽度一变，整张缓存换新的
  const cache = useMemo(() => new Map<MoreKey, MoreChart>(), [input, chartW])
  const keys = shownKeys(layout)
  const charts = keys.map((k) => {
    let c = cache.get(k)
    if (!c) {
      c = buildSafely(k, input, { chartWidth: chartW, axisWidth })
      cache.set(k, c)
    }
    return c
  })
  const hint = rangeHint(keys)

  // 从统计页入口卡进来（state.fromEntry）：滚动容器还停在统计页最底下，回到顶上。
  // 别的路进来（点底部「统计」回来、系统返回）：回到上次离开时的位置，刚才点的那张卡还在眼前。
  // 卡片的高度第一帧就定了（图没加载完时 Suspense 占着同样高的位置），所以 layout effect 里滚就准
  const fromEntry = Boolean((loc.state as { fromEntry?: boolean } | null)?.fromEntry)
  useLayoutEffect(() => {
    const el = document.querySelector('.app-main')
    if (!el) return
    if (fromEntry) savedScroll = 0
    el.scrollTo({ top: savedScroll })
    const onScroll = () => {
      savedScroll = el.scrollTop
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // 把这条历史记录上的记号擦掉：不然从流水页按系统返回回到这一条，又被当成「从入口进来」滚回顶上
  useEffect(() => {
    if (fromEntry) nav(loc.pathname, { replace: true, state: null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const go = (q: string | null) => {
    if (q) nav(`/ledger?${q}`)
  }

  return (
    <div className="px-4 pb-6">
      <div className="flex items-center justify-between pt-4 pb-1">
        <button type="button" className="text-brand-ink text-sm -ml-1 px-1 py-1 w-16 text-left" onClick={() => nav(-1)}>
          ‹ 统计
        </button>
        <span className="text-lg font-bold">进阶分析</span>
        <button type="button" className="text-sm text-brand-ink px-1 py-1 w-16 text-right" onClick={() => setCustomOpen(true)}>
          自定义
        </button>
      </div>

      <MonthPicker value={ym} onChange={setYm} totals={totalsByMonth} />

      {/* 时间段按钮只管一部分图（registry 的 scope）：写明是哪几张，其余跟着上面的月份。
          打开的图没有一张跟它走时整行不显示——换了也没图会变，留着只会让人以为按钮坏了 */}
      {hint ? (
        <div className="flex items-center justify-between gap-2 px-1 pb-2">
          <span className="text-[12px] text-muted min-w-0">{hint}</span>
          <button type="button" className="chip flex items-center gap-1 shrink-0" style={{ padding: '5px 10px' }} onClick={() => setRangeOpen(true)}>
            {range.kind === 'custom' ? `${fmtDateZh(start, false)}-${fmtDateZh(end, false)}` : RANGE_LABEL[range.kind]}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="text-muted">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        </div>
      ) : null}

      {charts.length === 0 ? (
        <div className="card px-4 py-10 text-center text-sm text-muted">一张图都没开。点右上角「自定义」挑几张来看。</div>
      ) : (
        charts.map((c) => <MoreCard key={c.key} c={c} onGo={go} />)
      )}

      <RangeSheet open={rangeOpen} value={range} earliest={earliest} onChange={setRange} onClose={() => setRangeOpen(false)} />

      <Sheet open={customOpen} onClose={() => setCustomOpen(false)} title="自定义">
        <div className="text-[12px] text-muted mt-1 mb-1">打开的图按这个顺序从上往下排，箭头调顺序。</div>
        <div className="flex flex-col">
          {layout.order.map((k, i) => {
            const on = isShown(layout, k)
            const title = MORE_CHARTS[k].title
            return (
              <div key={k} className="flex items-center gap-1 py-2 border-b border-line last:border-0">
                <span className={`flex-1 min-w-0 truncate text-[15px] ${on ? '' : 'text-muted'}`}>{title}</span>
                <button
                  type="button"
                  aria-label={`「${title}」往上挪`}
                  disabled={i === 0}
                  className="w-9 h-9 flex items-center justify-center rounded-full text-muted active:bg-bg disabled:opacity-25"
                  onClick={() => save(moveKey(layout, k, -1))}
                >
                  <Arrow dir="up" />
                </button>
                <button
                  type="button"
                  aria-label={`「${title}」往下挪`}
                  disabled={i === layout.order.length - 1}
                  className="w-9 h-9 flex items-center justify-center rounded-full text-muted active:bg-bg disabled:opacity-25"
                  onClick={() => save(moveKey(layout, k, 1))}
                >
                  <Arrow dir="down" />
                </button>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={`显示「${title}」`}
                  className={`ml-1 w-11 h-6 rounded-full shrink-0 flex items-center px-0.5 transition-colors ${on ? 'bg-brand justify-end' : 'bg-line justify-start'}`}
                  onClick={() => save(toggleKey(layout, k))}
                >
                  <span className="w-5 h-5 rounded-full bg-card shadow-sm" />
                </button>
              </div>
            )
          })}
        </div>
        <button type="button" className="w-full mt-3 py-2.5 rounded-xl bg-bg text-sm text-muted" onClick={() => save(defaultLayout())}>
          恢复默认
        </button>
      </Sheet>
    </div>
  )
}

/** 一张图一张卡：标题（旁边是实际算的那段时间）、图（或者那句「没数据」）、小数字、底下一行口径 */
function MoreCard({ c, onGo }: { c: MoreChart; onGo: (q: string | null) => void }) {
  const tap = pointMode(c)
  const h = c.height ?? 220
  const onPoint = c.onPoint
  return (
    <div className="card p-4 mb-3">
      <div className="text-sm font-semibold mb-2">
        {c.title}
        {c.span ? <span className="num text-[11px] font-normal text-muted ml-1.5">· {c.span}</span> : null}
      </div>
      {c.empty ? (
        <div className="text-sm text-muted py-10 text-center">{c.empty}</div>
      ) : c.option ? (
        <Suspense fallback={<div style={{ height: h }} />}>
          <Chart
            option={c.option as ChartOption}
            height={h}
            onAxisClick={tap === 'axis' && onPoint ? (i) => onGo(onPoint(i, 0)) : undefined}
            onItemTap={tap === 'item' && onPoint ? (i, s) => onGo(onPoint(i, s)) : undefined}
          />
        </Suspense>
      ) : null}
      {c.tiles?.length ? <Tiles tiles={c.tiles} onGo={onGo} /> : null}
      <div className="text-[11px] text-muted mt-2 leading-relaxed">{noteWithTap(c)}</div>
    </div>
  )
}

/** 小数字：2、4 个排两列，其余排三列（5 个就是上三下二）。带 go 的那格点一下跳流水（最大的几笔） */
function Tiles({ tiles, onGo }: { tiles: MoreTile[]; onGo: (q: string | null) => void }) {
  const n = tiles.length
  const cols = n === 1 ? 'grid-cols-1' : n === 2 || n === 4 ? 'grid-cols-2' : 'grid-cols-3'
  return (
    <div className={`grid ${cols} gap-1.5 mt-2`}>
      {tiles.map((x, i) => {
        const body = (
          <>
            <div className="text-[11px] text-muted truncate">{x.label}</div>
            <div className="num text-[15px] font-semibold truncate">{x.value}</div>
          </>
        )
        return x.go ? (
          <button key={i} type="button" className="rounded-xl bg-bg px-2.5 py-2 min-w-0 text-left active:opacity-70" onClick={() => onGo(x.go ?? null)}>
            {body}
          </button>
        ) : (
          <div key={i} className="rounded-xl bg-bg px-2.5 py-2 min-w-0">
            {body}
          </div>
        )
      })}
    </div>
  )
}

function Arrow({ dir }: { dir: 'up' | 'down' }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d={dir === 'up' ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} />
    </svg>
  )
}
