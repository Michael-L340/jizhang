import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CatIcon } from './CatIcon'
import { isImgIcon } from '../lib/art'
import { buildPages, firstPageOfGroup, groupIndexOfIcon, pageIndexOf, PER_PAGE, type IconGroup } from '../lib/iconPages'

interface Props {
  /** 当前选中的图标，emoji 或 `img:<名字>` */
  value: string | null | undefined
  onPick: (icon: string) => void
  /** 含「最近用过」「我的图」两个虚拟组，顺序就是底部标签栏的顺序 */
  groups: IconGroup[]
  /** 打开时定位到哪一组（value 没落在任何一组里时用） */
  fallbackGroup?: string
}

/** 一页 8 列 5 行，格子 h-11（44px）、间距 6px */
const PAGE_H = 5 * 44 + 4 * 6

/**
 * 微信表情包那种选图标面板：横滑翻页 + scroll-snap 吸附整页 + 底部分组标签。
 *
 * 为什么不做成竖着一长条分组标题（上一版就是）：图标从 181 个涨到 700 个之后，
 * 竖滑要滑十几屏，想找「交通」得一路翻过去，分组等于白分。
 *
 * 页表、当前页、初始定位全在 lib/iconPages.ts 里算好；这里只负责把它画出来、
 * 以及把 DOM 的 scrollLeft 换算成页号。
 */
export function IconPicker({ value, onPick, groups, fallbackGroup = '主食餐饭' }: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const pages = useMemo(() => buildPages(groups, PER_PAGE), [groups])
  const [page, setPage] = useState(0)

  // 打开时停在 value 所在的那一组。只算一次、之后再不重算：选中一个图标会让 value 变，
  // 跟着重新定位就会把人从当前页弹走（选完「最近用过」里的一个，画面直接跳回它的原组）。
  const initialRef = useRef<number | null>(null)
  if (initialRef.current === null) initialRef.current = firstPageOfGroup(pages, groupIndexOfIcon(groups, value, fallbackGroup))
  const initial = initialRef.current
  const cur = pages[Math.min(page, pages.length - 1)] ?? pages[0]
  const curGroup = cur ? groups[cur.groupIndex] : undefined

  // useLayoutEffect 而不是 useEffect：useEffect 在绘制之后才跑，面板会先闪一下第一组再跳过去
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    el.scrollLeft = initial * el.clientWidth
    setPage(initial)
  }, [initial])

  // 十八个标签一行放不下，标签栏自己也是横滑的。滑到后面几组时把当前标签带进视野，
  // 否则高亮的那个在屏幕外，看着像没选中。只动标签栏自己的 scrollLeft——
  // 用 scrollIntoView 会连带把外面的弹层一起滚。
  const tabs = useRef<HTMLDivElement>(null)
  const activeGroup = cur?.groupIndex ?? 0
  useLayoutEffect(() => {
    const bar = tabs.current
    const btn = bar?.children[activeGroup] as HTMLElement | undefined
    if (!bar || !btn) return
    if (btn.offsetLeft < bar.scrollLeft) bar.scrollLeft = btn.offsetLeft
    else if (btn.offsetLeft + btn.offsetWidth > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = btn.offsetLeft + btn.offsetWidth - bar.clientWidth
  }, [activeGroup])

  const goto = (pageIdx: number) => {
    const el = scroller.current
    if (!el) return
    // 系统开了「减弱动态效果」就别做平滑滚动：那个设置就是为了不晕
    const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    el.scrollTo({ left: pageIdx * el.clientWidth, behavior: smooth ? 'smooth' : 'auto' })
    setPage(pageIdx)
  }

  return (
    <div>
      <div className="flex items-baseline justify-between px-0.5 pb-1.5 text-xs text-muted">
        <span>{curGroup?.name ?? ''}</span>
        <span className="num">
          {cur ? `第 ${cur.pageInGroup + 1}/${cur.pagesInGroup} 页` : ''}
        </span>
      </div>

      <div
        ref={scroller}
        className="flex overflow-x-auto snap-x snap-mandatory overscroll-x-contain no-scrollbar"
        style={{ height: PAGE_H }}
        onScroll={(e) => setPage(pageIndexOf(e.currentTarget.scrollLeft, e.currentTarget.clientWidth))}
      >
        {pages.map((p, i) => (
          <div key={i} className="shrink-0 w-full snap-start snap-always grid grid-cols-8 grid-rows-5 gap-1.5 content-start">
            {p.items.map((e) => (
              <button
                key={e}
                type="button"
                className={`h-11 rounded-xl text-xl flex items-center justify-center ${value === e ? 'bg-brand-soft ring-2 ring-brand-ink' : 'bg-bg'}`}
                onClick={() => onPick(e)}
              >
                <CatIcon icon={e} size={30} />
              </button>
            ))}
            {/* 空组也有一页。不给一句话的话，点「最近用过」看到的是一片白，像卡住了 */}
            {p.items.length === 0 ? (
              <div className="col-span-8 flex items-center justify-center text-xs text-muted" style={{ height: PAGE_H }}>
                {groups[p.groupIndex]?.name === '最近用过' ? '选过的图标会出现在这里' : '这一组还是空的'}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {/* 页码圆点：只画当前这一组的，十几页的点连成一条线反而看不出在哪 */}
      <div className="flex justify-center gap-1 h-2 mt-1.5">
        {cur && cur.pagesInGroup > 1
          ? Array.from({ length: cur.pagesInGroup }, (_, i) => (
              <span key={i} className={`w-1.5 h-1.5 rounded-full ${i === cur.pageInGroup ? 'bg-brand-ink' : 'bg-line'}`} />
            ))
          : null}
      </div>

      <div ref={tabs} className="flex gap-0.5 mt-1.5 overflow-x-auto no-scrollbar border-t border-line pt-1.5">
        {groups.map((g, gi) => {
          const on = cur?.groupIndex === gi
          return (
            <button
              key={g.name}
              type="button"
              title={g.name}
              aria-label={g.name}
              className={`shrink-0 w-9 h-9 rounded-lg text-lg flex items-center justify-center ${on ? 'bg-brand-soft ring-1 ring-brand-ink' : ''}`}
              onClick={() => goto(firstPageOfGroup(pages, gi))}
            >
              {isImgIcon(g.tab) ? <CatIcon icon={g.tab} size={22} /> : g.tab}
            </button>
          )
        })}
      </div>
    </div>
  )
}
