import { NavLink } from 'react-router-dom'

const tabs = [
  { to: '/', label: '首页', icon: 'M3 11l9-8 9 8v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z' },
  { to: '/ledger', label: '流水', icon: 'M4 6h16M4 12h16M4 18h10' },
  { to: '/add', label: '记账', icon: 'M12 5v14M5 12h14' },
  { to: '/stats', label: '统计', icon: 'M5 20V10M12 20V4M19 20v-7' },
  { to: '/accounts', label: '账户', icon: 'M3 7h18v12H3zM3 7l2-3h14l2 3M16 13h2' },
]

export function TabBar() {
  return (
    <nav className="safe-bottom bg-card border-t border-line">
      <div className="grid grid-cols-5 h-14">
        {tabs.map((t) =>
          t.to === '/add' ? (
            <NavLink key={t.to} to={t.to} className="flex items-center justify-center" aria-label="记一笔">
              <span className="w-[46px] h-[46px] -mt-2 rounded-full bg-brand text-white flex items-center justify-center shadow-md ring-4 ring-card">
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
