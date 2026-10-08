// api.ts 里那几处「顺序错了就出事」的地方。
//
// 这个文件不联网：把 supabase 客户端换成一个只记录调用的假实现，
// 断言我们发出去的请求长什么样、按什么顺序发。真正的数据库行为由 SQL 约束保证，
// 这里守的是「前端有没有按约束要求的顺序去做」。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FacadeAdjust, MeterReading, Snapshot, Transaction } from '../types'

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
  // auth 这边单独记：备份状态必须走 getUser（联网拿最新的 user），
  // 走 getSession（读本机旧 JWT）会长期显示过期的备份时间
  const auth = { calls: [] as string[], user: null as unknown, error: null as unknown, throws: null as unknown }
  const client = {
    auth: {
      async getUser() {
        auth.calls.push('getUser')
        if (auth.throws) throw auth.throws
        return { data: { user: auth.user }, error: auth.error }
      },
      async getSession() {
        auth.calls.push('getSession')
        return { data: { session: { user: auth.user } }, error: null }
      },
    },
    from(table: string) {
      const rec: Call = { table, op: '', filters: [] }
      const b = {
        delete() {
          rec.op = 'delete'
          return b
        },
        insert(rows: unknown) {
          rec.op = 'insert'
          rec.rows = rows
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
        order(c: string, o?: { ascending?: boolean }) {
          rec.filters.push(`order.${c}`)
          // 倒序单独记一笔：电表读数必须是 id 升序（和备份脚本一致），写成倒序要能被看出来
          if (o?.ascending === false) rec.filters.push(`desc.${c}`)
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
        eq(c: string, v: unknown) {
          rec.filters.push(`eq.${c}.${String(v)}`)
          return b
        },
        gt(c: string, v: unknown) {
          // 学数据库的脾气：id 是 uuid，空串比不了（v1.3.28 线上就是 `id > ''` 挂的）
          if (c === 'id' && v === '') throw new Error('invalid input syntax for type uuid: ""')
          rec.filters.push(`gt.${c}.${String(v)}`)
          return b
        },
        limit(n: number) {
          rec.filters.push(`limit.${n}`)
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
  return { calls, results, client, auth }
})
vi.mock('./supabase', () => ({ supabase: h.client, configured: true }))

const { deleteMeterReading, fetchAll, fetchBackupStatus, friendlyError, importAll, insertMeterReading, isPermanentError, wipeAll } = await import('./api')

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
    installments: null,
    settles: null,
    hidden: null,
    created_at: '2026-09-04T02:00:00.000Z',
    ...over,
  }
}

beforeEach(() => {
  h.calls.length = 0
  h.results.length = 0
  h.auth.calls.length = 0
  h.auth.user = null
  h.auth.error = null
  h.auth.throws = null
})

/** 造一个「服务端返回的 user」，user_metadata.backup 由备份脚本写 */
function userWithBackup(backup: unknown): unknown {
  return { id: 'u1', user_metadata: { backup } }
}

describe('fetchBackupStatus', () => {
  const good = { at: '2026-09-04T17:37:00.000Z', transactions: 1234, accounts: 4, categories: 30 }

  it('必须走 getUser（联网拿最新 metadata），绝不能用 getSession', async () => {
    // getSession 读的是本机存着的那份 JWT，metadata 是签发那一刻烤进去的。
    // 备份脚本在服务端改了 user_metadata，本机这份要等 token 刷新才变——
    // 用 getSession 的话页面会长期显示昨天甚至上周的备份时间，
    // 恰恰在「备份停了」的时候骗人说「正常」
    h.auth.user = userWithBackup(good)
    await fetchBackupStatus()
    expect(h.auth.calls).toEqual(['getUser'])
    expect(h.auth.calls).not.toContain('getSession')
  })

  it('读到就只取 at 和 transactions', async () => {
    h.auth.user = userWithBackup(good)
    expect(await fetchBackupStatus()).toEqual({ at: '2026-09-04T17:37:00.000Z', transactions: 1234 })
  })

  it('从来没备份过（没有 backup 字段）返回 null，不算失败', async () => {
    const onFail = vi.fn()
    h.auth.user = { id: 'u1', user_metadata: {} }
    expect(await fetchBackupStatus(onFail)).toBeNull()
    expect(onFail).not.toHaveBeenCalled()
  })

  it('字段不合法一律当没有，不能把 NaN 或 Invalid Date 摆到设置页上', async () => {
    for (const bad of [{ at: '不是时间', transactions: 1 }, { at: '2026-09-04T17:37:00.000Z', transactions: '1234' }, { at: 123, transactions: 1 }, { at: '2026-09-04T17:37:00.000Z' }, { at: '2026-09-04T17:37:00.000Z', transactions: -1 }, 'backup', 42]) {
      h.auth.user = userWithBackup(bad)
      expect(await fetchBackupStatus()).toBeNull()
    }
  })

  it('读失败返回 null 但要把错误交出去——「读不到」和「没备份过」得显示两句话', async () => {
    const onFail = vi.fn()
    h.auth.error = { message: 'Failed to fetch' }
    expect(await fetchBackupStatus(onFail)).toBeNull()
    expect(onFail).toHaveBeenCalledTimes(1)
  })

  it('抛异常也不许扔到页面上', async () => {
    // 设置页只是想显示一行字，为这个白屏（ErrorBoundary）完全不值
    const onFail = vi.fn()
    h.auth.throws = new Error('boom')
    await expect(fetchBackupStatus(onFail)).resolves.toBeNull()
    expect(onFail).toHaveBeenCalledTimes(1)
  })
})

describe('wipeAll 的删除顺序', () => {
  it('必须是 电表读数 → 外页面校准 → 流水 → 二级分类 → 一级分类 → 账户', async () => {
    // 四处外键都是 on delete restrict：顺序反了数据库会直接拒绝。
    // 电表读数（0011）没有外键，放第一句是为了让「第一句失败 = 一行没删」继续成立。
    // 二级和一级分开删，是因为 PostgREST 每次调用只发一条带过滤条件的 DELETE。
    // 这里只锁「我们发出去的顺序」，数据库真实反应由 npm run test:db 验证。
    await wipeAll()
    expect(shape()).toEqual([
      'meter_readings:delete:not.id.is.null',
      'facade_adjusts:delete:not.id.is.null',
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
    expect(shape()).toEqual(['meter_readings:delete:not.id.is.null'])
  })

  it('失败时要说清楚是删到哪一步炸的——第一句就失败意味着云端一行没动', async () => {
    // store.ts 的整库恢复靠这个 step 决定要不要回滚、以及怎么跟用户说：
    // 'meter_readings'（0011 起的第一句）= 一行都没删，可以老实说「账本原封不动」；
    // 其他 step = 已经删掉一部分，必须立刻拿操作前的快照写回去。
    // 'facade_adjusts' 在 0010 时是第一句，0011 起不是了：它失败时电表读数已经没了
    h.results.push({ error: { message: '网络不通' } })
    await expect(wipeAll()).rejects.toMatchObject({ step: 'meter_readings' })

    h.results.push({}, { error: { message: '网络不通' } })
    await expect(wipeAll()).rejects.toMatchObject({ step: 'facade_adjusts' })

    h.results.push({}, {}, { error: { message: '网络不通' } })
    await expect(wipeAll()).rejects.toMatchObject({ step: 'transactions' })

    h.results.push({}, {}, {}, { error: { message: '网络不通' } })
    await expect(wipeAll()).rejects.toMatchObject({ step: 'child_categories' })
  })
})

describe('importAll', () => {
  it('金额按整数分转成 numeric 字符串，不能原样发出去', async () => {
    // 备份 JSON 里 12.50 元存的是 1250。直接塞进 numeric(12,2) 会变成 1250 元。
    // 这是唯一一处元↔分转换，错了不报错，只是金额全变一百倍。
    await importAll({ accounts: [], categories: [], facade_adjusts: [], meter_readings: [], transactions: [tx({ amount: 1250 })] })
    const rows = h.calls.find((c) => c.table === 'transactions')?.rows as { amount: string }[]
    expect(rows[0].amount).toBe('12.50')
  })

  it('负数校准也要转对', async () => {
    await importAll({ accounts: [], categories: [], facade_adjusts: [], meter_readings: [], transactions: [tx({ id: 'a1', type: 'adjust', amount: -5, category_id: null })] })
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
      facade_adjusts: [],
      meter_readings: [],
    }
    await importAll(snap)
    const catCalls = h.calls.filter((c) => c.table === 'categories')
    expect((catCalls[0].rows as { id: string }[]).map((c) => c.id)).toEqual(['c1'])
    expect((catCalls[1].rows as { id: string }[]).map((c) => c.id)).toEqual(['c2'])
  })

  it('外页面校准记录在账户之后、分类之前写；cents 原样发，不过元↔分换算', async () => {
    // 变异：importAll 把 facade 那段挪到 accounts 之前 → 顺序断言红；对 cents 也做 centsToDb → 值断言红
    const f: FacadeAdjust = { id: 'f1', account_id: 'acc1', date: '2026-09-27', cents: -800000, created_at: '2026-09-27T02:00:00.000Z' }
    await importAll({ accounts: [{ id: 'acc1', name: '微信', kind: 'wallet', sort: 1, is_archived: false, repay_day: null, facade_offset: null, defer_after_repay: null }], categories: [], transactions: [], facade_adjusts: [f], meter_readings: [] })
    expect(h.calls.map((c) => c.table)).toEqual(['accounts', 'facade_adjusts', 'categories'])
    const rows = h.calls.find((c) => c.table === 'facade_adjusts')?.rows as FacadeAdjust[]
    expect(rows[0]).toEqual(f)
    expect(rows[0].cents).toBe(-800000)
  })

  it('电表读数：centi_kwh 原样发、不过任何换算；超过 500 条同样分批', async () => {
    // 变异：importAll 不写 meter_readings → 找不到这张表的调用，红；对 centi_kwh 做 centsToDb → 值断言红
    const r: MeterReading = { id: 'm1', read_at: '2026-10-03T13:40:00.000Z', centi_kwh: 339340, created_at: '2026-10-03T13:40:05.000Z' }
    await importAll({ accounts: [], categories: [], transactions: [], facade_adjusts: [], meter_readings: [r] })
    const rows = h.calls.find((c) => c.table === 'meter_readings')?.rows as MeterReading[]
    expect(rows).toEqual([r])
    expect((h.calls.find((c) => c.table === 'meter_readings')?.opts as { onConflict: string }).onConflict).toBe('id')

    h.calls.length = 0
    const many = Array.from({ length: 1001 }, (_, i) => ({ ...r, id: `m${i}` }))
    await importAll({ accounts: [], categories: [], transactions: [], facade_adjusts: [], meter_readings: many })
    expect(h.calls.filter((c) => c.table === 'meter_readings').map((b) => (b.rows as unknown[]).length)).toEqual([500, 500, 1])
  })

  it('合并导入（onlyNew）只插入云端没有的 id：每张表的 upsert 都带 ignoreDuplicates，整库恢复不带', async () => {
    // 变异：up 不看 opts.onlyNew → 红
    const snap: Snapshot = { accounts: [{ id: 'acc1', name: '微信', kind: 'wallet', sort: 1, is_archived: false, repay_day: null, facade_offset: null, defer_after_repay: null }], categories: [{ id: 'c1', kind: 'expense', parent_id: null, name: '吃', icon: null, sort: 1, is_archived: false, note: null }], transactions: [tx()], facade_adjusts: [], meter_readings: [{ id: 'm1', read_at: '2026-10-03T13:40:00.000Z', centi_kwh: 1, created_at: '2026-10-03T13:40:00.000Z' }] }
    await importAll(snap, { onlyNew: true })
    expect(h.calls.length).toBeGreaterThanOrEqual(4)
    expect(h.calls.every((c) => c.op === 'upsert' && (c.opts as { ignoreDuplicates: boolean }).ignoreDuplicates === true)).toBe(true)
    h.calls.length = 0
    await importAll(snap)
    expect(h.calls.every((c) => (c.opts as { ignoreDuplicates: boolean }).ignoreDuplicates === false)).toBe(true)
  })

  it('全部是按 id 合并，一条删除都不发', async () => {
    await importAll({ accounts: [], categories: [], facade_adjusts: [], meter_readings: [], transactions: [tx()] })
    expect(h.calls.every((c) => c.op === 'upsert')).toBe(true)
    expect(h.calls.every((c) => (c.opts as { onConflict: string }).onConflict === 'id')).toBe(true)
  })

  it('超过 500 条要分批', async () => {
    const many = Array.from({ length: 1200 }, (_, i) => tx({ id: `t${i}` }))
    await importAll({ accounts: [], categories: [], facade_adjusts: [], meter_readings: [], transactions: many })
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

  it('登录过期要说人话——放久了再打开撞的就是它', () => {
    // JWT 有效期 1 小时，而 supabase-js 提前 90 秒就当它过期，隔久一点打开必然要换一次 token
    expect(friendlyError(new Error('JWT expired'))).toBe('登录已过期，请重新登录')
    expect(friendlyError(new Error('Invalid Refresh Token: Refresh Token Not Found'))).toBe('登录已过期，请重新登录')
    expect(friendlyError({ message: 'Auth session missing!' })).toBe('登录已过期，请重新登录')
  })
})

describe('fetchAll 的中止信号', () => {
  it('每一处查询都要挂上，漏一处就还是会卡死整个会话', async () => {
    // supabase-js 默认的 fetch 没有超时，iOS 在后台冻结页面时飞在路上的请求可能
    // 永远不 settle。最容易卡住的恰恰是分页循环里那个 transactions 查询。
    const ac = new AbortController()
    await fetchAll(ac.signal)
    expect(h.calls.map((c) => c.table)).toEqual(['accounts', 'categories', 'transactions', 'facade_adjusts', 'meter_readings'])
    expect(h.calls.every((c) => c.aborted === true)).toBe(true)
  })

  it('不传信号时不调用 abortSignal（旧调用方不受影响）', async () => {
    await fetchAll()
    expect(h.calls.every((c) => c.aborted === undefined)).toBe(true)
  })

  it('分页要按主键做 tiebreaker，否则跨页会重复或漏行；校准记录和电表读数按 id 接着取（keyset），不用 offset', async () => {
    await fetchAll()
    const tx = h.calls.find((c) => c.table === 'transactions')
    expect(tx?.filters).toContain('order.id')
    expect(tx?.filters).toContain('range.0.999')
    for (const t of ['facade_adjusts', 'meter_readings']) {
      const c = h.calls.find((x) => x.table === t)
      expect(c?.filters.some((f) => f.startsWith('gt.')), t).toBe(false)
      expect(c?.filters, t).toContain('order.id')
      expect(c?.filters, t).toContain('limit.1000')
      expect(c?.filters.some((f) => f.startsWith('range.')), t).toBe(false)
    }
  })

  it('电表读数满 1000 条要翻下一页，不能静默截断在第一页', async () => {
    // 变异：meter_readings 那段不写循环、只查一次 → 只有一次调用、拿到 1000 条，红
    const page = (from: number, n: number) => ({ data: Array.from({ length: n }, (_, i) => ({ id: `m${from + i}`, read_at: '2026-10-03T13:40:00.000Z', centi_kwh: from + i, created_at: '2026-10-03T13:40:00.000Z' })) })
    h.results.push({ data: [] }, { data: [] }, { data: [] }, { data: [] }, page(0, 1000), page(1000, 3))
    const snap = await fetchAll()
    // 按 id 接着取（上一页最后一个 id 之后），不是 offset：两页之间有增删时 offset 会重一条或漏一条
    // 第一页不能带 gt：id 是 uuid，`id > ''` 数据库拒收（v1.3.28 线上事故）；第二页从上一页最后一个 id 之后取
    expect(h.calls.filter((c) => c.table === 'meter_readings').map((c) => c.filters.filter((f) => f.startsWith('gt.') || f.startsWith('limit.')).sort().join('+'))).toEqual(['limit.1000', 'gt.id.m999+limit.1000'])
    expect(snap.meter_readings).toHaveLength(1003)
  })

  it('电表读数：centi_kwh 就算以字符串回来也要收成数字，而且不做元↔分那种换算', async () => {
    // 变异：rowToMr 不 Number() → 拿到的是字符串 '339340'，红；误用 centsFromDb → 变成 33934000，红
    h.results.push({ data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [{ id: 'm1', read_at: '2026-10-03T13:40:00+00:00', centi_kwh: '339340', created_at: '2026-10-03T13:40:05+00:00' }] })
    const snap = await fetchAll()
    expect(snap.meter_readings).toEqual([{ id: 'm1', read_at: '2026-10-03T13:40:00+00:00', centi_kwh: 339340, created_at: '2026-10-03T13:40:05+00:00' }])
  })

  it('外页面校准记录：cents 就算以字符串回来也要收成数字，日期原样', async () => {
    // bigint 走 JSON 一般是数字，但 PostgREST 的配置能让它变成字符串；进了 balances 一相加就是字符串拼接
    h.results.push({ data: [] }, { data: [] }, { data: [] }, { data: [{ id: 'f1', account_id: 'a1', date: '2026-09-27', cents: '-800000', created_at: '2026-09-27T02:00:00.000Z' }] })
    const snap = await fetchAll()
    expect(snap.facade_adjusts).toEqual([{ id: 'f1', account_id: 'a1', date: '2026-09-27', cents: -800000, created_at: '2026-09-27T02:00:00.000Z' }])
  })
})

describe('电表读数的增删', () => {
  const r: MeterReading = { id: 'm1', read_at: '2026-10-03T13:40:00.000Z', centi_kwh: 339340, created_at: '2026-10-03T13:40:05.000Z' }

  it('新增：整条原样按 id 覆盖（upsert），不改字段——保存报失败但其实落库了，再点一次不会变成两条', async () => {
    // 变异：改回 insert → 红
    await insertMeterReading(r)
    expect(shape()).toEqual(['meter_readings:upsert'])
    expect(h.calls[0].rows).toEqual(r)
    expect(h.calls[0].opts).toEqual({ onConflict: 'id' })
  })

  it('增、删、拉全量之前都先确认手上有登录态：没有就当「登录已过期」抛出来，不拿 anon key 发请求', async () => {
    // 变异：去掉 assertSession → 不抛，红
    const real = h.client.auth.getSession
    h.client.auth.getSession = async () => ({ data: { session: null }, error: null }) as never
    try {
      await expect(insertMeterReading(r)).rejects.toThrow(/session/i)
      await expect(deleteMeterReading('m1')).rejects.toThrow(/session/i)
      await expect(fetchAll()).rejects.toThrow(/session/i)
      expect(h.calls).toHaveLength(0)
    } finally {
      h.client.auth.getSession = real
    }
  })

  it('删除：只删这一个 id，绝不能发出不带过滤条件的删除', async () => {
    // 变异：deleteMeterReading 去掉 .eq('id', id) → 过滤条件为空，红（真发出去就是整张表没了，或者被 PostgREST 拒掉）
    await deleteMeterReading('m1')
    expect(shape()).toEqual(['meter_readings:delete:eq.id.m1'])
  })

  it('失败要抛出来，store 才知道要报错', async () => {
    h.results.push({ error: { message: 'Failed to fetch' } })
    await expect(insertMeterReading(r)).rejects.toMatchObject({ message: 'Failed to fetch' })
    h.results.push({ error: { message: 'Failed to fetch' } })
    await expect(deleteMeterReading('m1')).rejects.toMatchObject({ message: 'Failed to fetch' })
  })
})

describe('isPermanentError：分清「没网」和「数据被拒」', () => {
  it('22/23/42 开头的错误码是数据被拒，重传一万次也一样', () => {
    for (const code of ['22P02', '23503', '23505', '42703']) {
      expect(isPermanentError({ code, message: 'x' }), code).toBe(true)
    }
  })

  it('42501（权限不够）不是数据被拒：登录过期后拿 anon key 发请求被 RLS 挡下就是它，必须可重传，否则待传队列会把离线记的账删掉', () => {
    // 变异：去掉 42501 那行 → 红
    expect(isPermanentError({ code: '42501', message: 'new row violates row-level security policy' })).toBe(false)
    expect(isPermanentError({ code: '42P01', message: 'relation does not exist' })).toBe(true)
  })

  it('没网、超时、登录过期一律可重传——误判成永久失败是当场丢账', () => {
    expect(isPermanentError(Object.assign(new Error('Failed to fetch'), { name: 'TypeError' }))).toBe(false)
    expect(isPermanentError(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))).toBe(false)
    expect(isPermanentError({ code: 'PGRST301', message: 'JWT expired' })).toBe(false)
    expect(isPermanentError(new Error('说不清是什么'))).toBe(false)
  })
})
