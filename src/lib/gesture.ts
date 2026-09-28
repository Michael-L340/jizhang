// 流水行的左滑 / 右滑手势（用户 2026-09-28 定的方案甲：一边一个动作，滑过一段自动触发，动作在设置里选）。
// 纯逻辑：动作清单、外页面下的口径、触发判定、配置的读写校验。手势本身在 components/SwipeRow.tsx。
import type { Mode } from './facade'

export type SwipeAction = 'edit' | 'delete' | 'duplicate' | 'date' | 'hide' | 'none'

export interface SwipeConfig {
  left: SwipeAction
  right: SwipeAction
}

/** 用户定的默认：左滑删除（可撤销）、右滑编辑 */
export const DEFAULT_SWIPE: SwipeConfig = { left: 'delete', right: 'edit' }

export const SWIPE_LABEL: Record<SwipeAction, string> = {
  edit: '编辑',
  delete: '删除',
  duplicate: '再记一笔',
  date: '改日期',
  hide: '外面隐藏',
  none: '不用',
}

const ALL: SwipeAction[] = ['edit', 'delete', 'duplicate', 'date', 'hide', 'none']

/**
 * 设置页能选的动作。**外页面下没有「外面隐藏」这一项**——死规则：里外页面的一切文案只在里页面出现，
 * 设置页的清单也算（CLAUDE.md「里外页面」）。
 */
export function swipeOptions(mode: Mode): SwipeAction[] {
  return mode === 'inner' ? ALL : ALL.filter((a) => a !== 'hide')
}

/**
 * 当前模式下实际生效的配置：外页面把「外面隐藏」当「不用」——既不响应，设置页也显示成「不用」。
 * 里模式原样返回同一个对象。
 */
export function effectiveSwipe(cfg: SwipeConfig, mode: Mode): SwipeConfig {
  if (mode === 'inner') return cfg
  if (cfg.left !== 'hide' && cfg.right !== 'hide') return cfg
  return { left: cfg.left === 'hide' ? 'none' : cfg.left, right: cfg.right === 'hide' ? 'none' : cfg.right }
}

export const SWIPE_KEY = 'jz_swipe'
/** 横向拖过这么多 px 才算「在滑」，避免和上下滚动打架 */
export const SWIPE_DEAD_PX = 10
/** 松手时滑过这么多 px 就触发，不到就弹回 */
export const SWIPE_TRIGGER_PX = 96
/** 手指能把行拖多远（再远也只显示到这里，动作区不会被拉得没边） */
export const SWIPE_MAX_PX = 140

/** 缓存里的东西不可信：键缺了、值不认识，都退回默认 */
export function parseSwipe(raw: string | null): SwipeConfig {
  try {
    const o = raw ? (JSON.parse(raw) as Partial<SwipeConfig>) : null
    const ok = (v: unknown): v is SwipeAction => typeof v === 'string' && (ALL as string[]).includes(v)
    return { left: ok(o?.left) ? o.left : DEFAULT_SWIPE.left, right: ok(o?.right) ? o.right : DEFAULT_SWIPE.right }
  } catch {
    return DEFAULT_SWIPE
  }
}

export function readSwipe(): SwipeConfig {
  try {
    return parseSwipe(localStorage.getItem(SWIPE_KEY))
  } catch {
    return DEFAULT_SWIPE
  }
}

export function writeSwipe(cfg: SwipeConfig): void {
  try {
    localStorage.setItem(SWIPE_KEY, JSON.stringify(cfg))
  } catch {
    /* 存储被禁用时只保留内存里的值 */
  }
  // 同一个标签页里 storage 事件不触发，列表要立刻换动作只能自己喊一声（TxSwipe 的 useSwipeConfig 在听）
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SWIPE_KEY))
}

/**
 * 一次拖动的结论。dx 向右为正。
 * - 竖向位移比横向大 → 是在滚动，不算滑（返回 null 且调用方应放弃这次手势）
 * - 那一边配置成「不用」→ 拖不动（返回 null）
 * - 松手时 |dx| ≥ 触发距离 → 触发那一边
 */
export function swipeOutcome(dx: number, dy: number, cfg: SwipeConfig): 'left' | 'right' | null {
  if (Math.abs(dy) > Math.abs(dx)) return null
  if (dx <= -SWIPE_TRIGGER_PX && cfg.left !== 'none') return 'left'
  if (dx >= SWIPE_TRIGGER_PX && cfg.right !== 'none') return 'right'
  return null
}

/** 拖动时行该位移多少：那一边「不用」就不动；超过 SWIPE_MAX_PX 就停在那里 */
export function swipeOffset(dx: number, cfg: SwipeConfig): number {
  if (dx < 0 && cfg.left === 'none') return 0
  if (dx > 0 && cfg.right === 'none') return 0
  return Math.max(-SWIPE_MAX_PX, Math.min(SWIPE_MAX_PX, dx))
}
