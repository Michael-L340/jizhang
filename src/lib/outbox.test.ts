import { describe, expect, it } from 'vitest'
import { packOutbox, unpackMnOutbox, unpackOutbox, unpackPfOutbox, type Outbox } from './outbox'
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
    hidden: null, is_offset: null,
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

describe('用电备注的待传队列（0013）', () => {
  it('认得出的留下，缺字段、id 对不上、空备注的丢掉；「已删除」照留', () => {
    // 变异：isMnLike 不查 note 非空 → 空备注留下，补传时被数据库 check 拒，红
    const ok = { id: 'n1', day: '2026-10-07', note: '没开空调', created_at: '2026-10-07T12:00:00.000Z' }
    const q = unpackMnOutbox([['n1', ok], ['n2', { ...ok, id: 'n2', note: '' }], ['n3', { ...ok }], ['n4', '__deleted__'], ['n5', { ...ok, id: 'n5', day: '10/7' }]])
    expect([...q.keys()]).toEqual(['n1', 'n4'])
  })
})


describe('参数的待传队列（0014）', () => {
  it('空串的值留下（电价「没填」就是 \'\'）；缺字段、值不是文字、id 对不上的丢掉；「已删除」照留', () => {
    // 变异：isPfLike 照抄 isMnLike 要求值非空 → 清空电价那一项丢了，红
    const ok = { id: 'p6', key: 'power.price', value: '', updated_at: '2026-11-09T05:00:00.000Z' }
    const q = unpackPfOutbox([['p6', ok], ['p1', { ...ok, id: 'p1', value: 7 }], ['p2', { ...ok }], ['p3', '__deleted__'], ['p4', { ...ok, id: 'p4', key: '' }], ['p5', { id: 'p5', key: 'k', value: '1' }]])
    expect([...q.keys()]).toEqual(['p6', 'p3'])
    expect(q.get('p6')).toEqual(ok)
  })
})
