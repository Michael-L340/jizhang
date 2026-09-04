// Service Worker 相关操作。iOS 主屏 App 会长期挂起，自动更新不一定触发，
// 所以设置页提供手动检查和强制刷新两个出口。

export async function checkForUpdate(): Promise<'unsupported' | 'checked'> {
  if (!('serviceWorker' in navigator)) return 'unsupported'
  const regs = await navigator.serviceWorker.getRegistrations()
  await Promise.all(regs.map((r) => r.update()))
  return 'checked'
}

/**
 * 注销 SW、清空所有缓存后重载。只清程序文件缓存，不动登录态和账本数据。
 *
 * 必须先确认真能从网络拿到文件再动缓存：注销和清缓存都是本地操作、一定成功，
 * 但重新加载要走网络。没信号时执行下去，页面拿不到 index.html，而能兜底的 SW 和
 * 预缓存已经被自己亲手删掉了，App 会变成打不开的白屏，直到重新联网为止。
 *
 * 探测 URL 必须带一个随机查询参数：workbox 的预缓存路由是按 URL 匹配的（还会去掉
 * hash、把结尾的 / 补成 index.html），直接 fetch(location.href) 会命中缓存里的
 * index.html，断网时照样返回 200，探测等于白做——cache: 'no-store' 只管 HTTP 缓存，
 * 管不到 Service Worker。默认只有 utm_* 和 fbclid 会被忽略，_probe 不会。
 */
export async function hardReload(): Promise<void> {
  const probe = new URL(location.href)
  probe.hash = ''
  probe.searchParams.set('_probe', String(Date.now()))
  let reachable = false
  try {
    const r = await fetch(probe.href, { cache: 'no-store' })
    reachable = r.ok
  } catch {
    reachable = false
  }
  // 这个 throw 必须在下面的 try/finally 之外，否则 finally 里的 reload 照样会执行
  if (!reachable) throw new Error('连不上服务器，联网后再试')

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
