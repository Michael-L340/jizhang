// 导入文件的校验。整库恢复会先删光云端再按这个文件重建，所以文件必须先验过——
// 这里每一条都对应一种「文件坏了但看起来正常」的情况。
import { describe, expect, it } from 'vitest'
import { buildJson, parseImport } from './csv'
import type { Account, Category, Snapshot, Transaction } from '../types'

const acc: Account = { id: 'a1', name: '微信', kind: 'wallet', sort: 1, is_archived: false }
const cat: Category = { id: 'c1', kind: 'expense', parent_id: null, name: '日常开支', icon: '🍚', sort: 1, is_archived: false, note: null }
const tx: Transaction = {
  id: 't1',
  date: '2026-09-04',
  type: 'expense',
  amount: 1250,
  account_id: 'a1',
  to_account_id: null,
  category_id: 'c1',
  note: '午饭',
  created_at: '2026-09-04T02:00:00.000Z',
}
const snap: Snapshot = { accounts: [acc], categories: [cat], transactions: [tx] }

function file(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, exported_at: '2026-09-04T00:00:00.000Z', accounts: [acc], categories: [cat], transactions: [tx], ...over })
}

describe('parseImport', () => {
  it('导出再导入，内容一模一样', () => {
    expect(parseImport(buildJson(snap))).toEqual(snap)
  })

  it('金额不是整数分就拒绝——这是「元当成分」那类错误的唯一防线', () => {
    // 备份里 12.50 元必须写成 1250。写成 12.5 的话，导进去金额会变成百分之一，
    // 而且数据库不会报任何错，只有对账时才发现，那时已经晚了。
    expect(() => parseImport(file({ transactions: [{ ...tx, amount: 12.5 }] }))).toThrow(/整数分/)
  })

  it('报错要指出是第几条、读到了什么', () => {
    expect(() => parseImport(file({ transactions: [tx, { ...tx, id: 't2', amount: 38.5 }] }))).toThrow(/第 2 条.*38\.5/)
  })

  it('日期格式不对就拒绝', () => {
    expect(() => parseImport(file({ transactions: [{ ...tx, date: '2026/09/04' }] }))).toThrow(/日期格式/)
  })

  it('类型不认识就拒绝', () => {
    expect(() => parseImport(file({ transactions: [{ ...tx, type: 'refund' }] }))).toThrow(/类型/)
  })

  it('缺 id 就拒绝', () => {
    const { id: _drop, ...noId } = tx
    expect(() => parseImport(file({ transactions: [noId] }))).toThrow(/id/)
  })

  it('账户缺名字就拒绝', () => {
    expect(() => parseImport(file({ accounts: [{ id: 'a1' }] }))).toThrow(/账户/)
  })

  it('不是本应用的文件就拒绝', () => {
    expect(() => parseImport('{"foo":1}')).toThrow(/不是本应用/)
    expect(() => parseImport(file({ version: 0 }))).toThrow(/不是本应用/)
    expect(() => parseImport(JSON.stringify({ version: 1, accounts: [] }))).toThrow(/不是本应用/)
  })

  it('以后格式升到 2，老备份和新备份都还能读', () => {
    // 真出事那天手上只剩一份老备份是很常见的，不能被一句「格式不对」拦死
    expect(parseImport(file({ version: 2 })).transactions).toHaveLength(1)
  })

  it('去掉 user_id 和 updated_at，换库时才不会带着别人的身份', () => {
    const out = parseImport(file({ transactions: [{ ...tx, user_id: 'someone', updated_at: 'x' }] }))
    expect(out.transactions[0]).not.toHaveProperty('user_id')
    expect(out.transactions[0]).not.toHaveProperty('updated_at')
  })
})
