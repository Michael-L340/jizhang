import { NavLink, useLocation, useNavigate } from 'react-router-dom'

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
 * 目前只有统计页需要（退出分类下钻），所以只给它挂。
 * 做法是原地 replace 一次并带上时间戳：路由没变，但 location.state 变了，
 * 页面靠它知道「用户又点了一次我」。不用全局事件，免得多一套要维护的东西。
 */
const RESET_ON_REPEAT_TAP = ['/stats']

export function TabBar() {
  const { pathname } = useLocation()
  const nav = useNavigate()
  return (
    <nav className="safe-bottom bg-card border-t border-line">
      <div className="grid grid-cols-5 h-14">
        {tabs.map((t) =>
          t.to === '/add' ? (
            <NavLink key={t.to} to={t.to} className="flex items-center justify-center" aria-label="记一笔">
              <span className="w-11 h-11 rounded-full bg-brand text-white flex items-center justify-center shadow-sm">
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
              className={({ isActive }) => `flex flex-col items-center justify-center gap-0.5 text-[11px] ${isActive ? 'text-brand' : 'text-muted'}`}
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
