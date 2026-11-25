// 助手的一次对话（2026-11-25 和用户定的上下文规矩）：
//   · 只在这一次对话里记：屏幕上的气泡、卡片，以及发给 AI 的最近几轮。
//   · 关掉弹层不清（出去看一眼流水再回来接着问）。
//   · 切换里外、退出登录、30 分钟不用、点「新对话」→ 清空。不存长期记录（只在内存里，刷新也没了）。
// 卡片、查账结果都是在这里登记的「数据」，金额等到渲染时再用当前那本账现算（记了新账，数字跟着变）。
import { create } from 'zustand'
import type { Draft } from './drafts'
import type { Query } from './facts'
import type { ChatMsg } from './prompt'
import { useStore } from '../store'
import type { Mode } from '../facade'

export const IDLE_CLEAR_MS = 30 * 60 * 1000
/** 发给 AI 的历史最多几条（一问一答算两条） */
export const MAX_TURNS = 12

export type Block =
  | { kind: 'cards'; keys: string[] }
  | { kind: 'query'; q: Query; chart: boolean }
  | { kind: 'oneoff'; from: string; to: string }
  | { kind: 'refs'; txIds: string[] }
  | { kind: 'ask'; options: string[] }
  /** 没网、网慢、连不上：给「去记一笔」 */
  | { kind: 'fallback' }

export interface Bubble {
  id: number
  who: 'me' | 'bot'
  text: string
  blocks: Block[]
  /** 还在等 AI */
  waiting?: boolean
}

interface SessionState {
  /** 这次对话是哪个模式开的：模式一变整段作废 */
  mode: Mode
  /** 每清一次 +1：在途的请求回来时对一下，对不上就扔掉 */
  gen: number
  lastActive: number
  bubbles: Bubble[]
  drafts: Draft[]
  turns: ChatMsg[]
  nextId: number
  nextDraft: number
}

const fresh = (mode: Mode, gen: number): SessionState => ({ mode, gen, lastActive: Date.now(), bubbles: [], drafts: [], turns: [], nextId: 1, nextDraft: 1 })

export const useAssistant = create<SessionState>(() => fresh('outer', 0))

export function resetSession(mode: Mode = useStore.getState().mode): void {
  useAssistant.setState((s) => fresh(mode, s.gen + 1))
}

/** 打开弹层、发消息前调用：模式不一样、或者闲了 30 分钟，先清空 */
export function ensureFresh(mode: Mode, now = Date.now()): void {
  const s = useAssistant.getState()
  if (s.mode !== mode || now - s.lastActive > IDLE_CLEAR_MS) resetSession(mode)
}

export function touch(): void {
  useAssistant.setState({ lastActive: Date.now() })
}

export function addBubble(b: Omit<Bubble, 'id'>): number {
  const id = useAssistant.getState().nextId
  useAssistant.setState((s) => ({ bubbles: [...s.bubbles, { ...b, id }], nextId: s.nextId + 1 }))
  return id
}

export function patchBubble(id: number, patch: Partial<Bubble>): void {
  useAssistant.setState((s) => ({ bubbles: s.bubbles.map((b) => (b.id === id ? { ...b, ...patch } : b)) }))
}

export function newDraftKey(): string {
  const n = useAssistant.getState().nextDraft
  useAssistant.setState({ nextDraft: n + 1 })
  return `d${n}`
}

export function putDraft(d: Draft): void {
  useAssistant.setState((s) => (s.drafts.some((x) => x.key === d.key) ? { drafts: s.drafts.map((x) => (x.key === d.key ? d : x)) } : { drafts: [...s.drafts, d] }))
}

export function getDraft(key: string): Draft | undefined {
  return useAssistant.getState().drafts.find((d) => d.key === key)
}

export function pushTurns(...t: ChatMsg[]): void {
  useAssistant.setState((s) => ({ turns: [...s.turns, ...t].slice(-MAX_TURNS) }))
}

// 切换里外、退出登录：不管弹层开没开，整段清掉（在途请求回来对不上 gen，自然作废）
useStore.subscribe((s, prev) => {
  if (s.mode !== prev.mode || (s.auth !== 'in' && prev.auth === 'in')) resetSession(s.mode)
})
