import { useEffect, useRef } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { HOLD_MS } from '../lib/facade'
import { useStore } from '../lib/store'

/**
 * 五个标签页的图标。全部是单条 path，viewBox 24、22px 渲染、1.8 描边。
 *
 * 「流水」原来是三条横线（通用的列表符号），用户嫌丑。2026-09-04 换成带撕口下沿的小票：
 * 语义正对「一笔一笔的账」，而且轮廓在整排里独一无二——量过与邻居的轮廓重合度，
 * 与房子 0.15、与钱包 0.16，而现有的房子/钱包这对已经是 0.28。
 * 换图标前先量一遍：坐标要落在 2~22 的安全区（1.8 的描边贴边会被裁掉半笔），
 * 任意两条平行笔画间距不小于 2 个单位（否则 22px 下会粘连）。
 */
export const tabs = [
  { to: '/', label: '首页', icon: 'M3 11l9-8 9 8v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z' },
  { to: '/ledger', label: '流水', icon: 'M5 3h14v18l-3.5-2-3.5 2-3.5-2L5 21zM9 8.5h6M9 12.5h6' },
  { to: '/add', label: '记账', icon: 'M12 5v14M5 12h14' },
  { to: '/stats', label: '统计', icon: 'M5 20V10M12 20V4M19 20v-7' },
  { to: '/accounts', label: '账户', icon: 'M3 7h18v12H3zM3 7l2-3h14l2 3M16 13h2' },
]

/**
 * 已经停在某个标签上时再点它一次 = 「回到这一页的初始样子」。
 * 做法是原地 replace 一次并带上时间戳：路由没变，但 location.state 变了，
 * 页面靠它知道「用户又点了一次我」。不用全局事件，免得多一套要维护的东西。
 *
 * 「初始样子」各页自己定义，别在这里写死，因为四页要重置的东西完全不同：
 *   首页   只有滚回顶部（这一页没有任何会记住的状态）
 *   流水页 回到本月、清掉筛选和搜索
 *   统计页 只退出分类下钻——月份和时间范围是用户为了看某段趋势刚挑的，不动
 *   账户页 收起白条卡片、关掉弹层；但「还款默认从哪个账户扣」要留着，
 *          那是偏好不是浏览状态
 * 四页都滚回顶部。
 */
const RESET_ON_REPEAT_TAP = ['/', '/ledger', '/stats', '/accounts']

/**
 * 长按 ＋ 切换里外页面。
 *
 * 为什么挂在 ＋ 上：它只有「点一下就走」这一种正常用法，长按是空的，
 * 所以加这个手势不会夺走任何已有功能——点一下照样跳记账页。
 *
 * 三件必须做对的事：
 *   1. iOS 长按链接会弹系统的「拷贝 / 预览」菜单（＋ 本质是个 <a>），
 *      要用 WebkitTouchCallout + userSelect 关掉，光靠 preventDefault 挡不住。
 *   2. 长按结束抬手时浏览器还会补发一次 click，会把人带到记账页。
 *      用 fired 标记在 onClick 里拦掉，并在下一次按下时清零
 *      （长按后手指移开再松手不会触发 click，标记留着会误伤下一次点击）。
 *   3. 手指移动超过阈值就取消，免得滑动时误触。
 *
 * 切换成功不给任何界面提示——「本该跳去记账页却没跳」本身就是信号，
 * 外人看不出，本人一清二楚。加提示反而等于自曝。
 */
function useHoldToggle() {
  const holdRef = useRef<{ timer: number; x: number; y: number } | null>(null)
  const firedRef = useRef(false)

  const cancel = () => {
    if (holdRef.current) {
      clearTimeout(holdRef.current.timer)
      holdRef.current = null
    }
  }
  useEffect(() => cancel, [])

  return {
    onPointerDown(e: React.PointerEvent) {
      firedRef.current = false
      cancel()
      const timer = window.setTimeout(() => {
        firedRef.current = true
        holdRef.current = null
        // 用 getState 而不是订阅 mode：TabBar 不需要因为切换而重渲染，
        // 也就不会有「订阅了却读到上一次渲染时的值」这种闭包问题。
        const s = useStore.getState()
        s.setMode(s.mode === 'inner' ? 'outer' : 'inner')
      }, HOLD_MS)
      holdRef.current = { timer, x: e.clientX, y: e.clientY }
    },
    onPointerMove(e: React.PointerEvent) {
      const h = holdRef.current
      if (h && Math.hypot(e.clientX - h.x, e.clientY - h.y) > 10) cancel()
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClickCapture(e: React.MouseEvent) {
      if (firedRef.current) {
        e.preventDefault()
        e.stopPropagation()
        firedRef.current = false
      }
    },
  }
}

export function TabBar() {
  const { pathname } = useLocation()
  const nav = useNavigate()
  const hold = useHoldToggle()
  return (
    <nav className="safe-bottom bg-card border-t border-line">
      <div className="grid grid-cols-5 h-14">
        {tabs.map((t) =>
          t.to === '/add' ? (
            <NavLink
              key={t.to}
              to={t.to}
              className="flex items-center justify-center"
              aria-label="记一笔"
              draggable={false}
              style={{ WebkitTouchCallout: 'none', WebkitUserSelect: 'none', userSelect: 'none' }}
              {...hold}
            >
              <span className="w-11 h-11 rounded-full bg-brand text-on-brand flex items-center justify-center shadow-sm">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                  <path d={t.icon} />
                </svg>
              </span>
            </NavLink>
          ) : (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.to === '/'}
              onClick={(e) => {
                if (pathname === t.to && RESET_ON_REPEAT_TAP.includes(t.to)) {
                  e.preventDefault()
                  nav(t.to, { replace: true, state: { resetAt: Date.now() } })
                }
              }}
              className={({ isActive }) => `flex flex-col items-center justify-center gap-0.5 text-[11px] ${isActive ? 'text-brand-ink' : 'text-muted'}`}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d={t.icon} />
              </svg>
              {t.label}
            </NavLink>
          ),
        )}
      </div>
    </nav>
  )
}
