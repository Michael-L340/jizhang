import { describe, expect, it } from 'vitest'
import { packRecent, RECENT_MS, unpackRecent } from './recent'

describe('recent', () => {
  const T0 = 1_700_000_000_000

  it('没过期就原样拿回来', () => {
    const raw = packRecent({ ym: '2026-08', drill: 'c1' }, T0)
    expect(unpackRecent(raw, T0 + RECENT_MS - 1)).toEqual({ ym: '2026-08', drill: 'c1' })
  })

  it('刚好到期还算新鲜，再过 1 毫秒就过期', () => {
    const raw = packRecent('2026-08', T0)
    expect(unpackRecent(raw, T0 + RECENT_MS)).toBe('2026-08')
    expect(unpackRecent(raw, T0 + RECENT_MS + 1)).toBeUndefined()
  })

  it('null 也能存（下钻为空）', () => {
    expect(unpackRecent(packRecent(null, T0), T0)).toBeNull()
  })

  it('没有、坏掉的、旧格式的都当没有', () => {
    expect(unpackRecent(null, T0)).toBeUndefined()
    expect(unpackRecent('{not json', T0)).toBeUndefined()
    expect(unpackRecent('"2026-08"', T0)).toBeUndefined()
    expect(unpackRecent('{"v":"x"}', T0)).toBeUndefined()
  })
})
