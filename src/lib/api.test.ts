// api.ts 里那几处「顺序错了就出事」的地方。
//
// 这个文件不联网：把 supabase 客户端换成一个只记录调用的假实现，
// 断言我们发出去的请求长什么样、按什么顺序发。真正的数据库行为由 SQL 约束保证，
// 这里守的是「前端有没有按约束要求的顺序去做」。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Snapshot, Transaction } from '../types'

interface Call {
  table: string
  op: string
  filters: string[]
  rows?: unknown
  opts?: unknown
  aborted?: boolean
}

const h = vi.hoisted(() => {
  const calls: Call[] = []
  const results: { data?: unknown; error?: unknown }[] = []
  const client = {
    from(table: string) {
      const rec: Call = { table, op: '', filters: [] }
      const b = {
        delete() {
          rec.op = 'delete'
          return b
        },
        upsert(rows: unknown, opts: unknown) {
          rec.op = 'upsert'
          rec.rows = rows
          rec.opts = opts
          return b
        },
        select(cols: string) {
          rec.op = 'select'
          rec.filters.push(`cols=${cols.split(',').length}`)
          return b
        },
        order(c: string) {
          rec.filters.push(`order.${c}`)
          return b
        },
        range(a: number, z: number) {
          rec.filters.push(`range.${a}.${z}`)
          return b
        },
        abortSignal(s: AbortSignal) {
          rec.aborted = s instanceof AbortSignal
          return b
        },
        not(c: string, o: string, v: unknown) {
          rec.filters.push(`not.${c}.${o}.${String(v)}`)
          return b
        },
        is(c: string, v: unknown) {
          rec.filters.push(`is.${c}.${String(v)}`)
          return b
        },
        then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) {
          calls.push(rec)
          return Promise.resolve(results.length ? results.shift() : { data: [], error: null }).then(res, rej)
        },
      }
      return b
    },
  }
  return { calls, results, client }
})
vi.mock('./supabase', () => ({ supabase: h.client, configured: true }))

const { fetchAll, friendlyError, importAll, wipeAll } = await import('./api')

const shape = () => h.calls.map((c) => `${c.table}:${c.op}${c.filters.length ? ':' + c.filters.join('+') : ''}`)

function tx(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 't1',
    date: '2026-09-04',
    type: 'expense',
    amount: 1250,
    account_id: 'acc1',
    to_account_id: null,
    category_id: 'cat1',
    note: null,
    created_at: '2026-09-04T02:00:00.000Z',
    ...over,
  }
}

beforeEach(() => {
  h.calls.length = 0
  h.results.length = 0
})

describe('wipeAll 的删除顺序', () => {
  it('必须是 流水 → 二级分类 → 一级分类 → 账户', async () => {
    // 三处外键都是 on delete restrict：顺序反了数据库会直接拒绝。
    // 二级和一级分开删，是因为 PostgREST 每次调用只发一条带过滤条件的 DELETE。
    // 这里只锁「我们发出去的顺序」，数据库真实反应由 npm run test:db 验证。
    await wipeAll()
    expect(shape()).toEqual([
      'transactions:delete:not.id.is.null',
      'categories:delete:not.parent_id.is.null',
      'categories:delete:is.parent_id.null',
      'accounts:delete:not.id.is.null',
    ])
  })

  it('每一条删除都必须带过滤条件，绝不允许无条件删表', async () => {
    await wipeAll()
    for (const c of h.calls) expect(c.filters.length).toBeGreaterThan(0)
  })

  it('中途失败就停下，不继续删后面的', async () => {
    h.results.push({ error: { message: '网络不通' } })
    await expect(wipeAll()).rejects.toBeTruthy()
    expect(shape()).toEqual(['transactions:delete:not.id.is.null'])
  })
})

describe('importAll', () => {
  it('金额按整数分转成 numeric 字符串，不能原样发出去', async () => {
    // 备份 JSON 里 12.50 元存的是 1250。直接塞进 numeric(12,2) 会变成 1250 元。
    // 这是唯一一处元↔分转换，错了不报错，只是金额全变一百倍。
    await importAll({ accounts: [], categories: [], transactions: [tx({ amount: 1250 })] })
    const rows = h.calls.find((c) => c.table === 'transactions')?.rows as { amount: string }[]
    expect(rows[0].amount).toBe('12.50')
  })

  it('负数校准也要转对', async () => {
    await importAll({ accounts: [], categories: [], transactions: [tx({ id: 'a1', type: 'adjust', amount: -5, category_id: null })] })
    const rows = h.calls.find((c) => c.table === 'transactions')?.rows as { amount: string }[]
    expect(rows[0].amount).toBe('-0.05')
  })

  it('一级分类必须先于二级写入', async () => {
    const snap: Snapshot = {
      accounts: [],
      categories: [
        { id: 'c2', kind: 'expense', parent_id: 'c1', name: '午餐', icon: null, sort: 1, is_archived: false, note: null },
        { id: 'c1', kind: 'expense', parent_id: null, name: '日常开支', icon: null, sort: 1, is_archived: false, note: null },
      ],
      transactions: [],
    }
    await importAll(snap)
    const catCalls = h.calls.filter((c) => c.table === 'categories')
    expect((catCalls[0].rows as { id: string }[]).map((c) => c.id)).toEqual(['c1'])
    expect((catCalls[1].rows as { id: string }[]).map((c) => c.id)).toEqual(['c2'])
  })

  it('全部是按 id 合并，一条删除都不发', async () => {
    await importAll({ accounts: [], categories: [], transactions: [tx()] })
    expect(h.calls.every((c) => c.op === 'upsert')).toBe(true)
    expect(h.calls.every((c) => (c.opts as { onConflict: string }).onConflict === 'id')).toBe(true)
  })

  it('超过 500 条要分批', async () => {
    const many = Array.from({ length: 1200 }, (_, i) => tx({ id: `t${i}` }))
    await importAll({ accounts: [], categories: [], transactions: many })
    const batches = h.calls.filter((c) => c.table === 'transactions')
    expect(batches.map((b) => (b.rows as unknown[]).length)).toEqual([500, 500, 200])
  })
})

describe('friendlyError', () => {
  it('同步超时要给中文，不能把英文原文甩给用户', () => {
    const e = new Error('The operation was aborted.')
    e.name = 'AbortError'
    expect(friendlyError(e)).toBe('网络太慢，同步超时')
  })

  it('账户重名不再说成「已有同名分类」', () => {
    expect(friendlyError({ code: '23505', message: 'duplicate key value violates unique constraint' })).toBe('已有同名的账户或分类')
  })

  it('网络不通仍然优先匹配，不被超时那条抢走', () => {
    expect(friendlyError(new Error('Failed to fetch'))).toBe('网络不通，请稍后再试')
  })
})

describe('fetchAll 的中止信号', () => {
  it('三处查询都要挂上，漏一处就还是会卡死整个会话', async () => {
    // supabase-js 默认的 fetch 没有超时，iOS 在后台冻结页面时飞在路上的请求可能
    // 永远不 settle。最容易卡住的恰恰是分页循环里那个 transactions 查询。
    const ac = new AbortController()
    await fetchAll(ac.signal)
    expect(h.calls.map((c) => c.table)).toEqual(['accounts', 'categories', 'transactions'])
    expect(h.calls.every((c) => c.aborted === true)).toBe(true)
  })

  it('不传信号时不调用 abortSignal（旧调用方不受影响）', async () => {
    await fetchAll()
    expect(h.calls.every((c) => c.aborted === undefined)).toBe(true)
  })

  it('分页要按主键做 tiebreaker，否则跨页会重复或漏行', async () => {
    await fetchAll()
    const tx = h.calls.find((c) => c.table === 'transactions')
    expect(tx?.filters).toContain('order.id')
    expect(tx?.filters).toContain('range.0.999')
  })
})
