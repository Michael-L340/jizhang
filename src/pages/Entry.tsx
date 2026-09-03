// 记一笔（新增 / 编辑同一页）。目标：普通一笔 = 输金额 → 点大类 → 保存。
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ChipGroup } from '../components/ChipGroup'
import { Keypad } from '../components/Keypad'
import { recentChildOrder } from '../lib/compute'
import { addDays, fmtDateRel, nowIso, today } from '../lib/date'
import { loadLocal, saveLocal, useOnline } from '../lib/hooks'
import { newId } from '../lib/id'
import { fmtYuan, parseYuan } from '../lib/money'
import { useActiveAccounts, useStore } from '../lib/store'
import type { Transaction, TxType } from '../types'

const MEM_KEY = 'jz_entry_memory_v1'

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

export function Entry() {
  const nav = useNavigate()
  const [params] = useSearchParams()
  const editId = params.get('id')

  const txs = useStore((s) => s.transactions)
  const cats = useStore((s) => s.categories)
  const accounts = useActiveAccounts()
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
  const [parentId, setParentId] = useState<string | null>(mem.parentId)
  const [childId, setChildId] = useState<string | null>(mem.parentId ? mem.childByParent[mem.parentId] ?? null : null)
  const [incomeCatId, setIncomeCatId] = useState<string | null>(mem.incomeCatId)
  const [accountId, setAccountId] = useState<string | null>(mem.accountId)
  const [fromId, setFromId] = useState<string | null>(mem.fromId)
  const [toId, setToId] = useState<string | null>(mem.toId)
  const [date, setDate] = useState(today())
  const [note, setNote] = useState('')
  const [more, setMore] = useState(false)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const loadedEdit = useRef<string | null>(null)

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
    if (editing.type === 'transfer') {
      setFromId(editing.account_id)
      setToId(editing.to_account_id)
    } else {
      setAccountId(editing.account_id)
    }
    if (editing.category_id) {
      const c = cats.find((x) => x.id === editing.category_id)
      if (c?.kind === 'income') setIncomeCatId(c.id)
      else if (c) {
        setParentId(c.parent_id ?? c.id)
        setChildId(c.parent_id ? c.id : null)
      }
    }
  }, [editing, cats])

  const parents = useMemo(() => cats.filter((c) => c.kind === 'expense' && !c.parent_id && !c.is_archived).sort((a, b) => a.sort - b.sort), [cats])
  const children = useMemo(() => (parentId ? recentChildOrder(txs, cats, parentId) : []), [txs, cats, parentId])
  const incomeCats = useMemo(() => cats.filter((c) => c.kind === 'income' && !c.parent_id && !c.is_archived).sort((a, b) => a.sort - b.sort), [cats])

  // 默认值兜底：账户 / 大类 / 二级 没有记忆时取第一个
  useEffect(() => {
    if (!accountId && accounts.length) setAccountId(accounts[0].id)
    if (!fromId && accounts.length) setFromId(accounts[0].id)
    if (!toId && accounts.length > 1) setToId(accounts[1].id)
  }, [accounts, accountId, fromId, toId])
  useEffect(() => {
    if (!parentId && parents.length) setParentId(parents[0].id)
  }, [parents, parentId])
  useEffect(() => {
    if (!incomeCatId && incomeCats.length) setIncomeCatId(incomeCats[0].id)
  }, [incomeCats, incomeCatId])
  useEffect(() => {
    if (!parentId) return
    if (childId && children.some((c) => c.id === childId)) return
    const remembered = mem.childByParent[parentId]
    if (remembered && children.some((c) => c.id === remembered)) setChildId(remembered)
    else setChildId(children[0]?.id ?? null)
  }, [parentId, children, childId, mem])

  function pickParent(id: string) {
    setParentId(id)
    setAdding(false)
    const remembered = mem.childByParent[id]
    const kids = recentChildOrder(txs, cats, id)
    setChildId(remembered && kids.some((c) => c.id === remembered) ? remembered : kids[0]?.id ?? null)
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

  function validate(): string | null {
    if (type !== 'adjust' && cents <= 0) return '请输入金额'
    if (type === 'expense' && !parentId) return '请选择用途'
    if (type === 'expense' && children.length > 0 && !childId) return '请选择二级分类'
    if (type === 'income' && !incomeCatId) return '请选择收入分类'
    if (type === 'transfer' && (!fromId || !toId)) return '请选择账户'
    if (type === 'transfer' && fromId === toId) return '转出和转入账户不能相同'
    if (type !== 'transfer' && !accountId) return '请选择账户'
    return null
  }

  async function save() {
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
      account_id: (type === 'transfer' ? fromId : accountId) as string,
      to_account_id: type === 'transfer' ? toId : null,
      category_id: type === 'expense' ? childId ?? parentId : type === 'income' ? incomeCatId : null,
      note: note.trim() || null,
      created_at: editing?.created_at ?? nowIso(),
    }
    const ok = editing ? await editTx(tx) : await addTx(tx)
    setBusy(false)
    if (!ok) return

    if (type !== 'adjust') {
      const m: Memory = {
        type,
        accountId,
        parentId,
        childByParent: { ...mem.childByParent, ...(parentId && childId ? { [parentId]: childId } : {}) },
        incomeCatId,
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
    const accName = accounts.find((a) => a.id === (type === 'transfer' ? fromId : accountId))?.name ?? ''
    showToast(`已记 ¥${fmtYuan(Math.abs(cents))} · ${catName} · ${accName}`, () => void removeTx(tx.id))
    setAmount('')
    setNote('')
    setDate(today())
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
  const accountOpts = accounts.map((a) => ({ id: a.id, label: a.name }))

  return (
    <div className="app-shell safe-top">
      <div className="flex items-center justify-between px-2 h-12">
        <button type="button" className="px-3 py-2 text-brand" onClick={() => nav(-1)}>
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
          <span className={`num text-4xl font-semibold ${amountColor}`}>
            <span className="text-2xl mr-1">¥</span>
            {neg ? '-' : ''}
            {amount || '0'}
            {amount === '' ? <span className="text-muted">.00</span> : null}
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
            <ChipGroup options={accountOpts} value={fromId} onChange={setFromId} className="mb-2" />
            <div className="text-xs text-muted mb-1">到</div>
            <ChipGroup options={accountOpts.filter((a) => a.id !== fromId)} value={toId} onChange={setToId} />
          </div>
        ) : (
          <div className="mb-3">
            <div className="text-xs text-muted mb-1">账户</div>
            <ChipGroup options={accountOpts} value={accountId} onChange={setAccountId} />
          </div>
        )}

        <div className="flex items-center gap-2 text-sm mb-2">
          <button type="button" className="chip" onClick={() => setMore(!more)}>
            📅 {fmtDateRel(date)}
          </button>
          <button type="button" className={`chip flex-1 text-left truncate ${note ? '' : 'text-muted'}`} onClick={() => setMore(true)}>
            📝 {note || '备注'}
          </button>
        </div>
        <div className={`expand ${more ? 'open' : ''}`}>
          <div>
            <div className="flex items-center gap-2 mb-2">
              <button type="button" className={`chip ${date === today() ? 'on' : ''}`} onClick={() => setDate(today())}>
                今天
              </button>
              <button type="button" className={`chip ${date === addDays(today(), -1) ? 'on' : ''}`} onClick={() => setDate(addDays(today(), -1))}>
                昨天
              </button>
              <input type="date" className="chip flex-1" value={date} max={today()} onChange={(e) => e.target.value && setDate(e.target.value)} />
            </div>
            <input className="w-full rounded-xl bg-card border border-line px-3 py-2 mb-3" placeholder="备注（可不填）" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
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
