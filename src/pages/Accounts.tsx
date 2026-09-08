import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AccountIcon, accountColor } from '../components/AccountIcon'
import { ChipGroup } from '../components/ChipGroup'
import { Sheet } from '../components/Sheet'
import { balances, balanceShares, creditBill, currentDueDate, debtOf, dueNow, monthByAccount, previewRepay, splitAccounts } from '../lib/compute'
import type { BillRow, CreditBill } from '../lib/compute'
import { daysBetween, fmtIsoZh, monthOf, nowIso, today } from '../lib/date'
import { applyFacade, normalizeOffset, offsetFor, visibleTxs } from '../lib/facade'
import { useCategoryMap, usePersistedState, useTabReset } from '../lib/hooks'
import { newId } from '../lib/id'
import { guessIcon } from '../lib/icons'
import { calcDelta, fmtYuan, parseYuan } from '../lib/money'
import { useActiveAccounts, useStore } from '../lib/store'
import type { Account, Transaction } from '../types'

export function Accounts() {
  const txs = useStore((s) => s.transactions)
  const addTx = useStore((s) => s.addTx)
  const removeTx = useStore((s) => s.removeTx)
  const editTx = useStore((s) => s.editTx)
  const showToast = useStore((s) => s.showToast)
  const lastSync = useStore((s) => s.lastSync)
  const syncFailed = useStore((s) => s.syncFailed)
  const mode = useStore((s) => s.mode)
  const updateAccount = useStore((s) => s.updateAccount)
  const syncing = useStore((s) => s.syncing)
  const refresh = useStore((s) => s.refresh)
  const outboxCount = useStore((s) => s.outboxCount)
  const accounts = useActiveAccounts()
  const catMap = useCategoryMap()
  const { assets, credits } = useMemo(() => splitAccounts(accounts), [accounts])
  const bal = useMemo(() => balances(txs, accounts), [txs, accounts])
  // 外页面藏掉被修饰账户的校准：卡片右下的「本月 ±」和副标题的「上次校准」都要走它。
  // 余额 0.00 底下挂一行「本月 +6,391.00」是最露馅的一处。余额本身仍然拿真实 txs 算。
  const vtxs = useMemo(() => visibleTxs(txs, accounts, mode), [txs, accounts, mode])
  // 不用 totalOf(bal) + debt：debt 只加回负余额，某个白条多还成正数时那笔会留在合计里，
  // 而下面的卡片列表里没有它，两个数就对不上（首页同样的理由，同样的算法）
  // 里外页面：外页面把资产账户的余额加上各自的偏移量。白条不参与，
  // 所以下面所有和欠款有关的计算仍然用真实的 bal。
  const dispBal = useMemo(() => applyFacade(bal, accounts, mode), [bal, accounts, mode])
  const assetTotal = useMemo(() => assets.reduce((s, a) => s + (dispBal[a.id] ?? 0), 0), [assets, dispBal])
  // 原来在 accounts.map() 内部对全量流水扫描，而输入框每次按键都会重渲染整页。
  // 注意：adjust 记录只在「有差额」时才产生，所以这里得到的是「上次校准」而不是「上次核对」。
  const lastAdjusts = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of vtxs) {
      if (t.type !== 'adjust' || !t.account_id) continue
      const cur = m.get(t.account_id)
      if (!cur || t.created_at > cur) m.set(t.account_id, t.created_at)
    }
    return m
  }, [vtxs])
  const [target, setTarget] = useState<Account | null>(null)
  const [input, setInput] = useState('')
  // 里页面第二个框：这个账户在外页面显示多少
  const [facadeInput, setFacadeInput] = useState('')
  const [busy, setBusy] = useState(false)

  // 白条：余额为负是欠款。核对时让用户输「待还」（正数），差额再翻回余额的方向。
  const creditTarget = target ? credits.some((c) => c.id === target.id) : false
  // 外页面点开非白条账户时，这个框改的是「外面显示多少」，只动偏移量、不写任何流水。
  // 白条不分里外，所以在外页面点白条走的还是真正的校准。
  const facadeOnly = mode === 'outer' && Boolean(target) && !creditTarget
  // 里页面的非白条账户才有第二个框
  const showFacadeField = mode === 'inner' && Boolean(target) && !creditTarget
  const computed = target ? (facadeOnly ? dispBal[target.id] ?? 0 : bal[target.id] ?? 0) : 0
  const shown = creditTarget ? -computed : computed
  const real = parseYuan(input)
  const rawDelta = calcDelta(input, shown) // 算式本体在 lib/money.ts，那里测得到
  const delta = rawDelta === null ? null : creditTarget ? -rawDelta : rawDelta

  function open(a: Account) {
    setTarget(a)
    const isCred = credits.some((c) => c.id === a.id)
    const real = bal[a.id] ?? 0
    // 外页面预填的是屏幕上那个数（也就是修饰过的），里页面和白条预填真实值
    const v = isCred ? -real : mode === 'outer' ? dispBal[a.id] ?? 0 : real
    setInput(fmtYuan(v).replace(/,/g, ''))
    setFacadeInput(fmtYuan(real + (a.facade_offset ?? 0)).replace(/,/g, ''))
  }

  /**
   * 里页面改「实际余额」时，「对外显示」跟着同幅变动——偏移量是固定的，
   * 你看到的直接是最终结果，不用心算。想单独定外面那个数就直接改下面那个框。
   */
  function onRealInput(v: string) {
    setInput(v)
    if (!target || creditTarget || mode !== 'inner') return
    const r = parseYuan(v)
    if (r !== null) setFacadeInput(fmtYuan(r + (target.facade_offset ?? 0)).replace(/,/g, ''))
  }

  /** 把「对外显示多少」写成偏移量。realCents 是这一刻的真实余额 */
  async function saveFacade(a: Account, realCents: number): Promise<boolean> {
    const want = parseYuan(facadeOnly ? input : facadeInput)
    if (want === null) return true
    const next = normalizeOffset(offsetFor(want, realCents))
    if (next === (a.facade_offset ?? null)) return true
    return await updateAccount(a.id, { facade_offset: next })
  }

  async function confirm() {
    if (!target) return
    // 外页面：不写流水，只改这个账户在外面显示多少
    if (facadeOnly) {
      if (parseYuan(input) === null) return
      setBusy(true)
      const ok = await saveFacade(target, bal[target.id] ?? 0)
      setBusy(false)
      if (ok) setTarget(null)
      return
    }
    if (delta === null) return
    // 没差额就不留痕：以前会写一条 0 元「余额核对」，只是为了同步「上次核对时间」，
    // 结果流水里全是 0 元行，用户嫌碍眼。核对本身不产生数据。
    if (delta === 0) {
      setBusy(true)
      const ok = await saveFacade(target, computed)
      setBusy(false)
      if (!ok) return
      showToast(`${target.name} 核对无差异，没有产生记录`)
      setTarget(null)
      return
    }
    setBusy(true)
    const ok = await addTx({
      id: newId(),
      date: today(),
      type: 'adjust',
      amount: delta,
      account_id: target.id,
      to_account_id: null,
      category_id: null,
      note: '余额校准',
      installments: null,
      settles: null,
      created_at: nowIso(),
    })
    // 真实余额变成刚输入的那个数之后，再按「对外显示」反推偏移量
    if (ok) await saveFacade(target, computed + delta)
    setBusy(false)
    if (ok) {
      showToast(`${target.name} 已校准 ${fmtYuan(delta, { sign: true })}`)
      setTarget(null)
    }
  }

  const ym = monthOf(today())
  const byAcc = useMemo(() => monthByAccount(vtxs, ym), [vtxs, ym])
  const nameOf = (id: string): string => accounts.find((a) => a.id === id)?.name ?? ''
  // 占比条跟着屏幕上的数字走，否则外页面「各占多少」和四张卡对不上
  const shares = useMemo(() => balanceShares(dispBal, assets.map((a) => a.id)), [dispBal, assets])

  // ---- 白条 ----
  const today0 = today()
  const due = useMemo(() => dueNow(txs, credits, today0), [txs, credits, today0])
  const dueTotal = [...due.values()].reduce((s, v) => s + v, 0)
  const debt = debtOf(bal, credits)
  const withDebt = credits.filter((c) => (bal[c.id] ?? 0) < 0).length
  const [creditOpen, setCreditOpen] = usePersistedState('jz_acc_creditOpen', false)
  const [creditTarget2, setCreditTarget2] = useState<Account | null>(null)
  // 面板按「一行 = 一期」画：本期该还的在上面，往后没到期的灰着列在下面。
  /** 勾选的行（存「支出 id + 第几期」）。默认全勾本期那几行，金额就是本期该还 */
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  /** 正在修改的那笔还款；null = 在记新的一笔 */
  const [editingRepay, setEditingRepay] = useState<Transaction | null>(null)
  // 改某笔还款时要把它自己排除掉，否则被它结清的那几单不在账单里，取消都取消不了
  const bill = useMemo(() => (creditTarget2 ? creditBill(txs, creditTarget2, today0, editingRepay?.id) : null), [txs, creditTarget2, today0, editingRepay])
  /** 本期 + 往后，合成一份可勾选的清单。往后那几行勾上就是提前还 */
  const billRows = useMemo(() => [...(bill?.rows ?? []), ...(bill?.upcoming ?? [])], [bill])
  // 这个白条上最近的几笔还款，点一条可以回去改勾选（勾错了不用删掉重记）
  const recentRepays = useMemo(
    () =>
      creditTarget2
        ? txs
            .filter((t) => t.type === 'transfer' && t.to_account_id === creditTarget2.id)
            .sort((a, b) => (a.date === b.date ? (a.created_at < b.created_at ? 1 : -1) : a.date < b.date ? 1 : -1))
            .slice(0, 5)
        : [],
    [txs, creditTarget2],
  )
  const yuanStr = (cents: number) => fmtYuan(cents).replace(/,/g, '')
  /** 白条面板里到处要写的「9/17」。整条链路都是北京时间 YYYY-MM-DD，直接切字符串 */
  const mmdd = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`
  /** 提前还的钱最远抵到哪一期，用来交代「另有 ¥X 已提前还，抵到 12/1 那一期」 */
  const lastPrepaidDate = (b: CreditBill) => [...b.upcoming].reverse().find((r) => r.paid > 0)?.due.date ?? ''
  /** 白条余额可以是正的：还多了，或者有退款。以前正余额一律显示「已还清」，那笔钱在面板里看不见 */
  const creditTitle = (cents: number) => (cents < 0 ? `欠 ${fmtYuan(-cents, { symbol: true })}` : cents > 0 ? `余 ${fmtYuan(cents, { symbol: true })}` : '已还清')
  /**
   * 勾选的键。一张分期订单在清单里占好几行（第 1/3 期、第 2/3 期……），
   * 光拿 tx.id 当键会把它们连成一片，勾一行等于勾了整单。
   */
  const keyOf = (r: { tx: Transaction; due: { seq: number } }) => `${r.tx.id}#${r.due.seq}`
  /** 勾选之和。改勾选时金额跟着变，但用户仍然可以自己改成别的数 */
  function pickSum(ids: ReadonlySet<string>): number {
    return billRows.reduce((sum, r) => sum + (ids.has(keyOf(r)) ? r.due.amount : 0), 0)
  }
  const pickedSum = pickSum(picked)
  function togglePick(id: string) {
    const next = new Set(picked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setPicked(next)
    setRepayInput(yuanStr(pickSum(next)))
  }
  const [repayFrom, setRepayFrom] = usePersistedState<string | null>('jz_repay_from', null)
  const [repayInput, setRepayInput] = useState('')

  // 再点一次「账户」：收起白条、关掉弹层、滚回顶部。
  // repayFrom 不清——「我一般用中国银行还」是偏好，不是「这次在看什么」。
  useTabReset(() => {
    setCreditOpen(false)
    setTarget(null)
    setCreditTarget2(null)
  })
  const repayCents = parseYuan(repayInput)
  const fromAcc = assets.find((a) => a.id === repayFrom) ?? assets[0]
  /**
   * 「抵 10/1 那期 ¥6.66，剩 ¥3.34 抵到 11/1」——跟着输入框实时变。
   * 改还款时不预告：那笔钱已经被排除在账单外了，再算一遍只会让人更糊涂。
   */
  const alloc = useMemo(() => {
    if (!bill || editingRepay || !repayCents || repayCents <= 0) return ''
    const { hits, extra } = previewRepay(bill, repayCents)
    if (!hits.length) return extra > 0 ? `这个账户没有要还的期，这 ${fmtYuan(extra, { symbol: true })} 会存成余额` : ''
    const parts = hits.map((h) => `${mmdd(h.due.date)} 那期 ${fmtYuan(h.amount, { symbol: true })}`)
    return `抵 ${parts.join('、')}${extra > 0 ? `，多出的 ${fmtYuan(extra, { symbol: true })} 存成余额` : ''}`
  }, [bill, editingRepay, repayCents])

  function openCredit(a: Account) {
    setCreditTarget2(a)
    setEditingRepay(null)
    // 默认只勾本期那几行（含逾期），往后的留着不勾——想提前还自己去勾。
    // 金额栏就等于勾选之和，也就是「本期该还」。全都还清了就留空，不再兜底填全部欠款：
    // 那个兜底正是用户 2026-09-08 撞上的坑，面板空着却预填 20.00，看着像在催一次还清。
    const b = creditBill(txs, a, today0)
    setPicked(new Set(b.rows.map((r) => `${r.tx.id}#${r.due.seq}`)))
    setRepayInput(b.total > 0 ? yuanStr(b.total) : '')
  }

  /** 点最近的某笔还款：把它的金额和勾选装回面板，改完保存 */
  function editRepay(t: Transaction) {
    setEditingRepay(t)
    // settles 存的是整单 id，而清单的键带期数。能被结清的只有「一次还清」的单，所以固定是 #1
    setPicked(new Set((t.settles ?? []).map((id) => `${id}#1`)))
    setRepayInput(yuanStr(t.amount))
  }

  /**
   * 勾中且「能记结清」的那些订单 id。分期订单能勾（要算进金额），但不写进 settles——
   * settles 指的是一整单结清，分期有好几期，说不清勾一下算结清了整单还是某一期。
   */
  function settlesOfPicked(): string[] | null {
    const ids = billRows.filter((r) => r.selectable && picked.has(keyOf(r))).map((r) => r.tx.id)
    return ids.length ? ids : null
  }

  /**
   * 删掉正在改的这笔还款。结清关系挂在这条记录上，删了它，被它结清的订单
   * 自动回到账单里，不用另外去取消勾选。
   */
  async function deleteRepay() {
    const t = editingRepay
    if (!t) return
    const n = t.settles?.length ?? 0
    if (!window.confirm(`删掉 ${t.date} 这笔 ¥${fmtYuan(t.amount)} 的还款？${n ? `被它结清的 ${n} 单会回到账单里。` : ''}`)) return
    setBusy(true)
    const ok = await removeTx(t.id)
    setBusy(false)
    if (!ok) return
    setCreditTarget2(null)
    showToast(`已删掉这笔还款 ¥${fmtYuan(t.amount)}`, async () => {
      // 撤销就是把原样那条加回去：id 和 settles 都不变，结清关系跟着一起回来
      if (await addTx(t)) showToast('已恢复这笔还款')
    })
  }

  async function repay() {
    if (!creditTarget2 || !repayCents || repayCents <= 0) return
    const credit = creditTarget2
    setBusy(true)
    if (editingRepay) {
      const next: Transaction = { ...editingRepay, amount: repayCents, settles: settlesOfPicked() }
      const ok = await editTx(next)
      setBusy(false)
      if (!ok) return
      setCreditTarget2(null)
      showToast(`已改这笔还款 ¥${fmtYuan(repayCents)}`)
      return
    }
    if (!fromAcc) {
      setBusy(false)
      return
    }
    const tx: Transaction = {
      id: newId(),
      date: today(),
      type: 'transfer',
      amount: repayCents,
      account_id: fromAcc.id,
      to_account_id: credit.id,
      category_id: null,
      note: '还款',
      installments: null,
      settles: settlesOfPicked(),
      created_at: nowIso(),
    }
    const ok = await addTx(tx)
    setBusy(false)
    if (!ok) return
    setCreditTarget2(null)
    showToast(`已记还款 ¥${fmtYuan(repayCents)} · ${fromAcc.name} → ${credit.name}`, async () => {
      const removed = await removeTx(tx.id)
      if (removed) showToast(`已撤销还款 ¥${fmtYuan(repayCents)}`)
    })
  }

  /** 白条面板里一行账单。本期和「往后」两段共用，只是往后那段整体灰一档 */
  function billLine(r: BillRow) {
    const { icon, title } = planTitle(r.tx.category_id, r.tx.note)
    const on = picked.has(keyOf(r))
    const ahead = r.state === 'upcoming'
    return (
      <button
        key={keyOf(r)}
        type="button"
        className={`w-full text-left flex items-center gap-2.5 py-2 border-t border-line first:border-t-0 ${on ? 'bg-brand-soft' : ''}`}
        onClick={() => togglePick(keyOf(r))}
      >
        <span className={`w-[19px] h-[19px] rounded-md shrink-0 flex items-center justify-center text-[12px] font-bold ${on ? 'bg-brand text-on-brand' : 'border-2 border-line'}`}>
          {on ? '✓' : ''}
        </span>
        <span className={`text-xl w-7 text-center shrink-0 ${ahead ? 'opacity-60' : ''}`}>{icon}</span>
        <span className="flex-1 min-w-0">
          <span className={`block text-sm truncate ${ahead ? 'text-muted' : ''}`}>{title}</span>
          <span className="block text-[11px] text-muted num">
            {mmdd(r.tx.date)} 下单 ¥{fmtYuan(r.tx.amount)}
            {r.due.of > 1 ? ` · 第 ${r.due.seq}/${r.due.of} 期` : ''}
            {creditTarget2?.repay_day ? ` · ${mmdd(r.due.date)} 到期` : ' · 待扣款'}
          </span>
          {/* 逾期要说清欠了多久：平台那边多半已经在计息了 */}
          {r.state === 'overdue' ? <span className="block text-[11px] text-expense">已逾期 {daysBetween(r.due.date, today0)} 天</span> : null}
          {r.paid >= r.due.amount ? (
            <span className="block text-[11px] text-income">{ahead ? '已提前还' : '这一期已还清'}</span>
          ) : r.paid > 0 ? (
            <span className="block text-[11px] text-income num">已还 ¥{fmtYuan(r.paid)}，还差 ¥{fmtYuan(r.due.amount - r.paid)}</span>
          ) : null}
          {/* 平台有账单周期，App 不知道那个截止日。本期还过款之后才下的单
              多半已经进了下一期，这里只标出来让人自己判断，不改算法 */}
          {r.afterRepay ? <span className="block text-[11px] text-adjust">本期已还过款，这笔可能算下期</span> : null}
        </span>
        <span className={`num text-sm shrink-0 ${ahead || r.paid >= r.due.amount ? 'text-muted font-medium' : 'font-medium'}`}>¥{fmtYuan(r.due.amount)}</span>
      </button>
    )
  }

  const planTitle = (categoryId: string | null, note: string | null): { icon: string; title: string } => {
    const c = categoryId ? catMap.get(categoryId) : undefined
    const parent = c?.parent_id ? catMap.get(c.parent_id) : c
    const name = c ? (c.parent_id ? `${parent?.name ?? ''} · ${c.name}` : c.name) : '未分类'
    const icon = (c?.parent_id ? c.icon ?? guessIcon(c.name) : null) ?? parent?.icon ?? '🧾'
    return { icon, title: note ? `${name} · ${note}` : name }
  }

  return (
    <div className="px-4 pb-6">
      <div className="flex items-center justify-between pt-4 pb-3">
        <span className="text-2xl font-bold">账户</span>
        <Link to="/settings" className="text-sm text-brand-ink px-2 py-1">
          设置
        </Link>
      </div>

      <div className="card p-4 mb-3">
        {/* 大数字和首页保持同一个口径：资产账户之和，不含白条。
            以前这里是「总余额」（已经减掉白条），两页大数字差一个欠款额，对着看容易懵。
            全项目只留三个词：总资产（不含白条）、白条待还、净资产（前两者相减）。 */}
        <div className="text-xs text-muted">总资产</div>
        <div className={`num text-3xl font-bold ${assetTotal < 0 ? 'text-expense' : ''}`}>{fmtYuan(assetTotal, { symbol: true })}</div>
        {credits.length && debt > 0 ? (
          <div className="num text-xs text-muted mt-1">白条待还 {fmtYuan(debt, { symbol: true })}</div>
        ) : null}
        {/* 同步失败时这里是用户最先看见的地方，得能就地重试——
            以前只有设置页那个不像按钮的状态格能点，等于没有。 */}
        <div className={`text-xs mt-1 flex items-center gap-2 ${syncFailed ? 'text-adjust' : 'text-muted'}`}>
          <span>
            {lastSync ? `上次同步 ${fmtIsoZh(lastSync)}` : '尚未同步'}
            {syncFailed ? ' · 最近一次同步失败' : ''}
            {outboxCount > 0 ? ` · ${outboxCount} 笔待上传` : ''}
          </span>
          {syncFailed ? (
            <button type="button" className="chip shrink-0" style={{ padding: '2px 9px' }} disabled={syncing} onClick={() => void refresh()}>
              {syncing ? '同步中…' : '重试'}
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {assets.map((a) => {
          const lc = lastAdjusts.get(a.id) ?? null
          return (
            <button key={a.id} type="button" className="card p-4 text-left flex items-center gap-3" onClick={() => open(a)}>
              <AccountIcon name={a.name} />
              <span className="flex-1 min-w-0">
                <span className="block font-medium">{a.name}</span>
                <span className="block text-xs text-muted">{lc ? `上次校准 ${fmtIsoZh(lc)}` : '点此输入实际余额核对'}</span>
              </span>
              <span className="text-right">
                <span className={`block num text-lg font-semibold ${(dispBal[a.id] ?? 0) < 0 ? 'text-expense' : ''}`}>{fmtYuan(dispBal[a.id] ?? 0)}</span>
                {/* 本月这个账户进出了多少。转账两头都算、校准也算，所以它和余额的变化能对上。 */}
                {(() => {
                  const m = byAcc.get(a.id)
                  if (!m || m.delta === 0) return <span className="block text-[11px] text-muted">本月没动</span>
                  return (
                    <span className={`block num text-[11px] ${m.delta < 0 ? 'text-expense' : 'text-income'}`}>
                      本月 {fmtYuan(m.delta, { sign: true })}
                    </span>
                  )
                })()}
              </span>
            </button>
          )
        })}

        {/* 白条平时收成一行：欠款合计 + 接下来要还的。点开才展开各平台，再点收起。 */}
        {credits.length ? (
          <div className="card p-4 pt-3">
            <button type="button" className="w-full text-left flex items-center gap-3" onClick={() => setCreditOpen(!creditOpen)}>
              <AccountIcon name="白条" />
              <span className="flex-1 min-w-0">
                <span className="block font-medium">白条</span>
                <span className="block text-xs text-muted">
                  {credits.length} 个平台 · {withDebt ? `${withDebt} 个有欠款` : '没有欠款'}
                </span>
              </span>
              <span className="text-right">
                <span className={`block num text-lg font-semibold ${debt > 0 ? 'text-expense' : 'text-muted'}`}>{debt > 0 ? `欠 ${fmtYuan(debt)}` : '已还清'}</span>
                <span className="block num text-[11px] text-muted">
                  {dueTotal > 0 ? `接下来要还 ${fmtYuan(dueTotal)}` : '没有要还的'} {creditOpen ? '⌄' : '›'}
                </span>
              </span>
            </button>
            {creditOpen ? (
              <div className="mt-2 ml-5 pl-3 border-l-2 border-brand">
                {credits.map((c) => {
                  const owed = Math.max(0, -(bal[c.id] ?? 0))
                  const d = due.get(c.id) ?? 0
                  const n = creditBill(txs, c, today0).rows.length
                  return (
                    <button key={c.id} type="button" className="w-full text-left flex items-center gap-2.5 py-2.5" onClick={() => openCredit(c)}>
                      <AccountIcon name={c.name} size={28} />
                      <span className="flex-1 min-w-0">
                        <span className="block text-[15px]">{c.name}</span>
                        <span className="block text-[11px] text-muted">{n ? `本期 ${n} 笔要还` : owed ? '点开记还款' : '没有欠款'}</span>
                      </span>
                      <span className="text-right">
                        <span className={`block num font-semibold ${owed > 0 ? 'text-expense' : 'text-muted text-sm'}`}>{owed > 0 ? `欠 ${fmtYuan(owed)}` : '已还清'}</span>
                        {/* 各家还款日不同，直接把日期写出来，比「本月应还」准 */}
                        {d > 0 ? (
                          <span className="block num text-[11px] text-muted">
                            {c.repay_day ? `${mmdd(currentDueDate(today0, c.repay_day) ?? today0)} 应还` : '待扣'} {fmtYuan(d)}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  )
                })}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {shares.length ? (
        <div className="card p-4 mt-3">
          <div className="text-xs text-muted mb-2">钱放在哪儿</div>
          <div className="flex h-2.5 rounded-full overflow-hidden bg-line">
            {shares.map((s) => (
              <span key={s.id} style={{ width: `${s.ratio * 100}%`, background: accountColor(nameOf(s.id)) }} />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2.5 text-[11px] text-muted">
            {shares.map((s) => (
              <span key={s.id} className="flex items-center gap-1.5">
                <i className="w-2 h-2 rounded-full" style={{ background: accountColor(nameOf(s.id)) }} />
                {nameOf(s.id)} {Math.round(s.ratio * 100)}%
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="text-xs text-muted mt-4 leading-relaxed">
        点账户输入实际余额。一致就什么都不记；不一致时，差额会记成一条「余额校准」，出现在流水里但不计入收入支出，随时可以删除或改成一笔正常收支。
        {credits.length
          ? ' 白条：下单时记支出（账户选白条、填分几期），到期日按这个账户的还款日算。平台扣款时点开白条，勾上还的是哪几笔再记还款，记成转账，不会把同一笔算两次。'
          : ''}
      </div>

      {/* 白条弹层：分期明细 + 一键还款 + 核对待还 */}
      <Sheet open={Boolean(creditTarget2)} onClose={() => setCreditTarget2(null)} title={creditTarget2 ? `${creditTarget2.name} · ${creditTitle(bal[creditTarget2.id] ?? 0)}` : ''}>
        {creditTarget2 ? (
          <>
            {bill && billRows.length ? (
              <>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-muted">
                    {bill.dueDate ? `本期 · ${mmdd(bill.dueDate)} 到期` : '待扣款'} · 勾上的算进金额
                  </span>
                  <button
                    type="button"
                    className="text-[11px] text-brand-ink px-1"
                    onClick={() => {
                      const all = picked.size < billRows.length ? new Set(billRows.map(keyOf)) : new Set<string>()
                      setPicked(all)
                      setRepayInput(yuanStr(pickSum(all)))
                    }}
                  >
                    {picked.size < billRows.length ? '全选' : '全不选'}
                  </button>
                </div>
                <div className="mb-3">{bill.rows.map(billLine)}</div>
                {/* 三行小结：这一期的账清没清，一眼看出来。「已还」是分配到本期这几行的钱 */}
                <div className="text-xs flex flex-col gap-1 mb-4 pt-2.5 border-t border-line">
                  <span className="flex justify-between">
                    <span className="text-muted">本期该还</span>
                    <span className="num font-medium">{fmtYuan(bill.total, { symbol: true })}</span>
                  </span>
                  <span className="flex justify-between">
                    <span className="text-muted">已还</span>
                    <span className="num font-medium text-income">{fmtYuan(bill.paid, { symbol: true })}</span>
                  </span>
                  <span className="flex justify-between">
                    <span className="text-muted">还差</span>
                    <span className={`num font-medium ${bill.left > 0 ? 'text-expense' : 'text-muted'}`}>{fmtYuan(bill.left, { symbol: true })}</span>
                  </span>
                  {bill.overdueTotal > 0 ? (
                    <span className="text-[11px] text-expense num">其中 {fmtYuan(bill.overdueTotal, { symbol: true })} 已经逾期，平台那边可能在计息</span>
                  ) : null}
                  {/* 多还的钱去哪了要交代清楚，否则「已还」比你实际打进去的少，看着像丢了 */}
                  {bill.prepaid > 0 ? (
                    <span className="text-[11px] text-income num">另有 {fmtYuan(bill.prepaid, { symbol: true })} 已提前还，抵到 {mmdd(lastPrepaidDate(bill))} 那一期</span>
                  ) : null}
                  {bill.afterRepayTotal > 0 ? (
                    <span className="text-[11px] text-adjust num">其中 {fmtYuan(bill.afterRepayTotal, { symbol: true })} 是本期还款之后才下的单，平台那边可能已经算进下一期账单了</span>
                  ) : null}
                </div>
                {bill.upcoming.length ? (
                  <>
                    <div className="text-xs text-muted mb-1">往后还有 {bill.upcoming.length} 期 · 勾上就是提前还</div>
                    <div className="mb-3">{bill.upcoming.map(billLine)}</div>
                  </>
                ) : null}
              </>
            ) : null}

            <div className="text-xs text-muted mb-1">{editingRepay ? `改这笔还款 · ${editingRepay.date}` : '记一笔还款'}</div>
            {editingRepay ? null : (
              <ChipGroup
                options={assets.map((a) => ({ id: a.id, label: a.name, node: <AccountIcon name={a.name} size={18} /> }))}
                value={fromAcc?.id ?? ''}
                onChange={setRepayFrom}
                className="mb-2"
              />
            )}
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm text-muted flex-1 truncate">
                {(editingRepay ? (editingRepay.account_id ? nameOf(editingRepay.account_id) : '?') : (fromAcc?.name ?? '?'))} → {creditTarget2.name}
              </span>
              <span className="text-xl">¥</span>
              <input inputMode="decimal" className="w-32 num text-xl font-semibold bg-bg rounded-xl px-3 py-2 text-right" value={repayInput} onChange={(e) => setRepayInput(e.target.value)} />
            </div>
            {/* 勾了几单却填了别的数，多半是勾错了。提醒但不拦——平台合并扣款、收零头都可能 */}
            {pickedSum > 0 && repayCents !== null && repayCents > 0 && pickedSum !== repayCents ? (
              <div className="text-[11px] text-adjust mb-1">
                勾选的是 {fmtYuan(pickedSum, { symbol: true })}，填的是 {fmtYuan(repayCents, { symbol: true })}，对不上。确认没勾错就照样记。
              </div>
            ) : null}
            {/* 实时预告这笔钱会抵到哪几期。输什么会发生什么，不用先记一笔再看 */}
            {alloc ? <div className="text-[11px] text-brand-ink mb-1 num">{alloc}</div> : null}
            <div className="text-[11px] text-muted mb-3">金额跟着勾选自动变，扣得不一样可以自己改。记成转账，不进收支统计。</div>
            <button
              type="button"
              disabled={busy || (!editingRepay && !fromAcc) || !repayCents || repayCents <= 0}
              className="w-full rounded-2xl bg-brand text-on-brand py-3 font-semibold disabled:opacity-40"
              onClick={repay}
            >
              {editingRepay ? '保存修改' : '记这笔还款'}
            </button>
            {editingRepay ? (
              <>
                <button type="button" disabled={busy} className="w-full rounded-2xl bg-expense-soft text-expense py-3 font-medium mt-2 disabled:opacity-40" onClick={deleteRepay}>
                  删掉这笔还款
                </button>
                <button type="button" className="w-full rounded-2xl bg-bg text-muted py-3 font-medium mt-2" onClick={() => creditTarget2 && openCredit(creditTarget2)}>
                  取消，回到记新的一笔
                </button>
              </>
            ) : recentRepays.length ? (
              <>
                <div className="text-xs text-muted mt-4 mb-1">最近的还款 · 点一条可以改勾选</div>
                <div className="mb-1">
                  {recentRepays.map((t) => (
                    <button key={t.id} type="button" className="w-full text-left flex items-center gap-2.5 py-2 border-t border-line first:border-t-0" onClick={() => editRepay(t)}>
                      <span className="flex-1 min-w-0 text-sm num">
                        {Number(t.date.slice(5, 7))}/{Number(t.date.slice(8))}
                        <span className="text-muted"> · {t.account_id ? nameOf(t.account_id) : '?'}</span>
                      </span>
                      <span className="text-[11px] text-muted shrink-0">{t.settles?.length ? `结清 ${t.settles.length} 单` : '没指明结清哪几单'}</span>
                      <span className="num text-sm font-medium shrink-0">¥{fmtYuan(t.amount)}</span>
                      <span className="text-muted text-xs shrink-0">›</span>
                    </button>
                  ))}
                </div>
              </>
            ) : null}
            <button
              type="button"
              className="w-full rounded-2xl bg-brand-soft text-brand-ink py-3 font-medium mt-2"
              onClick={() => {
                const a = creditTarget2
                setCreditTarget2(null)
                open(a)
              }}
            >
              核对待还 · 输入平台里显示的数字
            </button>
          </>
        ) : null}
      </Sheet>

      <Sheet
        open={Boolean(target)}
        onClose={() => setTarget(null)}
        title={target ? `${target.name} · ${facadeOnly ? '输入余额' : creditTarget ? '输入待还金额' : '输入实际余额'}` : ''}
      >
        {/* 里页面才有标签：外页面就是一个光秃秃的输入框，看起来和任何记账 App 一样正常。
            反过来这也是本人辨认自己在哪一边的记号——有没有下面那些对账信息。 */}
        {showFacadeField ? <div className="text-xs text-muted mb-1">实际余额</div> : null}
        <div className="flex items-center gap-2 mb-3">
          <span className="text-2xl">¥</span>
          <input
            autoFocus
            inputMode="decimal"
            className="flex-1 num text-2xl font-semibold bg-bg rounded-xl px-3 py-2"
            value={input}
            onChange={(e) => onRealInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && confirm()}
          />
        </div>
        {showFacadeField ? (
          <>
            <div className="text-xs text-muted mb-1">对外显示</div>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-2xl text-muted">¥</span>
              <input
                inputMode="decimal"
                className="flex-1 num text-2xl font-semibold bg-bg rounded-xl px-3 py-2"
                value={facadeInput}
                onChange={(e) => setFacadeInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && confirm()}
              />
            </div>
          </>
        ) : null}
        <div className={`text-sm flex-col gap-1 mb-4 ${facadeOnly ? 'hidden' : 'flex'}`}>
          <div className="flex justify-between">
            <span className="text-muted">{creditTarget ? '推算待还' : '推算余额'}</span>
            <span className="num">{fmtYuan(shown)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">{creditTarget ? '实际待还' : '实际余额'}</span>
            <span className="num">{real === null ? '—' : fmtYuan(real)}</span>
          </div>
          <div className="flex justify-between font-medium">
            <span className="text-muted">{creditTarget ? '校准（负数 = 欠得更多）' : '差额'}</span>
            <span className={`num ${delta === null ? '' : delta < 0 ? 'text-expense' : delta > 0 ? 'text-income' : ''}`}>
              {delta === null ? '—' : delta === 0 ? '无差异' : fmtYuan(delta, { sign: true })}
            </span>
          </div>
        </div>
        <button
          type="button"
          disabled={busy || (facadeOnly ? parseYuan(input) === null : delta === null)}
          className="w-full rounded-2xl bg-brand text-on-brand py-3 font-semibold disabled:opacity-40"
          onClick={confirm}
        >
          {facadeOnly ? '确认' : delta === 0 ? '无差异，直接关闭' : '生成校准记录'}
        </button>
      </Sheet>
    </div>
  )
}
