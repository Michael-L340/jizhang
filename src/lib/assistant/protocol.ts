// 和 AI 之间的「协议」：AI 回的 JSON 一律当成不可信的输入，在这里逐个字段校验，只留白名单里的动作。纯函数。
// 两步走（2026-11-25 和用户定的，Codex 审过）：第一步 AI 只说「要干什么」（出卡片 / 查什么 / 要不要分析）；
// 第二步只在分析时有：App 把算好的数交给 AI，让它写那段话。

export interface DraftInput {
  kind: 'expense' | 'income' | 'transfer'
  offset: boolean
  parent: string
  child: string
  /** 元，原样留着，校验在 drafts.ts（parseAiYuan） */
  amount: unknown
  account: string
  toAccount: string
  installments: number
  date: string
  note: string
}

import type { MeterInput } from './meterDraft'

export interface QueryInput {
  kind: 'expense' | 'income'
  parent: string
  child: string
  keyword: string
  from: string
  to: string
  chart: boolean
}

export type Action =
  | { op: 'new'; draft: DraftInput }
  | { op: 'replace'; id: string; draft: DraftInput }
  | { op: 'query'; q: QueryInput }
  | { op: 'analyze'; q: QueryInput }
  | { op: 'oneoff'; from: string; to: string }
  | { op: 'ask'; options: string[] }
  | { op: 'meter'; m: MeterInput }

export interface Intent {
  reply: string
  actions: Action[]
}

export interface Analysis {
  reply: string
  /** 「r1」「r2」：App 发过去的关键几笔的代号（不发真实 id） */
  refs: string[]
  ask: string[]
}

const str = (v: unknown, max = 40): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s

/**
 * 宽松地从 AI 的回复里拿出一个 JSON 对象：整段是 JSON；或者 ```json 围起来的那段；或者第一个 { 到最后一个 }。
 * 空白、截断、不是对象 → null（调用方显示「没听明白」，不要从半截里捞东西）
 */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const t = text.trim()
  if (!t) return null
  const tries = [t]
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) tries.push(fence[1])
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a >= 0 && b > a) tries.push(t.slice(a, b + 1))
  for (const s of tries) {
    try {
      const v = JSON.parse(s)
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
    } catch {
      /* 试下一种 */
    }
  }
  return null
}

function draftInput(o: Record<string, unknown>): DraftInput | null {
  const kind = o.kind === 'income' || o.kind === 'transfer' ? o.kind : o.kind === 'expense' ? 'expense' : null
  if (!kind) return null // 校准、未知类型：助手不做
  const inst = Math.round(Number(o.installments))
  return {
    kind,
    offset: kind !== 'transfer' && o.offset === true,
    parent: str(o.parent),
    child: str(o.child),
    amount: o.amount,
    account: str(o.account),
    toAccount: kind === 'transfer' ? str(o.to_account) : '',
    installments: Number.isFinite(inst) && inst >= 1 && inst <= 60 ? inst : 1,
    date: isYmd(str(o.date, 10)) ? str(o.date, 10) : '',
    note: str(o.note, 40),
  }
}

/** 电表读数：读数只留数字和小数点（AI 可能写成 12345.6、"12,345.6"、"12345.6度"），真正的校验在 meter.parseReading */
function meterInput(o: Record<string, unknown>): MeterInput | null {
  const raw = typeof o.reading === 'number' && Number.isFinite(o.reading) ? String(o.reading) : str(o.reading, 20)
  const reading = raw.replace(/[,，\s]/g, '').replace(/度$/, '')
  if (!reading) return null
  const date = str(o.date, 10)
  const tm = /^(\d{1,2}):(\d{2})$/.exec(str(o.time, 5))
  const time = tm && Number(tm[1]) < 24 && Number(tm[2]) < 60 ? `${tm[1].padStart(2, '0')}:${tm[2]}` : ''
  const id = str(o.id, 4)
  return { id: /^m\d{1,3}$/.test(id) ? id : '', reading, date: isYmd(date) ? date : '', time }
}

function queryInput(o: Record<string, unknown>, todayYmd: string): QueryInput | null {
  let from = str(o.from, 10)
  let to = str(o.to, 10)
  if (!isYmd(from) || !isYmd(to)) return null
  if (from > to) [from, to] = [to, from]
  if (to > todayYmd) to = todayYmd
  if (from > to) from = to
  return { kind: o.kind === 'income' ? 'income' : 'expense', parent: str(o.parent), child: str(o.child), keyword: str(o.keyword, 20), from, to, chart: o.chart === true }
}

/** 第一步的回复 → 意图。reply 必须有；动作最多 8 个，不认识的、字段不对的直接丢掉 */
export function parseIntent(text: string, todayYmd: string): Intent | null {
  const o = parseJsonObject(text)
  if (!o) return null
  const reply = str(o.reply, 400)
  const actions: Action[] = []
  const list = Array.isArray(o.actions) ? o.actions.slice(0, 8) : []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const a = raw as Record<string, unknown>
    if (a.op === 'new' || a.op === 'replace') {
      const d = draftInput(a)
      if (!d) continue
      if (a.op === 'new') actions.push({ op: 'new', draft: d })
      else if (str(a.id)) actions.push({ op: 'replace', id: str(a.id), draft: d })
    } else if (a.op === 'query' || a.op === 'analyze') {
      const q = queryInput(a, todayYmd)
      if (q) actions.push({ op: a.op, q })
    } else if (a.op === 'oneoff') {
      const q = queryInput({ ...a, kind: 'expense' }, todayYmd)
      if (q) actions.push({ op: 'oneoff', from: q.from, to: q.to })
    } else if (a.op === 'meter') {
      const m = meterInput(a)
      if (m) actions.push({ op: 'meter', m })
    } else if (a.op === 'ask' && Array.isArray(a.options)) {
      const options = a.options.map((x) => str(x, 30)).filter(Boolean).slice(0, 4)
      if (options.length) actions.push({ op: 'ask', options })
    }
  }
  if (!reply && !actions.length) return null
  return { reply, actions }
}

/** 第二步（分析）的回复 */
export function parseAnalysis(text: string): Analysis | null {
  const o = parseJsonObject(text)
  if (!o) return null
  const reply = str(o.reply, 1200)
  if (!reply) return null
  const refs = Array.isArray(o.refs) ? o.refs.map((x) => str(x, 4)).filter((x) => /^r\d{1,2}$/.test(x)).slice(0, 3) : []
  const ask = Array.isArray(o.ask) ? o.ask.map((x) => str(x, 30)).filter(Boolean).slice(0, 2) : []
  return { reply, refs, ask }
}
