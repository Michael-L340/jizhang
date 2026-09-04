// 导入文件的校验。整库恢复会先删光云端再按这个文件重建，所以文件必须先验过——
// 这里每一条都对应一种「文件坏了但看起来正常」的情况。
import { describe, expect, it } from 'vitest'
import { backupFilename, buildJson, exportTrustworthy, parseImport, readExportMeta } from './csv'
import type { Account, Category, Snapshot, Transaction } from '../types'

// id 用真的 UUID：数据库三张表的 id 都是 uuid 列，'a1' 这种字符串根本进不去（22P02），
// 拿它当测试数据会让「校验通过 = 一定导得进去」这条性质在测试里假成立
const A1 = '11111111-1111-4111-8111-111111111111'
const C1 = '22222222-2222-4222-8222-222222222222'
const T1 = '33333333-3333-4333-8333-333333333333'
const T2 = '44444444-4444-4444-8444-444444444444'

const acc: Account = { id: A1, name: '微信', kind: 'wallet', sort: 1, is_archived: false }
const cat: Category = { id: C1, kind: 'expense', parent_id: null, name: '日常开支', icon: '🍚', sort: 1, is_archived: false, note: null }
const tx: Transaction = {
  id: T1,
  date: '2026-09-04',
  type: 'expense',
  amount: 1250,
  account_id: A1,
  to_account_id: null,
  category_id: C1,
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
    expect(() => parseImport(file({ transactions: [tx, { ...tx, id: T2, amount: 38.5 }] }))).toThrow(/第 2 条.*38\.5/)
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
    expect(() => parseImport(file({ accounts: [{ id: A1 }] }))).toThrow(/账户/)
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

  it('数据库没有的列也要扔掉，否则 PostgREST 会说 column does not exist', () => {
    const out = parseImport(file({ transactions: [{ ...tx, 备注2: '手写脚本加的' }] }))
    expect(Object.keys(out.transactions[0]).sort()).toEqual(['account_id', 'amount', 'category_id', 'created_at', 'date', 'id', 'note', 'to_account_id', 'type'])
  })

  it('parseImport 真的接上了 validate.ts（不是只看那四样）', () => {
    // 这一条挂了就说明校验层被绕过去了：整库恢复会照样先清空云端
    expect(() => parseImport(file({ transactions: [{ ...tx, date: '2026-02-30' }] }))).toThrow(/这一天不存在/)
  })
})

// ══════════════════════════════════════════════════════════════
// 导出前的自查
//   导出用的是 store 里的快照。本次会话一次都没同步成功过的话，那就是本机缓存，
//   可能比云端少几百条，而文件上看不出任何痕迹——用它做整库恢复就是真丢账。
// ══════════════════════════════════════════════════════════════
describe('导出可不可信', () => {
  it('同步成功过、且最近一次没失败，才算可信', () => {
    expect(exportTrustworthy({ loaded: true, syncFailed: false })).toBe(true)
  })

  it('本次会话没成功拉过云端：不可信', () => {
    expect(exportTrustworthy({ loaded: false, syncFailed: false })).toBe(false)
  })

  it('最近一次同步失败了：不可信，哪怕之前成功过', () => {
    expect(exportTrustworthy({ loaded: true, syncFailed: true })).toBe(false)
  })

  it('不可信时文件名要带记号，免得三个月后分不清哪份是全的', () => {
    expect(backupFilename('json', '2026-09-04', false)).toBe('记账备份-2026-09-04-未同步.json')
    expect(backupFilename('csv', '2026-09-04', false)).toBe('记账-2026-09-04-未同步.csv')
    expect(backupFilename('json', '2026-09-04', true)).toBe('记账备份-2026-09-04.json')
  })

  it('不可信时文件内容里也要留标记，恢复那天才拦得住', () => {
    const text = buildJson(snap, { synced: false, lastSync: '2026-09-01T00:00:00.000Z' })
    expect(readExportMeta(text)).toEqual({ synced: false, lastSync: '2026-09-01T00:00:00.000Z' })
    // 标记不能把文件弄得导不进去
    expect(parseImport(text).transactions).toHaveLength(1)
  })

  it('老备份没有这个标记，读出来是「不知道」，不能当成「不可信」去吓唬人', () => {
    expect(readExportMeta(buildJson(snap))).toEqual({ synced: null, lastSync: null })
    expect(readExportMeta('这不是 JSON')).toEqual({ synced: null, lastSync: null })
  })
})
