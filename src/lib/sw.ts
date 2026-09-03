// Service Worker 相关操作。iOS 主屏 App 会长期挂起，自动更新不一定触发，
// 所以设置页提供手动检查和强制刷新两个出口。

export async function checkForUpdate(): Promise<'unsupported' | 'checked'> {
  if (!('serviceWorker' in navigator)) return 'unsupported'
  const regs = await navigator.serviceWorker.getRegistrations()
  await Promise.all(regs.map((r) => r.update()))
  return 'checked'
}

/** 注销 SW、清空所有缓存后重载。只清程序文件缓存，不动登录态和账本数据。 */
export async function hardReload(): Promise<void> {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map((r) => r.unregister()))
    }
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
    }
  } finally {
    location.reload()
  }
}
