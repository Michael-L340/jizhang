// 记一笔（新增 / 编辑同一页）。目标：普通一笔 = 输金额 → 点大类 → 保存。
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AccountIcon } from '../components/AccountIcon'
import { ChipGroup } from '../components/ChipGroup'
import { DatePicker } from '../components/DatePicker'
import { Keypad } from '../components/Keypad'
import { childOrderByUse, installmentPlan, pickCategoryId, splitAccounts } from '../lib/compute'
import { fmtDateRel, nowIso, today } from '../lib/date'
import { loadLocal, saveLocal, useOnline } from '../lib/hooks'
import { newId } from '../lib/id'
import { fmtYuan, parseYuan } from '../lib/money'
import { useActiveAccounts, useStore } from '../lib/store'
import type { Account, Transaction, TxType } from '../types'

const MEM_KEY = 'jz_entry_memory_v1'
const NO_ACCOUNT = '__none__'
const CREDIT_GROUP = '__credit__'

/** 分期选项。'1' = 下个月一次还清；custom 时期数从输入框读 */
const INST_OPTS: { id: string; label: string }[] = [
  { id: '1', label: '一次还清' },
  { id: '3', label: '3 期' },
  { id: '6', label: '6 期' },
  { id: '12', label: '12 期' },
  { id: 'custom', label: '自定义' },
]
const INST_MAX = 60

interface Memory {
  type: 'expense' | 'income' | 'transfer'
  accountId: string | null
  parentId: string | null
  childByParent: Record<string, string>
  incomeCatId: string | null
  fromId: string | null
  toId: string | null
}

const DEFAULT_MEM: Memory = { type: 'expense', accountId: null, parentId: null, childByParent: {}, incomeCatId: null, fromId: null, toId: null }

function nextAmount(cur: string, key: string): string {
  if (key === '⌫') return cur.slice(0, -1)
  if (key === '.') return cur.includes('.') ? cur : cur === '' ? '0.' : cur + '.'
  const [int, dec] = cur.split('.')
  if (cur.includes('.')) return (dec ?? '').length + key.length <= 2 ? cur + key : cur
  if (key === '00') return int === '' || int === '0' ? cur : int.length + 2 <= 9 ? cur + key : cur
  if (int === '0') return key
  return int.length + 1 <= 9 ? cur + key : cur
}

/**
 * 账户胶囊分两级：第一排是资产账户 + 一个「白条」+（可选的）「不指定」，
 * 点「白条」才展开第二排四个平台。八个胶囊平铺要折三行，而且白条和真账户混在一起容易手滑。
 */
function AccountPicker({
  assets,
  credits,
  value,
  onChange,
  exclude,
  preferred,
  allowNone,
}: {
  assets: Account[]
  credits: Account[]
  value: string | null
  onChange: (id: string) => void
  /** 转账的「到」要排除「从」 */
  exclude?: string | null
  /** 点「白条」时优先选中的平台（上次用的） */
  preferred?: string | null
  allowNone?: boolean
}) {
  const onCredit = value !== null && credits.some((c) => c.id === value)
  const [open, setOpen] = useState(onCredit)
  useEffect(() => {
    if (onCredit) setOpen(true)
  }, [onCredit])
  const chip = (a: Account) => ({ id: a.id, label: a.name, node: <AccountIcon name={a.name} size={18} /> })
  const kids = credits.filter((c) => c.id !== exclude)
  const top = [
    ...assets.filter((a) => a.id !== exclude).map(chip),
    ...(kids.length ? [{ id: CREDIT_GROUP, label: '白条', node: <AccountIcon name="白条" size={18} /> }] : []),
    ...(allowNone ? [{ id: NO_ACCOUNT, label: '不指定' }] : []),
  ]
  return (
    <>
      <ChipGroup
        options={top}
        value={onCredit ? CREDIT_GROUP : value ?? NO_ACCOUNT}
        onChange={(id) => {
          if (id !== CREDIT_GROUP) {
            setOpen(false)
            onChange(id)
            return
          }
          setOpen(true)
          if (!onCredit) onChange(kids.find((c) => c.id === preferred)?.id ?? kids[0].id)
        }}
      />
      {open && kids.length ? <ChipGroup className="mt-2 pl-2.5 border-l-2 border-brand" options={kids.map(chip)} value={value ?? ''} onChange={onChange} /> : null}
    </>
  )
}

export function Entry() {
  const nav = useNavigate()
  const [params] = useSearchParams()
  const editId = params.get('id')

  const txs = useStore((s) => s.transactions)
  const cats = useStore((s) => s.categories)
  const accounts = useActiveAccounts()
  const { assets, credits } = useMemo(() => splitAccounts(accounts), [accounts])
  const addTx = useStore((s) => s.addTx)
  const editTx = useStore((s) => s.editTx)
  const removeTx = useStore((s) => s.removeTx)
  const addCategory = useStore((s) => s.addCategory)
  const showToast = useStore((s) => s.showToast)
  const online = useOnline()

  const editing = useMemo(() => (editId ? txs.find((t) => t.id === editId) ?? null : null), [txs, editId])
  const memRef = useRef<Memory>(loadLocal(MEM_KEY, DEFAULT_MEM))
  const mem = memRef.current

  const [type, setType] = useState<TxType>(mem.type)
  const [amount, setAmount] = useState('')
  const [neg, setNeg] = useState(false)
  // 分类每笔都从头选（用户 2026-09-06 定的折中：账户记着，分类不记）。
  // 记住上次分类省两下点击，但连着记两笔不同的时很容易忘了改，就把午饭记成了早餐。
  const [parentId, setParentId] = useState<string | null>(null)
  const [childId, setChildId] = useState<string | null>(null)
  const [incomeCatId, setIncomeCatId] = useState<string | null>(null)
  const [accountId, setAccountId] = useState<string | null>(mem.accountId === NO_ACCOUNT ? null : mem.accountId)
  const [accountTouched, setAccountTouched] = useState(mem.accountId === NO_ACCOUNT)
  const [fromId, setFromId] = useState<string | null>(mem.fromId)
  const [toId, setToId] = useState<string | null>(mem.toId)
  const [date, setDate] = useState(today())
  const [note, setNote] = useState('')
  // 白条分期：只在「支出 + 账户是白条」时出现并生效
  const [inst, setInst] = useState('1')
  const [customInst, setCustomInst] = useState('')
  const [more, setMore] = useState(false)
  // 选到白条后上面多了一排平台和一行分期，备注输入框会被挤到键盘下面，点开了也看不见。
  // 所以点「备注」时把它滚进视野并聚焦。
  //
  // 只在用户亲手点开时做，不能挂在 more 上：编辑一笔有备注的、或不是今天的记录时，
  // 回填也会把 more 设成 true，那样进编辑页就会自己滚一下、抢走光标。
  // 另外 iOS 只在用户手势里调 focus() 才会弹键盘，所以 focus 必须同步跟在 onClick 里，
  // 不能等 setTimeout。滚动可以等动画结束再做。
  const noteRef = useRef<HTMLInputElement>(null)
  function toggleNote() {
    const open = !more
    setMore(open)
    if (!open) return
    noteRef.current?.focus({ preventScroll: true })
    window.setTimeout(() => noteRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 200)
  }
  const [dateOpen, setDateOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const loadedEdit = useRef<string | null>(null)
  // 编辑态要等回填完成，默认值兜底才允许动账户。新增时（editId 为空）直接放行。
  // 必须是 state 不能是 ref：ref 在回填那一帧就被同步改掉，同一帧的兜底 effect
  // 立刻读到新值，门等于没设。
  const [backfilled, setBackfilled] = useState(!editId)
  // 用户有没有手动改过日期。没改过的，切回前台时要跟着滚到新的今天。
  const [dateTouched, setDateTouched] = useState(false)

  // 编辑态：把记录回填到表单（只做一次）
  useEffect(() => {
    if (!editing || loadedEdit.current === editing.id) return
    loadedEdit.current = editing.id
    setType(editing.type)
    setAmount(fmtYuan(Math.abs(editing.amount)).replace(/,/g, '').replace(/\.00$/, ''))
    setNeg(editing.amount < 0)
    setDate(editing.date)
    setNote(editing.note ?? '')
    setMore(Boolean(editing.note) || editing.date !== today())
    if (editing.installments) {
      const n = String(editing.installments)
      if (INST_OPTS.some((o) => o.id === n)) setInst(n)
      else {
        setInst('custom')
        setCustomInst(n)
      }
    }
    if (editing.type === 'transfer') {
      setFromId(editing.account_id)
      setToId(editing.to_account_id)
    } else {
      setAccountId(editing.account_id)
      setAccountTouched(true)
    }
    if (editing.category_id) {
      const c = cats.find((x) => x.id === editing.category_id)
      if (c?.kind === 'income') setIncomeCatId(c.id)
      else if (c) {
        setParentId(c.parent_id ?? c.id)
        setChildId(c.parent_id ? c.id : null)
      }
    }
    setBackfilled(true)
  }, [editing, cats])

  const parents = useMemo(() => cats.filter((c) => c.kind === 'expense' && !c.parent_id && !c.is_archived).sort((a, b) => a.sort - b.sort), [cats])
  const children = useMemo(() => (parentId ? childOrderByUse(txs, cats, parentId) : []), [txs, cats, parentId])
  const incomeCats = useMemo(() => cats.filter((c) => c.kind === 'income' && !c.parent_id && !c.is_archived).sort((a, b) => a.sort - b.sort), [cats])

  // 默认值兜底：账户 / 大类 / 二级 没有记忆时取第一个。
  //
  // 编辑态必须等回填完成再跑。这两个 effect 在同一次提交里先后执行，回填先
  // setAccountId(这笔真正的账户)，但兜底读到的是本次渲染的旧闭包值（accountId 仍为 null），
  // 于是又排一次 setAccountId(accounts[0].id) 并且排在后面赢——在一台没存过账的新设备上
  // （新手机、新电脑，或同一部 iPhone 的 Safari 与主屏 App 之间，两者存储是隔离的），
  // 打开一笔微信的支出会显示成中国银行，哪怕只改个备注点更新，这笔钱就被挪走了。
  useEffect(() => {
    if (!backfilled) return
    if (!accountId && !accountTouched && assets.length) setAccountId(assets[0].id)
    if (!fromId && assets.length) setFromId(assets[0].id)
    if (!toId && assets.length > 1) setToId(assets[1].id)
  }, [backfilled, assets, accountId, accountTouched, fromId, toId])

  // 挂起过夜后回到前台，把没被手动改过的日期滚到新的今天。
  //
  // 保存后页面不跳走，所以「记一笔」几乎总是退出 App 时停留的那一页；iOS 主屏 App 是
  // 挂起不是关闭，第二天点图标回来 date 还是昨天，当天第一笔就记进了昨天。
  // 编辑态绝不能动：那里的日期是记录本身的日期，不是「今天」——切出去看眼微信再回来
  // 就把上周那条记录改成今天，比原来的问题严重得多。
  useEffect(() => {
    if (editId) return
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || dateTouched) return
      const t = today()
      setDate((d) => (d === t ? d : t))
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [editId, dateTouched])
  // 分类兜底：判断全在 compute.ts 的 pickCategoryId 里（纯函数，有单测覆盖）。
  // 以前这三处各写各的：大类和收入只判断「值为空」，二级才判断「值还在不在列表里」，
  // 于是归档掉一个大类之后，按钮一个都不高亮、下面还挂着它的二级、点保存照样存得进去。
  //
  // editing 传的是「有没有 ?id=」而不是 editing 这条记录本身：一进编辑态就立刻封死，
  // 不等记录找出来，也就不存在「回填前先被兜底改一次」的窗口（账户那条 backfilled
  // 门挡的正是这种时序）。编辑一条用了已归档分类的旧账，分类必须原样留着。
  const isEdit = Boolean(editId)
  useEffect(() => {
    const next = pickCategoryId({ options: parents, current: parentId, editing: isEdit })
    if (next !== parentId) setParentId(next)
  }, [parents, parentId, isEdit])
  useEffect(() => {
    const next = pickCategoryId({ options: incomeCats, current: incomeCatId, editing: isEdit })
    if (next !== incomeCatId) setIncomeCatId(next)
  }, [incomeCats, incomeCatId, isEdit])
  useEffect(() => {
    const next = pickCategoryId({ options: children, current: childId, editing: isEdit })
    if (next !== childId) setChildId(next)
  }, [parentId, children, childId, isEdit])

  function pickParent(id: string) {
    if (id === parentId) return // 再点一次已选中的大类不该把二级重置掉
    setParentId(id)
    setAdding(false)
    setChildId(null) // 二级也要自己点：这一步正是「别把午饭记成早餐」的关键
  }

  async function submitNewCategory() {
    const name = newName.trim()
    if (!name) {
      setAdding(false)
      return
    }
    const created = type === 'income' ? await addCategory('income', null, name) : parentId ? await addCategory('expense', parentId, name) : null
    if (created) {
      if (type === 'income') setIncomeCatId(created.id)
      else setChildId(created.id)
    }
    setNewName('')
    setAdding(false)
  }

  const cents = (parseYuan(amount) ?? 0) * (neg ? -1 : 1)
  const onCredit = type === 'expense' && accountId !== null && credits.some((c) => c.id === accountId)
  const instN = inst === 'custom' ? Number(customInst) : Number(inst)
  const instOk = Number.isInteger(instN) && instN >= 1 && instN <= INST_MAX
  // 分期提示：每期多少、哪几个月。用一笔临时记录算，和保存后账户页看到的完全一致
  // 到期日按这个白条自己的还款日算（京东 17、花呗和美团 1），所以预览要先找到账户
  const creditAcc = accountId ? (credits.find((c) => c.id === accountId) ?? null) : null
  const plan = onCredit && cents > 0 && instOk ? installmentPlan({ date, amount: cents, installments: instN }, creditAcc?.repay_day ?? null) : null

  function validate(): string | null {
    if (type !== 'adjust' && cents <= 0) return '请输入金额'
    if (type === 'expense' && !parentId) return '请选择用途'

    if (type === 'expense' && children.length > 0 && !childId) return '请选择二级分类'
    if (type === 'income' && !incomeCatId) return '请选择收入分类'
    if (type === 'transfer' && (!fromId || !toId)) return '请选择账户'
    if (type === 'transfer' && fromId === toId) return '转出和转入账户不能相同'
    if (onCredit && !instOk) return `分期期数要是 1 到 ${INST_MAX} 的整数`
    return null
  }

  async function save() {
    // 编辑期间这条被另一台设备删了：editing 会变 null，再保存就会生成新 id
    // 插入一条重复记录。必须挡住并告知，不能静默改变语义。
    if (editId && !editing) {
      showToast('这条记录已被删除')
      nav(-1)
      return
    }
    const err = validate()
    if (err) {
      showToast(err)
      return
    }
    if (!online) {
      showToast('当前离线，暂不能记账')
      return
    }
    setBusy(true)
    const tx: Transaction = {
      id: editing?.id ?? newId(),
      date,
      type,
      amount: type === 'adjust' ? cents : Math.abs(cents),
      account_id: type === 'transfer' ? (fromId as string) : accountId,
      to_account_id: type === 'transfer' ? toId : null,
      category_id: type === 'expense' ? childId ?? parentId : type === 'income' ? incomeCatId : null,
      note: note.trim() || null,
      installments: onCredit ? instN : null,
      settles: null,
      created_at: editing?.created_at ?? nowIso(),
    }
    const ok = editing ? await editTx(tx) : await addTx(tx)
    setBusy(false)
    if (!ok) return

    if (type !== 'adjust') {
      const m: Memory = {
        type,
        accountId: accountId ?? NO_ACCOUNT,
        parentId: null,
        // 分类不再进记忆（折中方案），字段留着是为了旧数据能读进来不报错
        childByParent: {},
        incomeCatId: null,
        fromId,
        toId,
      }
      memRef.current = m
      saveLocal(MEM_KEY, m)
    }

    if (editing) {
      showToast('已更新')
      nav(-1)
      return
    }
    const catName =
      type === 'expense'
        ? [parents.find((p) => p.id === parentId)?.name, children.find((c) => c.id === childId)?.name].filter(Boolean).join('/')
        : type === 'income'
          ? incomeCats.find((c) => c.id === incomeCatId)?.name ?? ''
          : '转账'
    const accName = accounts.find((a) => a.id === (type === 'transfer' ? fromId : accountId))?.name ?? '未指定账户'
    showToast(`已记 ¥${fmtYuan(Math.abs(cents))} · ${catName} · ${accName}`, async () => {
      const removed = await removeTx(tx.id)
      if (removed) showToast(`已撤销 ¥${fmtYuan(Math.abs(cents))} · ${catName}`)
    })
    setAmount('')
    setNote('')
    setDate(today())
    setDateTouched(false) // 不复位的话，记过一笔昨天的账之后这页就永久停止跟随日期了
    setInst('1') // 期数也复位：上一笔分 12 期，下一笔 30 元外卖不该跟着摊成 12 个月
    setCustomInst('')
    setMore(false)
  }

  async function del() {
    if (!editing || !window.confirm('删除这条记录？')) return
    const ok = await removeTx(editing.id)
    if (ok) {
      showToast('已删除')
      nav(-1)
    }
  }

  const typeOptions: { id: TxType; label: string }[] = [
    { id: 'expense', label: '支出' },
    { id: 'income', label: '收入' },
    { id: 'transfer', label: '转账' },
    ...(editing?.type === 'adjust' ? [{ id: 'adjust' as TxType, label: '校准' }] : []),
  ]
  const amountColor = type === 'expense' ? 'text-expense' : type === 'income' ? 'text-income' : type === 'transfer' ? 'text-transfer' : 'text-adjust'

  return (
    <div className="flex-1 min-h-0 flex flex-col safe-top">
      <div className="flex items-center justify-between px-2 h-12">
        <button type="button" className="px-3 py-2 text-brand-ink" onClick={() => nav(-1)}>
          {editing ? '返回' : '取消'}
        </button>
        <span className="font-semibold">{editing ? '编辑' : '记一笔'}</span>
        {editing ? (
          <button type="button" className="px-3 py-2 text-expense" onClick={del}>
            删除
          </button>
        ) : (
          <span className="w-14" />
        )}
      </div>

      <div className="app-main px-4">
        <div className="flex justify-center mb-3">
          <div className="inline-flex rounded-full bg-card border border-line p-0.5">
            {typeOptions.map((o) => (
              <button
                key={o.id}
                type="button"
                className={`px-4 py-1.5 rounded-full text-sm ${type === o.id ? 'bg-ink text-white' : 'text-muted'}`}
                onClick={() => {
                  setType(o.id)
                  setAdding(false)
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-end justify-end gap-2 py-3 min-h-16">
          {type === 'adjust' ? (
            <button type="button" className="chip" onClick={() => setNeg(!neg)}>
              {neg ? '−' : '+'}
            </button>
          ) : null}
          {/* 没输入时整个数字是灰的（占位），一输入就变成这一类型的颜色。
              原来是「0 用类型色 + .00 用灰色」，看起来像一个数字被涂了两种颜色。 */}
          <span className={`num text-4xl font-semibold ${amount === '' ? 'text-muted' : amountColor}`}>
            <span className="text-2xl mr-1">¥</span>
            {neg ? '-' : ''}
            {amount || '0.00'}
          </span>
        </div>

        {!online ? <div className="text-xs text-expense text-center mb-2">当前离线，暂不能记账</div> : null}

        {type === 'expense' ? (
          <>
            <ChipGroup options={parents.map((p) => ({ id: p.id, label: p.name, icon: p.icon }))} value={parentId} onChange={pickParent} className="mb-2" />
            <div className="rounded-xl bg-card border border-line p-2 mb-3">
              <ChipGroup
                options={children.map((c) => ({ id: c.id, label: c.name }))}
                value={childId}
                onChange={(id) => {
                  setChildId(id)
                  setAdding(false)
                }}
                extra={<AddChip adding={adding} value={newName} onChange={setNewName} onOpen={() => setAdding(true)} onSubmit={submitNewCategory} onCancel={() => setAdding(false)} />}
              />
            </div>
          </>
        ) : null}

        {type === 'income' ? (
          <div className="rounded-xl bg-card border border-line p-2 mb-3">
            <ChipGroup
              options={incomeCats.map((c) => ({ id: c.id, label: c.name }))}
              value={incomeCatId}
              onChange={(id) => {
                setIncomeCatId(id)
                setAdding(false)
              }}
              extra={<AddChip adding={adding} value={newName} onChange={setNewName} onOpen={() => setAdding(true)} onSubmit={submitNewCategory} onCancel={() => setAdding(false)} />}
            />
          </div>
        ) : null}

        {type === 'transfer' ? (
          <div className="mb-3">
            <div className="text-xs text-muted mb-1">从</div>
            <div className="mb-2">
              <AccountPicker assets={assets} credits={credits} value={fromId} onChange={setFromId} />
            </div>
            <div className="text-xs text-muted mb-1">到</div>
            <AccountPicker assets={assets} credits={credits} value={toId} onChange={setToId} exclude={fromId} preferred={mem.toId} />
          </div>
        ) : (
          <div className="mb-3">
            <div className="text-xs text-muted mb-1">账户</div>
            <AccountPicker
              assets={assets}
              credits={credits}
              value={accountId}
              allowNone
              preferred={mem.accountId}
              onChange={(id) => {
                setAccountTouched(true)
                setAccountId(id === NO_ACCOUNT ? null : id)
              }}
            />
            {onCredit ? (
              <div className="mt-3">
                {/* 到期日由账户的还款日决定，不再是写死的「下个月」：京东 17 号的话
                    9/6 下单就是 9/17 到期。所以这行提示要跟着账户变。 */}
                <div className="text-xs text-muted mb-1">
                  分期{creditAcc?.repay_day ? ` · ${creditAcc.name}每月 ${creditAcc.repay_day} 号还款` : ' · 先用后付，确认收货后几天扣'}
                </div>
                <ChipGroup options={INST_OPTS} value={inst} onChange={setInst} />
                {inst === 'custom' ? (
                  <input
                    inputMode="numeric"
                    autoFocus
                    className="mt-2 w-28 bg-bg rounded-xl px-3 py-2 text-sm num"
                    placeholder={`期数 2–${INST_MAX}`}
                    value={customInst}
                    onChange={(e) => setCustomInst(e.target.value.replace(/\D/g, ''))}
                  />
                ) : null}
                {plan ? (
                  <div className="text-[11px] text-muted mt-1.5 num">
                    每期 ¥{fmtYuan(plan[0].amount)}
                    {plan.length > 1 && plan[plan.length - 1].amount !== plan[0].amount ? `，最后一期 ¥${fmtYuan(plan[plan.length - 1].amount)}` : ''}
                    {' · '}
                    {plan.length <= 3
                      ? plan.map((x) => `${Number(x.date.slice(5, 7))}/${Number(x.date.slice(8))} 到期`).join('、')
                      : `${Number(plan[0].date.slice(5, 7))}/${Number(plan[0].date.slice(8))} 起，到 ${plan[plan.length - 1].ym.replace('-', ' 年 ')} 月`}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}

        <div className="flex items-center gap-2 text-sm mb-2">
          <button type="button" className={`chip ${date !== today() ? 'on' : ''}`} onClick={() => setDateOpen(true)}>
            {fmtDateRel(date)}
          </button>
          <button type="button" className={`chip flex-1 text-left truncate ${note ? '' : 'text-muted'}`} onClick={toggleNote}>
            {note || '备注（可不填）'}
          </button>
        </div>
        <div className={`expand ${more ? 'open' : ''}`}>
          <div>
            <input ref={noteRef} className="w-full rounded-xl bg-card border border-line px-3 py-2 mb-3" placeholder="备注（可不填）" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        <DatePicker
          open={dateOpen}
          value={date}
          onPick={(d) => {
            setDateTouched(true)
            setDate(d)
          }}
          onClose={() => setDateOpen(false)}
        />
      </div>

      <Keypad onInput={(k) => setAmount((a) => nextAmount(a, k))} onSave={save} saveLabel={editing ? '更新' : '保存'} disabled={busy || !online} />
    </div>
  )
}

function AddChip(props: { adding: boolean; value: string; onChange: (v: string) => void; onOpen: () => void; onSubmit: () => void; onCancel: () => void }) {
  if (!props.adding) {
    return (
      <button type="button" className="chip border-dashed text-muted" onClick={props.onOpen}>
        ＋ 新增
      </button>
    )
  }
  return (
    <span className="inline-flex items-center gap-1">
      <input
        autoFocus
        className="chip w-28"
        placeholder="分类名"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') props.onSubmit()
          if (e.key === 'Escape') props.onCancel()
        }}
      />
      <button type="button" className="chip on" onClick={props.onSubmit}>
        确定
      </button>
      <button type="button" className="chip" onClick={props.onCancel}>
        取消
      </button>
    </span>
  )
}
