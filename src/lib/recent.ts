// 「最近用过就保留」的状态：切页面、点进一笔再回来时还在，但过了一阵子再打开就回到默认。
//
// 统计页选到 8 月下钻到餐饮、切去流水核一笔再回来，原来又变回 9 月、下钻也没了。
// 但如果无条件记住，第二天打开 App 还停在 8 月又会奇怪。所以带一个时间戳：
// 在 RECENT_MS 内再次打开就续期，超过就当新的一次使用。
//
// 纯函数；localStorage 的读写在 hooks.ts 的 useRecentState 里。

export const RECENT_MS = 2 * 60 * 60 * 1000

export function packRecent<T>(value: T, now: number): string {
  return JSON.stringify({ v: value, at: now })
}

/** 还新鲜就返回值，过期、没有或格式不对都返回 undefined */
export function unpackRecent<T>(raw: string | null, now: number, maxAge = RECENT_MS): T | undefined {
  if (raw === null) return undefined
  try {
    const o = JSON.parse(raw) as { v?: T; at?: unknown }
    if (typeof o !== 'object' || o === null || typeof o.at !== 'number') return undefined
    if (now - o.at > maxAge) return undefined
    return o.v
  } catch {
    return undefined
  }
}
