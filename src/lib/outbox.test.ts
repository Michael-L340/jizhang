import { describe, expect, it } from 'vitest'
import { packOutbox, unpackOutbox, type Outbox } from './outbox'
import { DELETED } from './pending'
import type { Transaction } from '../types'

function tx(id: string, over: Partial<Transaction> = {}): Transaction {
  return {
    id,
    date: '2026-09-07',
    type: 'expense',
    amount: 1234,
    account_id: 'acc1',
    to_account_id: null,
    category_id: 'cat1',
    note: null,
    installments: null,
    settles: null,
    created_at: '2026-09-07T02:00:00.000Z',
    ...over,
  }
}

describe('待上传队列的存取', () => {
  it('存进去再读回来是同一份', () => {
    const o: Outbox = new Map()
    o.set('a', tx('a'))
    o.set('b', DELETED)
    const back = unpackOutbox(JSON.parse(JSON.stringify(packOutbox(o))))
    expect(back.size).toBe(2)
    expect(back.get('a')).toEqual(tx('a'))
    expect(back.get('b')).toBe(DELETED)
  })

  it('缓存里没有这个键（旧版本写的）时返回空队列，不是崩', () => {
    expect(unpackOutbox(undefined).size).toBe(0)
    expect(unpackOutbox(null).size).toBe(0)
    expect(unpackOutbox('坏了').size).toBe(0)
    expect(unpackOutbox({}).size).toBe(0)
  })

  it('坏掉的条目单条丢弃，不能带走整个队列', () => {
    const good = tx('good')
    const raw = [
      ['good', good],
      ['短', ], // 长度不对
      [42, tx('x')], // 键不是字符串
      ['', tx('')], // 空键
      ['nulll', null], // 值不是记录也不是删除标记
      ['缺字段', { id: '缺字段', date: '2026-09-07' }], // 少了 type / amount
      ['对不上', tx('别的id')], // 键和记录里的 id 不一致
      ['del', DELETED],
    ]
    const back = unpackOutbox(raw)
    expect([...back.keys()].sort()).toEqual(['del', 'good'])
    expect(back.get('good')).toEqual(good)
  })

  it('空队列存出来是空数组', () => {
    expect(packOutbox(new Map())).toEqual([])
  })
})
