import { describe, expect, it } from 'vitest'
import { applyPending, DELETED, type Pending } from './pending'

interface Row {
  id: string
  v: number
}
const snap: Row[] = [
  { id: 'a', v: 1 },
  { id: 'b', v: 2 },
]

describe('applyPending', () => {
  it('returns the same array when nothing is in flight', () => {
    const p: Pending<Row> = new Map()
    expect(applyPending(snap, p)).toBe(snap)
  })

  it('adds back a row the server snapshot does not have yet', () => {
    // 场景：记一笔 → 立刻切走再切回 → refresh 的 GET 在 POST 落库前返回
    const p: Pending<Row> = new Map([['c', { id: 'c', v: 3 }]])
    const out = applyPending(snap, p)
    expect(out.map((r) => r.id).sort()).toEqual(['a', 'b', 'c'])
    expect(out.find((r) => r.id === 'c')?.v).toBe(3)
  })

  it('keeps an in-flight edit instead of reverting to the server value', () => {
    const p: Pending<Row> = new Map([['a', { id: 'a', v: 99 }]])
    expect(applyPending(snap, p).find((r) => r.id === 'a')?.v).toBe(99)
  })

  it('keeps an in-flight delete removed even though the server still has it', () => {
    const p: Pending<Row> = new Map([['a', DELETED]])
    expect(applyPending(snap, p).map((r) => r.id)).toEqual(['b'])
  })

  it('never duplicates a row that the snapshot already contains', () => {
    const p: Pending<Row> = new Map([['b', { id: 'b', v: 20 }]])
    const out = applyPending(snap, p)
    expect(out.filter((r) => r.id === 'b')).toHaveLength(1)
    expect(out.find((r) => r.id === 'b')?.v).toBe(20)
  })

  it('does not mutate the snapshot it was given', () => {
    const original = [...snap]
    applyPending(snap, new Map([['a', DELETED]]) as Pending<Row>)
    expect(snap).toEqual(original)
  })

  it('handles delete and insert together', () => {
    const p: Pending<Row> = new Map()
    p.set('a', DELETED)
    p.set('c', { id: 'c', v: 3 })
    expect(applyPending(snap, p).map((r) => r.id).sort()).toEqual(['b', 'c'])
  })
})
