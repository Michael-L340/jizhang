import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { CatIcon } from './CatIcon'
import { catMapOf, catPathOf, childrenOf, findCat, lastAccountByParent } from '../lib/assistant/book'
import { catSideOf, draftProblem, draftToTx, makeDraft, type Draft, type DraftCtx } from '../lib/assistant/drafts'
import { dailySeries, factsOf, ledgerLinkOf, type Query } from '../lib/assistant/facts'
import { safeReply } from '../lib/assistant/guard'
import { normNote, oneoffSpends } from '../lib/assistant/oneoff'
import { analysisPrompt, intentSystem, type ChatMsg } from '../lib/assistant/prompt'
import { parseAnalysis, parseIntent, type QueryInput } from '../lib/assistant/protocol'
import { addBubble, ensureFresh, getDraft, newDraftKey, patchBubble, pushTurns, putDraft, resetSession, touch, useAssistant, type Block } from '../lib/assistant/session'
import { fmtDateRel, fmtDateZh, nowIso, today } from '../lib/date'
import { outerBook } from '../lib/facade'
import { guessIcon } from '../lib/icons'
import { newId } from '../lib/id'
import { fmtYuan, parseYuan, yuanPlain } from '../lib/money'
import { AssistantError, useActiveAccounts, useStore } from '../lib/store'
import type { Account, Category, Transaction } from '../types'

const STARTERS = ['中午吃饭25，饮料3块', '这个月钱都花哪了', '最近两个月有哪些一次性开支']

/**
 * 记账助手（2026-11-25）：首页标题右边「助手」点开。两步走：AI 先说要干什么（出卡片 / 查什么 / 要不要分析），
 * App 在手机上执行；分析时再把算好的数交给 AI 写那段话。规矩见 lib/assistant/*。
 * 只吃当前模式那本账（otxs）；外页面下 AI 的话再过一道 safeReply。切换里外时弹层自己关、对话清空。
 */
export function AssistantSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate()
  const txs = useStore((s) => s.transactions)
  const cats = useStore((s) => s.categories)
  const fadj = useStore((s) => s.facade_adjusts)
  const mode = useStore((s) => s.mode)
  const accounts = useActiveAccounts()
  const allAccounts = useStore((s) => s.accounts)
  const otxs = useMemo(() => outerBook(txs, accounts, fadj, mode), [txs, accounts, fadj, mode])
  const bubbles = useAssistant((s) => s.bubbles)
  const drafts = useAssistant((s) => s.drafts)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const ctlRef = useRef<AbortController | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const td = today()

  // 打开时：模式变了或闲了 30 分钟就先清空
  useEffect(() => {
    if (open) ensureFresh(mode)
  }, [open, mode])
  // 里外一切换，开着的弹层自己收场（CLAUDE.md「里外页面」第一条）
  const modeRef = useRef(mode)
  useEffect(() => {
    if (modeRef.current !== mode) {
      ctlRef.current?.abort()
      onClose()
    }
    modeRef.current = mode
  }, [mode, onClose])
  // 关掉弹层：在途的问题取消（已经记上的账不受影响）
  useEffect(() => {
    if (!open) ctlRef.current?.abort()
  }, [open])
  useEffect(() => {
    if (open) requestAnimationFrame(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight }))
  }, [open, bubbles])

  const ctx: DraftCtx = useMemo(() => ({ cats, accounts: allAccounts, lastAcc: lastAccountByParent(otxs, cats), todayYmd: td }), [cats, allAccounts, otxs, td])

  const toQuery = (q: QueryInput): Query => {
    const c = q.parent || q.child ? findCat(cats, q.kind, q.parent, q.child) : null
    return { kind: q.kind, from: q.from, to: q.to, parentId: c && c.ok ? c.parent.id : null, childId: c && c.ok ? c.child?.id ?? null : null, keyword: q.keyword || null }
  }

  async function send(raw: string) {
    const msg = raw.trim()
    if (!msg || busy) return
    ensureFresh(mode)
    touch()
    setText('')
    addBubble({ who: 'me', text: msg, blocks: [] })
    // 明确断网：马上说，不发请求、不转圈
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      addBubble({ who: 'bot', text: '现在没网，助手用不了。记账不受影响，照常记，联网后自动上传。', blocks: [{ kind: 'fallback' }] })
      return
    }
    const gen = useAssistant.getState().gen
    const bid = addBubble({ who: 'bot', text: '', blocks: [], waiting: true })
    const ctl = new AbortController()
    ctlRef.current = ctl
    setBusy(true)
    const alive = () => useAssistant.getState().gen === gen && !ctl.signal.aborted
    try {
      const sys: ChatMsg = { role: 'system', content: intentSystem({ cats, accounts: allAccounts, drafts: useAssistant.getState().drafts, todayYmd: td }) }
      const user: ChatMsg = { role: 'user', content: msg }
      const r = await useStore.getState().askAssistant('intent', [sys, ...useAssistant.getState().turns, user], ctl.signal)
      if (!alive()) return
      const intent = parseIntent(r.content, td)
      if (!intent) {
        patchBubble(bid, { waiting: false, text: '没听明白，换个说法再说一次？' })
        return
      }
      pushTurns(user, { role: 'assistant', content: r.content })
      const blocks: Block[] = []
      const cardKeys: string[] = []
      let analyze: QueryInput | null = null
      for (const a of intent.actions) {
        if (a.op === 'new' || a.op === 'replace') {
          if (a.op === 'replace') {
            const old = getDraft(a.id)
            if (!old || old.status !== 'pending') continue // 已经记上的卡片，对话改不了
            putDraft({ ...old, status: 'void' })
          }
          const d = makeDraft(a.draft, ctx, newDraftKey(), newId())
          putDraft(d)
          cardKeys.push(d.key)
        } else if (a.op === 'query') blocks.push({ kind: 'query', q: toQuery(a.q), chart: a.q.chart })
        else if (a.op === 'oneoff') blocks.push({ kind: 'oneoff', from: a.from, to: a.to })
        else if (a.op === 'ask') blocks.push({ kind: 'ask', options: a.options })
        else if (a.op === 'analyze' && !analyze) analyze = a.q
      }
      if (cardKeys.length) blocks.unshift({ kind: 'cards', keys: cardKeys })
      patchBubble(bid, { waiting: !!analyze, text: safeReply(intent.reply, mode), blocks })
      if (analyze) {
        const q = toQuery(analyze)
        const f = factsOf(otxs, cats, q, td)
        const label = [q.kind === 'income' ? '收入' : '支出', q.parentId ? cats.find((c) => c.id === q.parentId)?.name : '', q.keyword ?? ''].filter(Boolean).join(' · ')
        const p = analysisPrompt(f, cats, label)
        const r2 = await useStore.getState().askAssistant('analysis', [{ role: 'system', content: p.system }, { role: 'user', content: p.user }], ctl.signal)
        if (!alive()) return
        const an = parseAnalysis(r2.content)
        if (!an) {
          patchBubble(bid, { waiting: false, text: safeReply(intent.reply, mode), blocks: [...blocks, { kind: 'query', q, chart: false }] })
          return
        }
        const refIds = an.refs.map((x) => p.refIds[Number(x.slice(1)) - 1]).filter(Boolean)
        const more: Block[] = [{ kind: 'query', q, chart: false }]
        if (refIds.length) more.unshift({ kind: 'refs', txIds: refIds })
        if (an.ask.length) more.push({ kind: 'ask', options: an.ask })
        patchBubble(bid, { waiting: false, text: safeReply(an.reply, mode), blocks: [...blocks.filter((b) => b.kind !== 'ask'), ...more] })
        pushTurns({ role: 'assistant', content: JSON.stringify({ reply: an.reply }) })
      }
    } catch (e) {
      if (useAssistant.getState().gen !== gen) return
      const k = e instanceof AssistantError ? e.kind : 'upstream'
      const say = ctl.signal.aborted && k === 'network' ? '停了。' : k === 'timeout' ? '网太慢，等不到回答。先用记一笔吧。' : k === 'network' ? '连不上，先用记一笔吧。' : k === 'auth' ? '登录过期了，重新登录后再试。' : k === 'busy' ? '助手暂时用不了，稍后再试。' : '出了点问题，再试一次。'
      patchBubble(bid, { waiting: false, text: say, blocks: k === 'timeout' || k === 'network' ? [{ kind: 'fallback' }] : [] })
    } finally {
      if (ctlRef.current === ctl) ctlRef.current = null
      setBusy(false)
    }
  }

  async function save(key: string) {
    const d = getDraft(key)
    // 同步锁：第一下就把卡片标成「保存中」，双击、回车都进不来；流水 id 建卡时就定了，不会变两条
    if (!d || d.status !== 'pending' || draftProblem(d, ctx)) return
    putDraft({ ...d, status: 'saving' })
    const ok = await useStore.getState().addTx(draftToTx(d, allAccounts, nowIso()))
    const cur = getDraft(key)
    if (cur) putDraft({ ...cur, status: ok ? 'saved' : 'pending' })
    touch()
  }

  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/35" />
      <div className="relative w-full max-w-[430px] bg-card rounded-t-2xl h-[86dvh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="shrink-0 pt-2 pb-2 px-4 border-b border-line">
          <div className="mx-auto h-1 w-10 rounded-full bg-line" />
          <div className="flex items-center justify-between pt-2">
            <span className="text-base font-semibold">记账助手</span>
            {bubbles.length ? (
              <button
                type="button"
                className="text-xs text-muted border border-line rounded-full px-2.5 py-1"
                onClick={() => {
                  ctlRef.current?.abort()
                  resetSession(mode)
                }}
              >
                新对话
              </button>
            ) : null}
          </div>
        </div>
        <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-3 flex flex-col gap-2.5">
          {bubbles.length === 0 ? (
            <div className="text-sm text-muted leading-relaxed">
              说一句话记账，或者问问账本。
              <div className="flex flex-wrap gap-1.5 mt-2">
                {STARTERS.map((s) => (
                  <button key={s} type="button" className="chip" style={{ padding: '6px 11px', fontSize: 13 }} onClick={() => void send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {bubbles.map((b) =>
            b.who === 'me' ? (
              <div key={b.id} className="self-end max-w-[80%] rounded-2xl rounded-br-md bg-brand-soft border border-brand/30 px-3.5 py-2 text-[15px] whitespace-pre-wrap break-words">
                {b.text}
              </div>
            ) : (
              <div key={b.id} className="self-start w-[94%] rounded-2xl rounded-bl-md bg-bg px-3.5 py-2.5 text-[15px] leading-relaxed">
                {b.text ? <div className="whitespace-pre-wrap break-words">{b.text}</div> : null}
                {b.waiting ? (
                  <div className="text-xs text-muted mt-1 flex items-center gap-2">
                    正在想…
                    <button type="button" className="underline" onClick={() => ctlRef.current?.abort()}>
                      停
                    </button>
                  </div>
                ) : null}
                {b.blocks.map((blk, i) => (
                  <BlockView key={i} blk={blk} drafts={drafts} ctx={ctx} otxs={otxs} cats={cats} accounts={allAccounts} todayYmd={td} onSave={save} onSay={(s) => void send(s)} go={(to) => { onClose(); nav(to) }} />
                ))}
              </div>
            ),
          )}
        </div>
        <form
          className="shrink-0 border-t border-line px-4 pt-2 flex items-end gap-2 safe-bottom"
          style={{ paddingBottom: 'max(10px, env(safe-area-inset-bottom))' }}
          onSubmit={(e) => {
            e.preventDefault()
            void send(text)
          }}
        >
          <textarea
            rows={1}
            aria-label="对助手说"
            className="flex-1 rounded-xl border border-line px-3 resize-none bg-card"
            style={{ height: 44, lineHeight: '22px', paddingTop: 10, paddingBottom: 10, overflowY: 'hidden' }}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              const el = e.currentTarget
              el.style.height = '44px'
              el.style.height = `${Math.min(Math.max(el.scrollHeight, 44), 120)}px`
              el.style.overflowY = el.scrollHeight > 120 ? 'auto' : 'hidden'
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send(text)
              }
            }}
          />
          <button type="submit" aria-label="发送" disabled={busy || !text.trim()} className={`w-11 h-11 rounded-full flex items-center justify-center shrink-0 ${busy || !text.trim() ? 'bg-line text-card' : 'bg-brand text-on-brand'}`}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M6 11l6-6 6 6" />
            </svg>
          </button>
        </form>
      </div>
    </div>,
    document.body,
  )
}

interface BlockProps {
  blk: Block
  drafts: Draft[]
  ctx: DraftCtx
  otxs: Transaction[]
  cats: Category[]
  accounts: Account[]
  todayYmd: string
  onSave: (key: string) => void
  onSay: (s: string) => void
  go: (to: string) => void
}

function BlockView(p: BlockProps) {
  const { blk } = p
  if (blk.kind === 'fallback')
    return (
      <button type="button" className="mt-2 w-full py-2 rounded-xl bg-ink text-white text-sm" onClick={() => p.go('/add')}>
        去记一笔
      </button>
    )
  if (blk.kind === 'ask')
    return (
      <div className="flex flex-wrap gap-1.5 mt-2">
        {blk.options.map((o) => (
          <button key={o} type="button" className="chip" style={{ padding: '6px 11px', fontSize: 13 }} onClick={() => p.onSay(o)}>
            {o}
          </button>
        ))}
      </div>
    )
  if (blk.kind === 'refs') return <TxLinks txs={blk.txIds.map((id) => p.otxs.find((t) => t.id === id)).filter((t): t is Transaction => Boolean(t))} cats={p.cats} go={p.go} />
  if (blk.kind === 'oneoff') return <OneoffCard {...p} from={blk.from} to={blk.to} />
  if (blk.kind === 'query') return <QueryCard {...p} q={blk.q} chart={blk.chart} />
  const list = blk.keys.map((k) => p.drafts.find((d) => d.key === k)).filter((d): d is Draft => Boolean(d))
  const savable = list.filter((d) => d.status === 'pending' && !draftProblem(d, p.ctx))
  return (
    <div className="flex flex-col gap-2 mt-2">
      {list.map((d) => (
        <DraftCard key={d.key} d={d} ctx={p.ctx} onSave={() => p.onSave(d.key)} />
      ))}
      {savable.length > 1 ? (
        <button type="button" className="w-full py-2 rounded-xl bg-ink text-white text-sm" onClick={() => savable.forEach((d) => p.onSave(d.key))}>
          这几笔都记上
        </button>
      ) : null}
    </div>
  )
}

function iconOf(d: Draft, cats: readonly Category[]): string {
  if (d.kind === 'transfer') return '🔁'
  const c = cats.find((x) => x.id === (d.childId ?? d.parentId))
  const parent = d.parentId ? cats.find((x) => x.id === d.parentId) : undefined
  return c?.icon ?? guessIcon(c?.name ?? '') ?? parent?.icon ?? '🧾'
}

function DraftCard({ d, ctx, onSave }: { d: Draft; ctx: DraftCtx; onSave: () => void }) {
  const [openEdit, setOpenEdit] = useState(false)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const addCategory = useStore((s) => s.addCategory)
  const accName = (id: string | null) => (id ? ctx.accounts.find((a) => a.id === id)?.name ?? '？' : '未指定账户')
  const byId = catMapOf(ctx.cats)
  const path = d.parentId ? catPathOf({ category_id: d.childId ?? d.parentId }, byId) : null
  const title = d.kind === 'transfer' ? '转账' : path ? (path.child ? `${path.parent.name} · ${path.child.name}` : `${path.parent.name}${d.noChild ? '（不细分）' : ''}`) : '选一下分类'
  const sub = d.kind === 'transfer' ? `${accName(d.accountId)} → ${d.toAccountId ? accName(d.toAccountId) : '？'}` : `${accName(d.accountId)}${d.installments > 1 ? ` · 分${d.installments}期` : ''}`
  const amt = d.amount === null ? '—' : d.kind === 'transfer' ? fmtYuan(d.amount) : `${d.kind === 'expense' ? '-' : '+'}${fmtYuan(d.amount)}`
  const color = d.kind === 'transfer' ? 'text-transfer' : d.kind === 'expense' ? 'text-expense' : 'text-income'
  const problem = draftProblem(d, ctx)
  const set = (patch: Partial<Draft>) => putDraft({ ...d, ...patch })
  if (d.status === 'void')
    return (
      <div className="rounded-xl border border-dashed border-line px-3 py-2 flex items-center gap-2 opacity-60 text-[13px]">
        <span className="flex-1 truncate line-through">{title} · {sub}</span>
        <span className="num line-through">{amt}</span>
        <span className="text-[11px] text-muted shrink-0">已作废</span>
      </div>
    )
  const pickChild = d.kind !== 'transfer' && d.parentId && d.needChild && !d.childId && !d.noChild && d.status === 'pending'
  const side = catSideOf(d)
  return (
    <div className={`rounded-xl border bg-card overflow-hidden ${openEdit ? 'border-2 border-brand' : 'border-line'} ${d.status === 'saved' ? 'opacity-75' : ''}`}>
      <button type="button" className="w-full flex items-center gap-3 px-3 py-2.5 text-left" onClick={() => d.status === 'pending' && setOpenEdit(!openEdit)}>
        <span className="w-9 h-9 rounded-full bg-brand-soft flex items-center justify-center text-[20px] leading-none shrink-0">
          <CatIcon icon={iconOf(d, ctx.cats)} size={26} />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block truncate text-[15px]">
            {title}
            {d.offset ? <span className="ml-1.5 align-[1px] text-[10px] text-brand-ink border border-brand rounded px-1">{d.kind === 'income' ? '抵支出' : '抵收入'}</span> : null}
          </span>
          <span className="block truncate text-xs text-muted">
            {sub} · {fmtDateRel(d.date, ctx.todayYmd)}
            {d.note ? ` · ${d.note}` : ''}
          </span>
        </span>
        <span className={`num text-[16px] font-medium shrink-0 ${color}`}>{amt}</span>
      </button>
      {pickChild ? (
        <div className="px-3 pb-2.5">
          <div className="text-xs text-muted mb-1.5">{path?.parent.name}下面记到哪一个？点一个，或者直接说</div>
          <div className="flex flex-wrap gap-1.5">
            {childrenOf(ctx.cats, d.parentId!).map((c) => (
              <button key={c.id} type="button" className="chip" style={{ padding: '6px 11px', fontSize: 13 }} onClick={() => set({ childId: c.id })}>
                {c.name}
              </button>
            ))}
            <button type="button" className="chip" style={{ padding: '6px 11px', fontSize: 13 }} onClick={() => set({ noChild: true })}>
              不细分
            </button>
            <button type="button" className="chip" style={{ padding: '6px 11px', fontSize: 13, borderStyle: 'dashed' }} onClick={() => setAdding(!adding)}>
              ＋ 新增
            </button>
          </div>
          {adding ? (
            <form
              className="flex gap-2 mt-2"
              onSubmit={async (e) => {
                e.preventDefault()
                if (!newName.trim() || !side) return
                const c = await addCategory(side, d.parentId, newName)
                const cur = getDraft(d.key)
                if (c && cur) putDraft({ ...cur, childId: c.id })
                setAdding(false)
                setNewName('')
              }}
            >
              <input className="flex-1 min-w-0 rounded-lg border border-line px-2.5 py-1.5" maxLength={12} placeholder="新的二级分类名" aria-label="新的二级分类名" value={newName} onChange={(e) => setNewName(e.target.value)} />
              <button type="submit" className="rounded-full bg-ink text-white text-xs px-3">
                加上
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
      {openEdit && d.status === 'pending' ? <DraftEditor d={d} ctx={ctx} set={set} /> : null}
      <div className={`flex items-center justify-between gap-2 px-3 pb-2.5 ${openEdit ? 'pt-2.5 border-t border-line' : ''}`}>
        {d.status === 'saved' ? (
          <span className="text-xs text-income">已记上 ✓</span>
        ) : (
          <>
            <span className={`text-[11px] ${problem ? 'text-expense' : 'text-muted'}`}>{problem ?? (openEdit ? '' : '点卡片可以改')}</span>
            <span className="flex gap-2 shrink-0">
              {openEdit ? (
                <button type="button" className="rounded-full border border-line text-xs px-3 py-1" onClick={() => setOpenEdit(false)}>
                  收起
                </button>
              ) : null}
              <button type="button" disabled={Boolean(problem) || d.status !== 'pending'} className={`rounded-full text-xs font-medium px-3.5 py-1 ${problem || d.status !== 'pending' ? 'bg-line text-muted' : 'bg-brand text-on-brand'}`} onClick={onSave}>
                {d.status === 'saving' ? '记账中…' : '记上'}
              </button>
            </span>
          </>
        )}
      </div>
    </div>
  )
}

function DraftEditor({ d, ctx, set }: { d: Draft; ctx: DraftCtx; set: (p: Partial<Draft>) => void }) {
  const [amountText, setAmountText] = useState(d.amount === null ? '' : yuanPlain(d.amount))
  const side = catSideOf(d)
  const roots = side ? ctx.cats.filter((c) => c.kind === side && !c.parent_id && !c.is_archived).sort((a, b) => a.sort - b.sort) : []
  const kids = d.parentId ? childrenOf(ctx.cats, d.parentId) : []
  const live = ctx.accounts.filter((a) => !a.is_archived).sort((a, b) => a.sort - b.sort)
  const onCredit = d.kind === 'expense' && !d.offset && ctx.accounts.find((a) => a.id === d.accountId)?.kind === 'credit'
  const row = (label: string, node: React.ReactNode) => (
    <label className="flex items-center justify-between gap-3 py-2 border-t border-line text-sm">
      <span className="text-muted shrink-0">{label}</span>
      {node}
    </label>
  )
  const accChips = (cur: string | null, onPick: (id: string) => void, skip?: string | null) => (
    <div className="flex flex-wrap gap-1.5">
      {live
        .filter((a) => a.id !== skip)
        .map((a) => (
          <button key={a.id} type="button" className={`chip ${a.id === cur ? 'on' : ''}`} style={{ padding: '6px 11px', fontSize: 13 }} onClick={() => onPick(a.id)}>
            {a.name}
          </button>
        ))}
    </div>
  )
  const switchKind = (patch: Partial<Draft>) => {
    const next = { ...d, ...patch }
    set({ ...patch, parentId: null, childId: null, needChild: false, noChild: false, installments: 1, toAccountId: next.kind === 'transfer' ? d.toAccountId : null })
  }
  return (
    <div className="px-3 pb-1">
      {row(
        '类型',
        <span className="flex items-center gap-2">
          <span className="inline-flex rounded-full bg-bg p-0.5">
            {(['expense', 'income', 'transfer'] as const).map((k) => (
              <button key={k} type="button" className={`px-2.5 py-1 rounded-full text-xs ${d.kind === k ? 'bg-ink text-white' : 'text-muted'}`} onClick={() => d.kind !== k && switchKind({ kind: k, offset: false })}>
                {k === 'expense' ? '支出' : k === 'income' ? '收入' : '转账'}
              </button>
            ))}
          </span>
          {d.kind !== 'transfer' ? (
            <button type="button" className={`chip ${d.offset ? 'on' : ''}`} style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => switchKind({ offset: !d.offset })}>
              抵消
            </button>
          ) : null}
        </span>,
      )}
      {d.offset ? <div className="text-[11px] text-muted pb-2">{d.kind === 'income' ? '这笔收入不算收入，从下面选的支出分类里扣（退款）' : '这笔支出不算支出，从下面选的收入分类里扣（垫付）'}</div> : null}
      {row(
        '金额',
        <input
          inputMode="decimal"
          className="num w-28 text-right rounded-lg border border-line px-2 py-1"
          value={amountText}
          onChange={(e) => setAmountText(e.target.value)}
          onBlur={() => {
            const c = parseYuan(amountText)
            set({ amount: c !== null && c > 0 ? c : null })
          }}
        />,
      )}
      {d.kind !== 'transfer' ? (
        <>
          {row(
            '一级',
            <select className="rounded-lg border border-line px-2 py-1 bg-card" value={d.parentId ?? ''} onChange={(e) => set({ parentId: e.target.value || null, childId: null, noChild: false, needChild: Boolean(e.target.value && childrenOf(ctx.cats, e.target.value).length) })}>
              <option value="">选一级</option>
              {roots.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>,
          )}
          {kids.length
            ? row(
                '二级',
                <select className="rounded-lg border border-line px-2 py-1 bg-card" value={d.childId ?? ''} onChange={(e) => set({ childId: e.target.value || null, noChild: !e.target.value })}>
                  <option value="">不细分</option>
                  {kids.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>,
              )
            : null}
          <div className="py-2 border-t border-line">
            <div className="text-sm text-muted mb-1.5">账户</div>
            {accChips(d.accountId, (id) => set({ accountId: id, installments: 1 }))}
          </div>
          {onCredit
            ? row(
                '分期',
                <select className="rounded-lg border border-line px-2 py-1 bg-card" value={d.installments} onChange={(e) => set({ installments: Number(e.target.value) || 1 })}>
                  {[1, 3, 6, 12, 24].map((n) => (
                    <option key={n} value={n}>
                      {n === 1 ? '一次还清' : `${n} 期`}
                    </option>
                  ))}
                </select>,
              )
            : null}
        </>
      ) : (
        <>
          <div className="py-2 border-t border-line">
            <div className="text-sm text-muted mb-1.5">从哪个账户转出</div>
            {accChips(d.accountId, (id) => set({ accountId: id, toAccountId: d.toAccountId === id ? null : d.toAccountId }))}
          </div>
          <div className="py-2 border-t border-line">
            <div className="text-sm text-muted mb-1.5">转到哪个账户</div>
            {accChips(d.toAccountId, (id) => set({ toAccountId: id }), d.accountId)}
          </div>
        </>
      )}
      {row('日期', <input type="date" className="rounded-lg border border-line px-2 py-1" value={d.date} max={ctx.todayYmd} onChange={(e) => e.target.value && set({ date: e.target.value })} />)}
      {row('备注', <input className="w-40 rounded-lg border border-line px-2 py-1" maxLength={40} value={d.note} placeholder="可不填" onChange={(e) => set({ note: e.target.value })} />)}
    </div>
  )
}

function TxLinks({ txs, cats, go }: { txs: Transaction[]; cats: Category[]; go: (to: string) => void }) {
  const byId = catMapOf(cats)
  if (!txs.length) return null
  return (
    <div className="flex flex-col gap-1.5 mt-2">
      {txs.map((t) => {
        const p = catPathOf(t, byId)
        const name = normNote(t.note) || p?.child?.name || p?.parent.name || '未分类'
        return (
          <button key={t.id} type="button" className="flex items-center justify-between rounded-lg bg-card border border-line px-2.5 py-1.5 text-xs text-left" onClick={() => go(`/ledger?date=${t.date}`)}>
            <span className="text-muted truncate num">
              {fmtDateZh(t.date, false)} · {name}
            </span>
            <span className="num shrink-0 ml-2">
              <span className={t.type === 'income' && !t.is_offset ? 'text-income' : 'text-expense'}>
                {t.type === 'income' ? '+' : '-'}
                {fmtYuan(Math.abs(t.amount))}
              </span>
              <span className="text-brand-ink"> ›</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`

function QueryCard(p: BlockProps & { q: Query; chart: boolean }) {
  const { q } = p
  const f = useMemo(() => factsOf(p.otxs, p.cats, q, p.todayYmd), [p.otxs, p.cats, q, p.todayYmd])
  const series = useMemo(() => (p.chart ? dailySeries(p.otxs, p.cats, q, p.todayYmd) : null), [p.chart, p.otxs, p.cats, q, p.todayYmd])
  const name = [q.parentId ? p.cats.find((c) => c.id === q.parentId)?.name : q.kind === 'income' ? '收入' : '支出', q.childId ? p.cats.find((c) => c.id === q.childId)?.name : '', q.keyword ?? ''].filter(Boolean).join(' · ')
  const color = q.kind === 'income' ? 'text-income' : 'text-expense'
  const diff = f.total - f.prev.total
  const good = q.kind === 'income' ? diff >= 0 : diff <= 0
  const max = series ? Math.max(...series.map((x) => x.total), 1) : 1
  return (
    <div className="rounded-xl border border-line bg-card px-3 py-2.5 mt-2">
      <div className="text-xs text-muted">
        {name} · {md(q.from)}–{md(q.to)}
      </div>
      <div className="flex items-baseline justify-between mt-0.5">
        <span className={`num text-[22px] font-semibold ${color}`}>{fmtYuan(f.total)}</span>
        <span className="text-xs text-muted">{f.count}笔</span>
      </div>
      <div className="text-[11px] text-muted num">
        比上一段（{md(f.prev.from)}–{md(f.prev.to)}）{diff >= 0 ? '多' : '少'} <span className={good ? 'text-income' : 'text-expense'}>{fmtYuan(Math.abs(diff))}</span>
        {q.kind === 'expense' ? ` · 日均 ${fmtYuan(f.dailyAvg)}` : ''}
      </div>
      {f.parts.length > 1 ? (
        <div className="mt-2 pt-2 border-t border-line flex flex-col gap-1.5">
          {f.parts.slice(0, 5).map((x) => (
            <div key={x.id}>
              <div className="flex justify-between text-xs">
                <span>
                  {x.name} <span className="text-muted num">{x.sharePct}%</span>
                </span>
                <span className="num">{fmtYuan(x.total)}</span>
              </div>
              <div className="h-1 rounded-full bg-bg mt-1 overflow-hidden">
                <div className={`h-full rounded-full ${q.kind === 'income' ? 'bg-income' : 'bg-expense'} opacity-70`} style={{ width: `${x.sharePct}%` }} />
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {series ? (
        <div className="mt-2 pt-2 border-t border-line">
          <div className="flex items-end gap-px h-16" role="img" aria-label="每天的金额">
            {series.map((x) => (
              <div key={x.date} className={`flex-1 rounded-t-sm ${q.kind === 'income' ? 'bg-income' : 'bg-expense'}`} style={{ height: `${Math.max(0, (x.total / max) * 100)}%`, opacity: x.total > 0 ? 0.8 : 0 }} />
            ))}
          </div>
          <div className="flex justify-between text-[10px] text-muted num mt-0.5">
            <span>{md(series[0].date)}</span>
            <span>{md(series[series.length - 1].date)}</span>
          </div>
        </div>
      ) : null}
      <button type="button" className="mt-2 w-full flex items-center justify-between rounded-lg bg-brand-soft px-3 py-2 text-xs text-brand-ink" onClick={() => p.go(ledgerLinkOf(q))}>
        <span>
          在流水里看：{md(q.from)}–{md(q.to)}
          {q.parentId ? ` · ${name}` : ''}
        </span>
        <span>›</span>
      </button>
    </div>
  )
}

function OneoffCard(p: BlockProps & { from: string; to: string }) {
  const items = useMemo(() => oneoffSpends(p.otxs, p.cats, p.from, p.to), [p.otxs, p.cats, p.from, p.to])
  const total = items.reduce((s, t) => s + t.amount, 0)
  return (
    <div className="rounded-xl border border-line bg-card px-3 py-2.5 mt-2">
      <div className="text-xs text-muted">
        一次性开支 · {md(p.from)}–{md(p.to)}
      </div>
      <div className="flex items-baseline justify-between mt-0.5">
        <span className="num text-[22px] font-semibold text-expense">{fmtYuan(total)}</span>
        <span className="text-xs text-muted">{items.length}笔</span>
      </div>
      {items.length ? <TxLinks txs={items.slice(0, 12)} cats={p.cats} go={p.go} /> : <div className="text-xs text-muted mt-1">这段时间没有一次性开支</div>}
      {items.length > 12 ? <div className="text-[11px] text-muted mt-1">只列了最大的12笔</div> : null}
    </div>
  )
}
