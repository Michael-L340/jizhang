// 导入文件的校验。整库恢复会先删光云端再按这个文件重建，所以文件必须先验过——
// 这里每一条都对应一种「文件坏了但看起来正常」的情况。
import { describe, expect, it } from 'vitest'
import { backupFilename, buildCsv, buildJson, exportTrustworthy, parseImport, readExportMeta } from './csv'
import type { Account, Category, FacadeAdjust, MeterReading, Snapshot, Transaction } from '../types'
import { FACADE_EPOCH, facadeIdFor } from './facade'

// id 用真的 UUID：数据库三张表的 id 都是 uuid 列，'a1' 这种字符串根本进不去（22P02），
// 拿它当测试数据会让「校验通过 = 一定导得进去」这条性质在测试里假成立
const A1 = '11111111-1111-4111-8111-111111111111'
const C1 = '22222222-2222-4222-8222-222222222222'
const T1 = '33333333-3333-4333-8333-333333333333'
const T2 = '44444444-4444-4444-8444-444444444444'

const acc: Account = { id: A1, name: '微信', kind: 'wallet', sort: 1, is_archived: false, repay_day: null, facade_offset: null, defer_after_repay: null }
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
  installments: null,
  settles: null,
  hidden: null, is_offset: null,
  created_at: '2026-09-04T02:00:00.000Z',
}
const F1 = '55555555-5555-4555-8555-555555555555'
const fadj: FacadeAdjust = { id: F1, account_id: A1, date: '2026-09-27', cents: -800000, created_at: '2026-09-27T02:00:00.000Z' }
const M1 = '66666666-6666-4666-8666-666666666666'
const M2 = '77777777-7777-4777-8777-777777777777'
const reading: MeterReading = { id: M1, read_at: '2026-10-03T13:40:00.000Z', centi_kwh: 339340, created_at: '2026-10-03T13:40:05.000Z' }
const snap: Snapshot = { accounts: [acc], categories: [cat], transactions: [tx], facade_adjusts: [], meter_readings: [] }

function file(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, exported_at: '2026-09-04T00:00:00.000Z', accounts: [acc], categories: [cat], transactions: [tx], facade_adjusts: [], meter_readings: [], ...over })
}

describe('parseImport', () => {
  it('导出再导入，内容一模一样', () => {
    expect(parseImport(buildJson(snap))).toEqual(snap)
  })

  // 分类的 icon 是 text 列，除了 emoji 还可能是 `img:<名字>`（用户自己生成的 3D 图，见 lib/art.ts）。
  // 校验走的是通用的「是不是文字」，所以本来就该原样过——但「本来就该」不是保证：
  // 哪天有人给 icon 加一条「必须是单个 emoji」的校验，用了自定义图的分类整库就恢复不回来了。
  // 变异：把 readCategory 里的 icon 改成 `if (icon 不是单个 emoji) fail(...)` → 这条红
  it('img: 图标导出再导入不变——icon 不只装 emoji', () => {
    const withImg: Snapshot = { ...snap, categories: [{ ...cat, icon: 'img:lunch' }] }
    expect(parseImport(buildJson(withImg))).toEqual(withImg)
  })

  // 变异：validate.ts 的 readTx 里去掉 `hidden: hiddenOf(...)` → 导入后这一列丢了，这条红
  it('CSV 不带「外面不显示」那一列——表头印着功能名等于自曝，记号只走 JSON', () => {
    const withHidden: Snapshot = { ...snap, transactions: [{ ...tx, hidden: true }] }
    const csv = buildCsv(withHidden)
    expect(csv).not.toMatch(/隐藏|不显示|hidden/)
    expect(buildJson(withHidden)).toContain('"hidden": true')
  })

  it('「外面不显示」导出再导入不变——它是真数据，备份必须带着', () => {
    const withHidden: Snapshot = { ...snap, transactions: [{ ...tx, hidden: true }] }
    expect(parseImport(buildJson(withHidden))).toEqual(withHidden)
  })

  // ── 0010 外页面校准记录 ──
  it('外页面校准记录导出再导入不变——它是外页面的账本，备份必须带着', () => {
    // 变异：buildJson 不写 facade_adjusts → 导入回来是空的，红
    const withFa: Snapshot = { ...snap, facade_adjusts: [fadj] }
    expect(parseImport(buildJson(withFa))).toEqual(withFa)
    expect(buildJson(withFa)).toContain('"facade_adjusts"')
  })

  // ── 0011 电表读数 ──
  it('电表读数导出再导入不变（和流水、外页面校准一起整份往返）', () => {
    // 变异：buildJson 不写 meter_readings → 导入回来是空的，红；parseImport 不把这一节交给 validateImport → 同样红
    const full: Snapshot = { ...snap, facade_adjusts: [fadj], meter_readings: [reading, { ...reading, id: M2, read_at: '2026-10-03T22:10:00+08:00', centi_kwh: 0 }] }
    expect(parseImport(buildJson(full))).toEqual(full)
  })

  it('JSON 里电表读数紧跟在外页面校准后面——备份脚本的 buildJson 也是这个键序，两边的文件要能逐字节对上', () => {
    // 变异：把 meter_readings 挪到 transactions 前面 → 红
    const obj = JSON.parse(buildJson({ ...snap, meter_readings: [reading] }, { synced: true, lastSync: null })) as Record<string, unknown>
    expect(Object.keys(obj)).toEqual(['version', 'exported_at', 'synced', 'last_sync', 'accounts', 'categories', 'transactions', 'facade_adjusts', 'meter_readings'])
    // centi_kwh 原样是整数，不过任何换算
    expect(obj.meter_readings).toEqual([reading])
  })

  it('0011 之前的老文件没有这一节：按空的收，不报错', () => {
    // 变异：parseImport 把「缺这一节」也当成坏文件 → 红
    const old = JSON.parse(file()) as Record<string, unknown>
    delete old.meter_readings
    expect(parseImport(JSON.stringify(old)).meter_readings).toEqual([])
  })

  it('这一节存在但不是数组：文件坏了，拒绝', () => {
    // 变异：去掉 parseImport 里那句 Array.isArray 检查 → 'x' 会被当成没有、或者在 validate 里炸成英文，红
    expect(() => parseImport(file({ meter_readings: 'x' }))).toThrow(/不是本应用导出/)
    expect(() => parseImport(file({ meter_readings: null }))).toThrow(/不是本应用导出/)
    expect(() => parseImport(file({ meter_readings: { 0: reading } }))).toThrow(/不是本应用导出/)
  })

  it('电表读数里有坏的一条：整份拒绝（整库恢复会先清空，不能让它在半路炸）', () => {
    expect(() => parseImport(file({ meter_readings: [{ ...reading, centi_kwh: -5 }] }))).toThrow(/第 1 条电表读数/)
  })

  it('CSV 不带电表读数——CSV 是流水账，读数不是钱', () => {
    const csv = buildCsv({ ...snap, meter_readings: [reading] })
    expect(csv).not.toContain(M1)
    expect(csv).not.toContain('339340')
    expect(csv.split('\n')).toHaveLength(2) // 表头 + 那一笔流水
  })

  it('CSV 不带外页面校准记录——CSV 是给人看的，多一张表等于自曝', () => {
    const csv = buildCsv({ ...snap, facade_adjusts: [fadj] })
    expect(csv).not.toContain(F1)
    expect(csv).not.toMatch(/外页面|facade/)
  })

  it('0010 之前的老文件没有这一节：按老偏移量换算出来，否则整库恢复完外页面就不修饰了', () => {
    // 变异：parseImport 不调 migrateFacade → 空数组，红。
    // 修饰过的账户 → 一条记在 EPOCH 的（偏移量 + 校准合计）；id 由来源推出，和云端迁移过的那批是同一批
    const adj: Transaction = { ...tx, id: T2, type: 'adjust', amount: 100000, category_id: null, note: '余额校准' }
    const old = JSON.parse(file({ accounts: [{ ...acc, facade_offset: -216326 }], transactions: [tx, adj] })) as Record<string, unknown>
    delete old.facade_adjusts
    const got = parseImport(JSON.stringify(old))
    expect(got.facade_adjusts).toEqual([{ id: facadeIdFor('offset', A1), account_id: A1, date: FACADE_EPOCH, cents: -216326 + 100000, created_at: '2000-01-01T00:00:00.000Z' }])
    // 换算出来的东西自己也得过得了校验（它会被拿去 importAll）
    expect(() => parseImport(buildJson(got))).not.toThrow()
  })

  it('有这一节就一律以文件为准，哪怕是空的：0010 之后导出的文件不再换算，合并导入才不会翻倍', () => {
    // 变异：parseImport 按「数组为空」判断老文件 → 这里会算出一条，红
    const got = parseImport(file({ accounts: [{ ...acc, facade_offset: -216326 }], facade_adjusts: [], meter_readings: [] }))
    expect(got.facade_adjusts).toEqual([])
  })

  it('这一节存在但不是数组：文件坏了，拒绝', () => {
    expect(() => parseImport(file({ facade_adjusts: 'x' }))).toThrow(/不是本应用导出/)
  })

  it('外页面校准用的账户不在文件里就拒绝', () => {
    expect(() => parseImport(file({ facade_adjusts: [{ ...fadj, account_id: T2 }] }))).toThrow(/外页面校准.*账户在这个文件里找不到/)
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
    expect(Object.keys(out.transactions[0]).sort()).toEqual(['account_id', 'amount', 'category_id', 'created_at', 'date', 'hidden', 'id', 'installments', 'is_offset', 'note', 'settles', 'to_account_id', 'type'])
  })

  // 账户也守一遍。加一列而 readAccount 忘了收，备份文件里有、导进去却是空的，静默丢数据。
  it('账户也只收数据库真有的那几列', () => {
    const out = parseImport(file({ accounts: [{ id: '11111111-1111-4111-8111-111111111111', name: '中国银行', kind: 'bank', sort: 1, is_archived: false, repay_day: 17, facade_offset: -134874, 余额: '瞎写的' }] }))
    expect(Object.keys(out.accounts[0]).sort()).toEqual(['defer_after_repay', 'facade_offset', 'id', 'is_archived', 'kind', 'name', 'repay_day', 'sort'])
    expect(out.accounts[0].repay_day).toBe(17)
    // 0008：京东白条「本期还过款之后下的单归下一期」的开关，同样要能原样往返
    const on = parseImport(file({ accounts: [{ id: '11111111-1111-4111-8111-111111111111', name: '京东白条', kind: 'credit', sort: 5, is_archived: false, repay_day: 17, facade_offset: null, defer_after_repay: true }] }))
    expect(on.accounts[0].defer_after_repay).toBe(true)
    // 旧备份没有这一列，按 null 处理，不能崩
    const oldFile = parseImport(file({ accounts: [{ id: '11111111-1111-4111-8111-111111111111', name: '花呗', kind: 'credit', sort: 6, is_archived: false, repay_day: 1, facade_offset: null }] }))
    expect(oldFile.accounts[0].defer_after_repay).toBeNull()
    // 0007：漏在 readAccount 里补这一句的话，备份文件里明明有这个值，
    // 导入时会在发给数据库之前被悄悄丢掉，一点报错都没有
    expect(out.accounts[0].facade_offset).toBe(-134874)
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

describe('CSV 里的公式注入（2026-10-08 审出来的）', () => {
  it('备注以 = + - @ 开头的，前面垫一个单引号，Excel 就当文字不当公式；带回车的加引号', () => {
    // 变异：去掉垫引号那行 → 红
    const snap: Snapshot = { accounts: [acc], categories: [cat], transactions: [{ ...tx, note: '=HYPERLINK("http://x")' }, { ...tx, id: T2, note: '+86 打车' }, { ...tx, id: '66666666-6666-4666-8666-666666666666', note: '第一行\r第二行' }], facade_adjusts: [], meter_readings: [] }
    const csv = buildCsv(snap)
    expect(csv).toContain(',"\'=HYPERLINK(""http://x"")"')
    expect(csv).toContain(",'+86 打车,")
    expect(csv).toContain('"第一行\r第二行"')
    // 金额列不受影响：负数校准照旧是数字
    const adj: Transaction = { ...tx, id: T2, type: 'adjust', amount: -1250, category_id: null, note: null }
    expect(buildCsv({ ...snap, transactions: [adj] })).toMatch(/,-12\.50,/)
  })
})
