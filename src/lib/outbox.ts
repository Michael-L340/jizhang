// 待上传队列。断网时写不进云端的那几笔先存这里，联网后自动补传。
//
// 结构和 pending.ts 的补丁表**故意长得一样**（Map<id, 记录 | 已删除>），因为两者都要靠
// applyPending 叠加到服务端快照上。但寿命完全不同，别把它们混为一谈：
//
//   补丁表   管的是「请求已经飞在路上的那几百毫秒」，60 秒兜底过期，只存在内存里；
//   待传队列 管的是「请求根本没发出去」，只有真的传上去了才删，要写进缓存跨会话保留。
//
// 只存「最终状态」而不是操作流水，是为了绕开一整类时序问题：
// 断网时先记一笔再改两次再删掉，队列里始终只有这一个 id 的一条，补传时按最终状态
// upsert 或 delete 即可，不用回放顺序，重复执行也不会出错（两个操作都是幂等的）。

import type { MeterNote, MeterReading, Transaction } from '../types'
import { DELETED, type Pending } from './pending'

export type Outbox = Pending<Transaction>
/** 电表读数的待传队列（2026-10-15 起）：和流水同一套，单独一个键存（见 store.ts 的 saveMrOutbox） */
export type MrOutbox = Pending<MeterReading>

/** 存进 localStorage 的形状。Map 不能直接 JSON 序列化 */
export type OutboxDump = [string, Transaction | typeof DELETED][]

export function packOutbox<T>(o: Pending<T>): [string, T | typeof DELETED][] {
  return [...o.entries()]
}

/**
 * 从缓存读回队列。缓存在用户自己的机器上，可能是旧版本写的、可能被改坏、
 * 也可能压根不存在，所以一律「认不出来就丢掉这一条」——
 * 绝不能让一条坏数据把整个队列带走，那才是真的丢账。
 */
export function unpackOutbox(raw: unknown): Outbox {
  return unpackWith(raw, isTxLike)
}

/** 电表读数的队列，规矩同上 */
export function unpackMrOutbox(raw: unknown): MrOutbox {
  return unpackWith(raw, isMrLike)
}

/** 用电每日备注的队列，规矩同上 */
export function unpackMnOutbox(raw: unknown): Pending<MeterNote> {
  return unpackWith(raw, isMnLike)
}

function unpackWith<T extends { id: string }>(raw: unknown, ok: (v: unknown) => v is T): Pending<T> {
  const out: Pending<T> = new Map()
  if (!Array.isArray(raw)) return out
  for (const e of raw) {
    if (!Array.isArray(e) || e.length !== 2) continue
    const [id, v] = e as [unknown, unknown]
    if (typeof id !== 'string' || !id) continue
    if (v === DELETED) {
      out.set(id, DELETED)
      continue
    }
    // id 对不上的直接丢：键和记录里的 id 必须一致，否则补传时会把别人覆盖掉
    if (ok(v) && v.id === id) out.set(id, v)
  }
  return out
}

/** 只认关键字段。缺胳膊少腿的记录传上去也会被数据库拒，不如现在就丢掉 */
function isTxLike(v: unknown): v is Transaction {
  if (typeof v !== 'object' || v === null) return false
  const t = v as Partial<Transaction>
  return typeof t.id === 'string' && typeof t.date === 'string' && typeof t.type === 'string' && typeof t.amount === 'number'
}

function isMrLike(v: unknown): v is MeterReading {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Partial<MeterReading>
  return typeof r.id === 'string' && typeof r.read_at === 'string' && Number.isInteger(r.centi_kwh) && typeof r.created_at === 'string'
}

function isMnLike(v: unknown): v is MeterNote {
  if (typeof v !== 'object' || v === null) return false
  const n = v as Partial<MeterNote>
  return typeof n.id === 'string' && typeof n.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(n.day) && typeof n.note === 'string' && n.note.length > 0 && typeof n.created_at === 'string'
}
