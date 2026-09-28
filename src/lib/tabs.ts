// 底部标签栏「点下去去哪」。纯函数，TabBar.tsx 只管接。
//
// 统计这个标签下面有两页：统计页和进阶分析（/stats/more）。从进阶分析点图跳去流水、看完再点「统计」，
// 原来回到的是统计页——要滑到最底下再点一次「进阶分析」，刚才那张卡还得重新找（2026-09-29 审出来的）。
// 现在照手机 App 的习惯：标签记得上次停在它下面哪一页；已经在这个标签里再点它，回到它的首页。

export const STATS_ROOT = '/stats'

export function isStatsPath(p: string): boolean {
  return p === STATS_ROOT || p.startsWith(`${STATS_ROOT}/`)
}

/**
 * @param pathname 现在在哪
 * @param last     上次在统计标签下停在哪一页（没去过 = null）
 */
export function statsTabTarget(pathname: string, last: string | null): string {
  if (isStatsPath(pathname)) return STATS_ROOT
  return last !== null && isStatsPath(last) ? last : STATS_ROOT
}
