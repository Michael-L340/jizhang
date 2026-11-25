// 外页面的最后一道闸：AI 只拿到外页面那本账，按理说不会提到里外的事；但它说的话是自由文本，
// 用户自己在外页面问一句「有没有隐藏的记录」，它也可能顺嘴说出这几个字。CLAUDE.md 死规则：外页面一律不出现。
// 命中就整句换成一句中性的话（不解释为什么换，解释本身就是线索）。
import type { Mode } from '../facade'

export const OUTER_FORBIDDEN = ['隐藏', '藏起来', '藏起', '里页面', '外页面', '里外', '外面隐藏', '隐身', '伪装', '假账', '校准记录'] as const

export function safeReply(text: string, mode: Mode): string {
  if (mode === 'inner') return text
  return OUTER_FORBIDDEN.some((w) => text.includes(w)) ? '这个我帮不上，换个问题试试？' : text
}
