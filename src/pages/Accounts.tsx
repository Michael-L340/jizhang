import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AccountIcon, accountColor } from '../components/AccountIcon'
import { CatIcon } from '../components/CatIcon'
import { ChipGroup } from '../components/ChipGroup'
import { HelpTip } from '../components/HelpTip'
import { Sheet } from '../components/Sheet'
import { balances, balanceShares, creditBill, currentDueDate, debtOf, dueNow, groupByDue, monthByAccount, previewRepay, splitAccounts } from '../lib/compute'
import type { BillRow, CreditBill } from '../lib/compute'
import { daysBetween, fmtDateZh, fmtIsoZh, monthOf, nowIso, today } from '../lib/date'
import { facadeDelta, hiddenSummary, lastAdjustAt, latestFacadeAdjust, outerBook, outerList } from '../lib/facade'
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
  const syncError = useStore((s) => s.syncError)
  const syncRetrying = useStore((s) => s.syncRetrying)
  const mode = useStore((s) => s.mode)
  const fadj = useStore((s) => s.facade_adjusts)
  const addFacadeAdjust = useStore((s) => s.addFacadeAdjust)
  const updateAccount = useStore((s) => s.updateAccount)
  const syncing = useStore((s) => s.syncing)
  const refresh = useStore((s) => s.refresh)
  const outboxCount = useStore((s) => s.outboxCount)
  const accounts = useActiveAccounts()
  const catMap = useCategoryMap()
  const { assets, credits } = useMemo(() => splitAccounts(accounts), [accounts])
  // 当前模式那本账：里页面是原始流水（真实余额），外页面是 outerBook（藏掉的不算、真实校准不算、外页面校准记录算）。
  // 这一页所有算钱的地方只准吃它；白条那一套照旧吃原始 txs（白条不参与里外，两本账里它的数一样）
  const otxs = useMemo(() => outerBook(txs, accounts, fadj, mode), [txs, accounts, fadj, mode])
  const bal = useMemo(() => balances(otxs, accounts), [otxs, accounts])
  // 外页面那本账的余额，两种模式都算一份：里页面校准弹层的「对外显示」要预填外页面现在显示的数，
  // 写外页面校准记录时差额也按它算（facade.test.ts 有源码守卫）
  const outerBal = useMemo(() => balances(outerBook(txs, accounts, fadj, 'outer'), accounts), [txs, accounts, fadj])
  // 卡片右下的「本月 ±」走外页面的列表口径（校准行外页面看不见）。副标题的「上次校准」不走它，见 lastAdjustAt 的注释
  const vtxs = useMemo(() => outerList(txs, accounts, mode), [txs, accounts, mode])
  // 不用 totalOf(bal) + debt：debt 只加回负余额，某个白条多还成正数时那笔会留在合计里，
  // 而下面的卡片列表里没有它，两个数就对不上（首页同样的理由，同样的算法）
  const assetTotal = useMemo(() => assets.reduce((s, a) => s + (bal[a.id] ?? 0), 0), [assets, bal])
  // 里页面校准弹层那行「外页面上次校准 9/27」：外页面校准记录哪里都不列（用户 2026-09-27 定），只在这里露最近一条给本人核对
  const lastFacade = useMemo(() => latestFacadeAdjust(fadj), [fadj])
  // 原来在 accounts.map() 内部对全量流水扫描，而输入框每次按键都会重渲染整页。
  // 用原始 txs 不用 vtxs：外页面下四个账户的副标题必须长一样（facade.test.ts 守着）
  const lastAdjusts = useMemo(() => lastAdjustAt(txs), [txs])
  // 里页面校准弹层里那行「外面看不到的 n 笔」。纯展示，不参与任何计算（用户 2026-09-18 要的就是「告诉我一下」）
  const hiddenSum = useMemo(() => hiddenSummary(txs, accounts), [txs, accounts])
  const [target, setTarget] = useState<Account | null>(null)
  const [input, setInput] = useState('')
  // 里页面第二个框：这个账户在外页面显示多少
  const [facadeInput, setFacadeInput] = useState('')
  // 真实校准那一行的备注（用户 2026-09-27 要的）。空着就是「余额校准」
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  // 里外一切换就关掉校准弹层：在里页面开着弹层切去银行 App 查余额，60 秒后自动退回外页面，
  // 弹层还开着、框里预填的还是真实余额，这时点确认会把真实余额写成外页面校准（2026-10-09 审出来的）
  useEffect(() => {
    setTarget(null)
  }, [mode])

  // 白条：余额为负是欠款。核对时让用户输「待还」（正数），差额再翻回余额的方向。
  const creditTarget = target ? credits.some((c) => c.id === target.id) : false
  // 外页面点开非白条账户时，这个框改的是「外面显示多少」：只记一条外页面校准记录、不写任何流水。
  // 白条不分里外，所以在外页面点白条走的还是真正的校准。
  const facadeOnly = mode === 'outer' && Boolean(target) && !creditTarget
  // 里页面的非白条账户才有第二个框
  const showFacadeField = mode === 'inner' && Boolean(target) && !creditTarget
  // bal 已经是当前模式该显示的数：里页面是真实余额，外页面是外页面那本账
  const computed = target ? bal[target.id] ?? 0 : 0
  const lf = target ? lastFacade.get(target.id) : undefined
  const shown = creditTarget ? -computed : computed
  const real = parseYuan(input)
  const rawDelta = calcDelta(input, shown) // 算式本体在 lib/money.ts，那里测得到
  const delta = rawDelta === null ? null : creditTarget ? -rawDelta : rawDelta

  function open(a: Account) {
    setTarget(a)
    const isCred = credits.some((c) => c.id === a.id)
    // 预填屏幕上那个数：外页面就是外页面那本账的数，里页面是真实余额；白条按「待还」翻个方向
    const cur = bal[a.id] ?? 0
    setInput(fmtYuan(isCred ? -cur : cur).replace(/,/g, ''))
    setFacadeInput(fmtYuan(outerBal[a.id] ?? 0).replace(/,/g, ''))
    setNote('')
  }

  /**
   * 里页面改「实际余额」时，「对外显示」跟着同幅变动：你看到的直接是最终结果，不用心算。
   * 想单独定外面那个数就直接改下面那个框。差额按外页面现在显示的数算（outerBal），
   * 不按真实余额算——真实校准外页面看不见，两本账各走各的。
   */
  function onRealInput(v: string) {
    setInput(v)
    if (!target || creditTarget || mode !== 'inner') return
    const r = parseYuan(v)
    if (r !== null) setFacadeInput(fmtYuan((outerBal[target.id] ?? 0) + (r - (bal[target.id] ?? 0))).replace(/,/g, ''))
  }

  /** 「对外显示」填的数和外页面现在显示的数不一样，才需要写一条外页面校准 */
  function facadeChanged(a: Account): boolean {
    if (creditTarget) return false
    const want = parseYuan(facadeOnly ? input : facadeInput)
    return want !== null && facadeDelta(want, outerBal[a.id] ?? 0) !== 0
  }

  /**
   * 把「对外显示多少」写成一条外页面校准记录：记在今天，差额 = 填的 − 外页面现在显示的数。
   * 从今天起外页面就是填的那个数，以前的曲线不动（2026-09-27 起；以前是改固定差值、整条曲线上下移）。
   * 没差额就不写；白条不参与里外。
   */
  async function saveFacade(a: Account): Promise<boolean> {
    if (!facadeChanged(a)) return true
    const want = parseYuan(facadeOnly ? input : facadeInput)!
    // 键的顺序和 api.ts 的 rowToFa 一致，导出的 JSON 才和备份脚本抓的逐字节对得上
    return await addFacadeAdjust({ id: newId(), account_id: a.id, date: today(), cents: facadeDelta(want, outerBal[a.id] ?? 0), created_at: nowIso() })
  }

  async function confirm() {
    // 备注框按两次回车会提交两次（按钮禁了、confirm 自己没看 busy），第二次会再写一条外页面校准
    if (busy) return
    if (!target) return
    // 外页面：不写流水，只记一条外页面校准（改这个账户在外面显示多少）
    if (facadeOnly) {
      if (parseYuan(input) === null) return
      setBusy(true)
      const ok = await saveFacade(target)
      setBusy(false)
      if (ok) setTarget(null)
      return
    }
    if (delta === null) return
    // 没差额就不留痕：以前会写一条 0 元「余额核对」，只是为了同步「上次核对时间」，
    // 结果流水里全是 0 元行，用户嫌碍眼。核对本身不产生数据。
    if (delta === 0) {
      const changed = facadeChanged(target)
      setBusy(true)
      const ok = await saveFacade(target)
      setBusy(false)
      if (!ok) return
      showToast(changed ? `${target.name} 真实余额无差异，对外显示已改` : `${target.name} 核对无差异，没有产生记录`)
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
      note: note.trim() || '余额校准',
      installments: null,
      settles: null,
      hidden: null, is_offset: null,
      created_at: nowIso(),
    })
    // 真实校准外页面看不见，所以「对外显示」那一条按外页面现在显示的数算差额，和上面那笔无关；
    // 默认预填的是「跟着同幅变」的结果，所以不特意改它的话，外页面今天也跟着一个同样的台阶
    const fok = ok ? await saveFacade(target) : true
    setBusy(false)
    if (ok) {
      // 真实校准已经落了（没网也进了待传队列），弹层必须关——留着再点一次会再记一笔。
      // 外页面那条没写成时要说清楚是哪一半没成，不能让 store 那句「校准失败」盖住「其实已校准」
      showToast(fok ? `${target.name} 已校准 ${fmtYuan(delta, { sign: true })}` : `${target.name} 已校准 ${fmtYuan(delta, { sign: true })}，但对外显示没改成，稍后在这里再改一次`)
      setTarget(null)
    }
  }

  const ym = monthOf(today())
  const byAcc = useMemo(() => monthByAccount(vtxs, ym), [vtxs, ym])
  const nameOf = (id: string): string => accounts.find((a) => a.id === id)?.name ?? ''
  // 占比条跟着屏幕上的数字走，否则外页面「各占多少」和四张卡对不上
  const shares = useMemo(() => balanceShares(bal, assets.map((a) => a.id)), [bal, assets])

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
    // 按未还部分算，不按整期：已经被往前顶还掉的那部分不能再还一遍
    return billRows.reduce((sum, r) => sum + (ids.has(keyOf(r)) ? Math.max(0, r.due.amount - r.paid) : 0), 0)
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
    // 只勾还没还完的行，金额预填「还差多少」（b.left），不是整期金额：已经还掉的不能再还一遍
    setPicked(new Set(b.rows.filter((r) => r.paid < r.due.amount).map((r) => `${r.tx.id}#${r.due.seq}`)))
    setRepayInput(b.left > 0 ? yuanStr(b.left) : '')
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
      hidden: null, is_offset: null,
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

  /**
   * 按到期日切段渲染。分期多了之后 11/1 和 12/1 的行会混在一起看不出断点，
   * 所以每个到期日单独一段，段头写日期 + 这一期合计；点段头整组勾选，
   * 「提前还一期」一下就选好了（用户 2026-09-08 提的）。
   * 只有一个日期时不画段头——一条横线加个标题反而更碎。
   */
  function billSection(rows: BillRow[]) {
    const groups = groupByDue(rows)
    if (groups.length <= 1) return rows.map(billLine)
    return groups.map((g) => {
      const keys = g.rows.map(keyOf)
      const allOn = keys.every((k) => picked.has(k))
      return (
        <div key={g.date} className="mt-1.5 first:mt-0">
          <button
            type="button"
            className="w-full flex items-baseline justify-between px-1 py-1 text-[11px]"
            onClick={() => {
              const next = new Set(picked)
              for (const k of keys) allOn ? next.delete(k) : next.add(k)
              setPicked(next)
              setRepayInput(yuanStr(pickSum(next)))
            }}
          >
            <span className={allOn ? 'text-brand-ink font-medium' : 'text-muted'}>
              {mmdd(g.date)} 到期 · {g.rows.length} 笔
            </span>
            <span className={`num ${allOn ? 'text-brand-ink font-medium' : 'text-muted'}`}>{fmtYuan(g.total, { symbol: true })}</span>
          </button>
          <div className="border-t border-line">{g.rows.map(billLine)}</div>
        </div>
      )
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
        <span className={`text-xl w-7 shrink-0 flex items-center justify-center ${ahead ? 'opacity-60' : ''}`}>
          <CatIcon icon={icon} size={24} />
        </span>
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
            {syncFailed ? (syncRetrying ? ' · 连接不上，正在自动重试' : ` · 同步失败${syncError ? `：${syncError}` : ''}`) : ''}
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
                <span className={`block num text-lg font-semibold ${(bal[a.id] ?? 0) < 0 ? 'text-expense' : ''}`}>{fmtYuan(bal[a.id] ?? 0)}</span>
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

      <div className="flex justify-end mt-3 pr-1">
        <HelpTip title="账户和白条">
          <p>点账户输入实际余额：一致就什么都不记；不一致时差额记成一条「余额校准」，不计入收入支出，随时可以删掉。</p>
          {credits.length ? <p>白条：下单记支出（账户选白条、填分几期），到期日按还款日算；平台扣款时点开白条勾上还的是哪几笔再记还款，记成转账。</p> : null}
        </HelpTip>
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
                <div className="mb-3">{billSection(bill.rows)}</div>
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
                    <div className="mb-3">{billSection(bill.upcoming)}</div>
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
            <div className="text-[11px] text-muted mb-3">金额跟着勾选变，可以改。</div>
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
            {/* 京东那条规矩的开关。只对有还款日的账户有意义——先用后付没有「周期」这回事。
                规则有个已知边界（逾期还款之后同周期再下单会多顺延一期），所以得能自己关掉，
                不用等我改代码。还款日本身没有界面，是直接在库里设的，这个开关比它更需要 */}
            {creditTarget2.repay_day !== null ? (
              <button
                type="button"
                disabled={busy}
                className="w-full flex items-start gap-3 text-left mt-4 pt-3 border-t border-line disabled:opacity-40"
                onClick={async () => {
                  const a = creditTarget2
                  const next = !a.defer_after_repay
                  setBusy(true)
                  const ok = await updateAccount(a.id, { defer_after_repay: next })
                  setBusy(false)
                  if (ok) {
                    setCreditTarget2({ ...a, defer_after_repay: next })
                    showToast(next ? `${a.name}：本期还过款之后下的单算下一期` : `${a.name}：改回按下单日算最近的还款日`)
                  }
                }}
              >
                <span className="flex-1 min-w-0">
                  <span className="block text-sm">本期还过款之后下的单，算下一期</span>
                  <span className="block text-[11px] text-muted mt-0.5">京东是这样，花呗、美团多半不是。只认这里记的还款。</span>
                </span>
                <span
                  className={`w-11 h-6 rounded-full shrink-0 mt-0.5 flex items-center px-0.5 transition-colors ${creditTarget2.defer_after_repay ? 'bg-brand justify-end' : 'bg-line justify-start'}`}
                >
                  <span className="w-5 h-5 rounded-full bg-card shadow-sm" />
                </span>
              </button>
            ) : null}
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
            {target && hiddenSum[target.id] ? (
              // 只在里页面（这个框本身只有里页面有）、只在藏过记录的账户出现。纯展示，上面「对外显示」那格不看它
              <div className="-mt-1 mb-3 flex items-center justify-between rounded-xl bg-brand-soft px-3 py-2 text-xs text-brand-ink">
                <span>隐藏金额汇总 · {hiddenSum[target.id].count} 笔</span>
                <span className="num font-medium">{fmtYuan(hiddenSum[target.id].cents, { sign: true })}</span>
              </div>
            ) : null}
            {lf ? (
              // 外页面校准记录哪里都不列，只在这里露最近一条（日期 + 差额）给本人核对；迁移出来的那条不算
              <div className="-mt-1 mb-3 flex items-center justify-between px-1 text-xs text-muted">
                <span>外页面上次校准 {fmtDateZh(lf.date, false)}</span>
                <span className="num">{fmtYuan(lf.cents, { sign: true })}</span>
              </div>
            ) : null}
          </>
        ) : null}
        {!facadeOnly ? (
          // 真实校准那一行的备注。外页面只有白条会走到这里（白条不分里外，是真校准），一个备注框不算露馅
          <input
            className="w-full mb-3 bg-bg rounded-xl px-3 py-2 text-sm"
            placeholder="备注（选填，默认「余额校准」）"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && confirm()}
          />
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
