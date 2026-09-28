import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DatePicker } from './DatePicker'
import { amountText } from './TxRow'
import { effectiveSwipe, readSwipe, SWIPE_KEY, SWIPE_LABEL, swipeOffset, swipeOutcome, SWIPE_DEAD_PX, type SwipeAction, type SwipeConfig } from '../lib/gesture'
import { useActiveAccounts, useStore } from '../lib/store'
import type { Transaction } from '../types'

interface Props {
  tx: Transaction
  children: React.ReactNode
}

/**
 * 流水行的左滑 / 右滑（方案甲，用户 2026-09-28 定）：一边一个动作，滑过 SWIPE_TRIGGER_PX 松手就触发。
 * 动作从设置里读；外页面下 hide 当 none（gesture.ts 的 effectiveSwipe，死规则；gesture.test.ts 守着这个文件不许出现那四个字，注释也算）。
 *
 * 手势用 pointer 事件，容器上 touch-action: pan-y：竖着滚交给浏览器，横向拖过 SWIPE_DEAD_PX 才接管。
 * 一旦判定为竖滚（|dy| > |dx|）就整次放弃，避免列表滚动时行跟着抖。
 */
export function TxSwipe({ tx, children }: Props) {
  const nav = useNavigate()
  const mode = useStore((s) => s.mode)
  const removeTx = useStore((s) => s.removeTx)
  const addTx = useStore((s) => s.addTx)
  const editTx = useStore((s) => s.editTx)
  const showToast = useStore((s) => s.showToast)
  const accounts = useActiveAccounts()
  const cfg = effectiveSwipe(useSwipeConfig(), mode)

  const [dx, setDx] = useState(0)
  const [animating, setAnimating] = useState(false)
  const [dateOpen, setDateOpen] = useState(false)
  const start = useRef<{ x: number; y: number; id: number; horizontal: boolean | null } | null>(null)

  async function run(action: SwipeAction) {
    if (action === 'edit') nav(`/add?id=${tx.id}`)
    else if (action === 'duplicate') nav(`/add?copy=${tx.id}`)
    else if (action === 'date') setDateOpen(true)
    else if (action === 'delete') {
      // 不弹确认框，靠撤销兜底：撤销 = 原样再记一笔（同一个 id，云端已删就是干净的插入；没网时队列里的「删」被「加」覆盖）
      const ok = await removeTx(tx.id)
      if (ok) showToast(`已删除 ${amountText(tx)}`, async () => void (await addTx(tx)))
    } else if (action === 'hide') {
      // 只有里页面、且不涉及白条（白条不参与里外）才切换；外页面根本走不到这里（effectiveSwipe 已换成 none）
      const credit = new Set(accounts.filter((a) => a.kind === 'credit').map((a) => a.id))
      const touchesCredit = (tx.account_id !== null && credit.has(tx.account_id)) || (tx.to_account_id !== null && credit.has(tx.to_account_id))
      if (mode === 'inner' && !touchesCredit) await editTx({ ...tx, hidden: tx.hidden ? null : true })
    }
  }

  const onDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId, horizontal: null }
    setAnimating(false)
  }
  const onMove = (e: React.PointerEvent) => {
    const s = start.current
    if (!s || s.id !== e.pointerId) return
    const mx = e.clientX - s.x
    const my = e.clientY - s.y
    if (s.horizontal === null) {
      if (Math.abs(mx) < SWIPE_DEAD_PX && Math.abs(my) < SWIPE_DEAD_PX) return
      s.horizontal = Math.abs(mx) > Math.abs(my)
      if (!s.horizontal) return // 竖滚，整次放弃
      ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    }
    if (!s.horizontal) return
    setDx(swipeOffset(mx, cfg))
  }
  const onUp = (e: React.PointerEvent) => {
    const s = start.current
    if (!s || s.id !== e.pointerId) return
    start.current = null
    if (!s.horizontal) return
    const outcome = swipeOutcome(e.clientX - s.x, e.clientY - s.y, cfg)
    setAnimating(true)
    setDx(0)
    if (outcome) void run(cfg[outcome])
  }
  const cancel = () => {
    if (!start.current) return
    start.current = null
    setAnimating(true)
    setDx(0)
  }

  const side: 'left' | 'right' | null = dx < 0 ? 'left' : dx > 0 ? 'right' : null
  const action = side ? cfg[side] : 'none'
  const bg = action === 'delete' ? 'bg-expense text-white' : action === 'edit' ? 'bg-brand text-on-brand' : 'bg-brand-soft text-brand-ink'

  return (
    <div className="relative overflow-hidden" style={{ touchAction: 'pan-y' }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={cancel}>
      {/* 动作区只在拖动时画：静止时什么都没有，看起来就是普通一行 */}
      {side ? (
        <div className={`absolute inset-0 flex items-center px-5 text-sm font-semibold ${bg} ${side === 'left' ? 'justify-end' : 'justify-start'}`} aria-hidden>
          {SWIPE_LABEL[action]}
        </div>
      ) : null}
      <div className="relative bg-card" style={{ transform: `translateX(${dx}px)`, transition: animating ? 'transform .18s ease-out' : 'none' }}>
        {/* 拖过死区之后这一行的点击要吞掉，否则松手时会顺带进编辑页 */}
        <div style={{ pointerEvents: dx !== 0 ? 'none' : undefined }}>{children}</div>
      </div>
      {cfg.left === 'date' || cfg.right === 'date' ? (
        <DatePicker
          open={dateOpen}
          value={tx.date}
          onPick={(d) => {
            if (d !== tx.date) void editTx({ ...tx, date: d })
          }}
          onClose={() => setDateOpen(false)}
        />
      ) : null}
    </div>
  )
}

/** 设置页改了配置，同一次会话里列表要立刻跟着变：监听 storage 事件不够（同标签页不触发），用自定义事件 */
function useSwipeConfig(): SwipeConfig {
  const [cfg, setCfg] = useState<SwipeConfig>(() => readSwipe())
  useEffect(() => {
    const on = () => setCfg(readSwipe())
    window.addEventListener(SWIPE_KEY, on)
    window.addEventListener('storage', on)
    return () => {
      window.removeEventListener(SWIPE_KEY, on)
      window.removeEventListener('storage', on)
    }
  }, [])
  return cfg
}
