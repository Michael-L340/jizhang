// 用电页、参数页上显示的电价（元/度）。2026-11-09 起电价存云端（lib/prefs.ts 的 power.price），
// 但第一次装上新版本、还没同步过的那会儿，云端那一行还不存在：这时先拿这台手机上以前存的电价兜底，
// 免得同步回来之前电费那几行一闪而空（同步成功后 store 会把它传上去，之后就以云端为准）。
// 云端那一行是 ''（用户清空了）就是没填，不再读本机的。

import { parsePrice, PRICE_KEY } from './meter'
import { pricePref } from './prefs'
import type { Pref } from '../types'

/** 这台手机上以前存的电价；没有、坏了、读不了都是 null */
export function readLocalPrice(): number | null {
  try {
    return parsePrice(localStorage.getItem(PRICE_KEY) ?? '') ?? null
  } catch {
    return null
  }
}

/** 现在生效的电价：云端有那一行就听云端的（'' = 没填），没有就用本机的 */
export function effectivePrice(prefs: readonly Pref[], local: () => number | null = readLocalPrice): number | null {
  const v = pricePref(prefs)
  return v === undefined ? local() : v
}
