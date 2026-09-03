import { useEffect } from 'react'
import { createHashRouter, Outlet, RouterProvider } from 'react-router-dom'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { ErrorBoundary } from './components/ErrorBoundary'
import { TabBar } from './components/TabBar'
import { Toast } from './components/Toast'
import { useStore } from './lib/store'
import { Accounts } from './pages/Accounts'
import { Entry } from './pages/Entry'
import { Home } from './pages/Home'
import { Ledger } from './pages/Ledger'
import { Login } from './pages/Login'
import { Settings } from './pages/Settings'
import { Stats } from './pages/Stats'

function UpdateBanner() {
  const { needRefresh, updateServiceWorker } = useRegisterSW({
    onRegisteredSW(_url, r) {
      if (!r) return
      // iOS 主屏 App 长期挂起，靠默认行为很久都不会检查更新；每小时 + 每次切回前台各查一次
      setInterval(() => void r.update(), 60 * 60 * 1000)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void r.update()
      })
    },
  })
  if (!needRefresh[0]) return null
  return (
    <button
      type="button"
      className="w-full bg-brand text-white text-sm py-3 px-4 flex items-center justify-center gap-2 safe-top"
      onClick={() => void updateServiceWorker(true)}
    >
      <span>有新版本</span>
      <span className="rounded-full bg-white/20 px-2.5 py-0.5 text-xs">点此更新</span>
    </button>
  )
}

/** 根：初始化数据、登录门禁、切回前台时同步 */
function Root() {
  const auth = useStore((s) => s.auth)
  const init = useStore((s) => s.init)
  const refresh = useStore((s) => s.refresh)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [refresh])

  if (auth === 'loading') {
    return <div className="app-shell items-center justify-center text-muted text-sm">加载中…</div>
  }
  return (
    <div className="app-shell">
      <UpdateBanner />
      {auth === 'out' ? <Login /> : <Outlet />}
      <Toast />
    </div>
  )
}

/** 带底部 Tab 的外壳 */
function Shell() {
  return (
    <div className="flex-1 min-h-0 flex flex-col safe-top">
      <main className="app-main pb-2">
        <Outlet />
      </main>
      <TabBar />
    </div>
  )
}

const page = (name: string, el: React.ReactNode) => <ErrorBoundary name={name}>{el}</ErrorBoundary>

const router = createHashRouter([
  {
    path: '/',
    element: <Root />,
    children: [
      {
        element: <Shell />,
        children: [
          { index: true, element: page('首页', <Home />) },
          { path: 'ledger', element: page('流水', <Ledger />) },
          { path: 'stats', element: page('统计', <Stats />) },
          { path: 'accounts', element: page('账户', <Accounts />) },
          { path: 'settings', element: page('设置', <Settings />) },
        ],
      },
      { path: 'add', element: page('记一笔', <Entry />) },
    ],
  },
])

export default function App() {
  return <RouterProvider router={router} />
}
