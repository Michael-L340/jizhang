// 在途写入的补丁表。纯逻辑，单独放便于测试。
//
// 一次写请求飞在路上时，refresh() 拉回的快照里还没有它。直接用快照覆盖会把它冲掉，
// 用户看到「刚记的那笔消失了」，而云端其实已经存了，很容易再记一遍造成重复。
// 所以 refresh 落地前先把在途补丁叠回去。

export const DELETED = '__deleted__' as const
export type Pending<T> = Map<string, T | typeof DELETED>

/** 把在途补丁叠加到服务端快照上：标删除的剔掉，有对象的覆盖或补回 */
export function applyPending<T extends { id: string }>(rows: T[], pending: Pending<T>): T[] {
  if (pending.size === 0) return rows
  const out = rows.filter((r) => pending.get(r.id) !== DELETED)
  for (const [id, v] of pending) {
    if (v === DELETED) continue
    const i = out.findIndex((r) => r.id === id)
    if (i >= 0) out[i] = v
    else out.unshift(v)
  }
  return out
}
