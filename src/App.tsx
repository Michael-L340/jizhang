import { useEffect } from 'react'
import { createHashRouter, Outlet, RouterProvider } from 'react-router-dom'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { ErrorBoundary } from './components/ErrorBoundary'
import { TabBar } from './components/TabBar'
import { Toast } from './components/Toast'
import { useStore } from './lib/store'
import { Accounts } from './pages/Accounts'
import { Categories } from './pages/Categories'
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
  // 浮在顶部，不占页面高度。原来是顶部一整条实体，一冒出来整个页面被往下挤一截、
  // 收起时又弹回去（用户 2026-09-07 反馈）。定位方式照抄 Toast：fixed + 整条不吃点击、
  // 只有药丸本身可点，否则这条透明的横条会把它盖住的东西全吃掉。
  // 顶部距离 = 刘海安全区再加 12px，不然在主屏 App 里会顶到状态栏上。
  // z-40 是刻意的：要压过内容（流水页吸顶栏是 z-10），但要让弹层（Sheet z-50）盖住它。
  return (
    <div className="pointer-events-none fixed inset-x-0 z-40 flex justify-center px-4 top-[calc(env(safe-area-inset-top)+12px)]">
      <button
        type="button"
        className="pointer-events-auto flex items-center gap-2 rounded-full bg-brand text-on-brand text-sm font-medium pl-4 pr-1.5 py-1.5 shadow-lg active:opacity-90"
        onClick={() => void updateServiceWorker(true)}
      >
        <span>有新版本</span>
        <span className="rounded-full bg-white/30 px-2.5 py-1 text-xs">点此更新</span>
      </button>
    </div>
  )
}

/** 根：初始化数据、登录门禁、切回前台时同步 */
function Root() {
  const auth = useStore((s) => s.auth)
  const init = useStore((s) => s.init)
  const refresh = useStore((s) => s.refresh)
  const flushOutbox = useStore((s) => s.flushOutbox)
  const noteHidden = useStore((s) => s.noteHidden)
  const noteVisible = useStore((s) => s.noteVisible)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    const onVisible = () => {
      // 里页面有时效：切走超过 60 秒再回来就自动退回外页面（手机放下走开的情况）。
      // 判断放在 store 里，页面只负责报告「切走了 / 回来了」。
      if (document.visibilityState !== 'visible') {
        noteHidden()
        return
      }
      noteVisible()
      void refresh()
    }
    // 断网时同步失败后，只要 App 一直开着就再也不会重试（visibilitychange 不触发）。
    // 地铁里失败、出站后网络回来，这一下把它补上：先补传欠的那几笔，再同步一次。
    // 两件事都要做——refresh 碰上同步锁会静默早退，只靠它补传可能一直不发生。
    const onOnline = () => {
      void flushOutbox()
      void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
    }
  }, [refresh, flushOutbox, noteHidden, noteVisible])

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
          { path: 'categories', element: page('分类管理', <Categories />) },
        ],
      },
      { path: 'add', element: page('记一笔', <Entry />) },
    ],
  },
])

export default function App() {
  return <RouterProvider router={router} />
}
