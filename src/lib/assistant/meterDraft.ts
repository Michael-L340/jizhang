// 电表读数卡片（用户 2026-11-28：「如果还可以记录用电」）：和记账卡片一样先确认再存。纯函数。
// 规矩照用电页「记一次电表读数」弹层：读数是累计数、最多两位小数；时间不能在以后；
// 没说时间 = 点「记上」那一刻（不是卡片出来那一刻，放了半小时再点，时间不该差半小时）。
import type { DraftStatus } from './drafts'
import { fromBjInput, parseReading, toBjInput } from '../meter'

export interface MeterInput {
  /** 改一张还没确认的电表卡片时，AI 填它的代号（m3）；新的就是空串 */
  id: string
  /** 原样留着，校验在 makeMeterDraft（parseReading） */
  reading: string
  /** YYYY-MM-DD 或空串 */
  date: string
  /** HH:MM 或空串 */
  time: string
}

export interface MeterDraft {
  /** 对话里的代号（m1、m2…），AI 改卡片时用它指名；和记账卡片的 d1、d2 共用一个计数 */
  key: string
  /** 存进去时用的读数 id：建卡时就定下，保存报失败再点一次还是同一条，不会多出一条 */
  id: string
  /** 整数 0.01 度；读数不对是 null */
  centi: number | null
  /** 读数时间（毫秒）；null = 没说，按点「记上」那一刻算 */
  at: number | null
  status: DraftStatus
}

/** 用户说了日期或钟点就按北京时间拼出来：只说钟点 = 今天那个钟点；只说日期 = 那天的此刻 */
export function makeMeterDraft(input: MeterInput, key: string, id: string, now: number): MeterDraft {
  let at: number | null = null
  if (input.date || input.time) {
    const nowLocal = toBjInput(now)
    const ms = fromBjInput(`${input.date || nowLocal.slice(0, 10)}T${input.time || nowLocal.slice(11, 16)}`)
    at = Number.isFinite(ms) ? ms : null
  }
  return { key, id, centi: parseReading(input.reading), at, status: 'pending' }
}

/** 这张卡什么时候的读数 */
export const meterAt = (m: Pick<MeterDraft, 'at'>, now: number): number => m.at ?? now

/** 能不能存；不能就说为什么（显示在卡片上，「记上」灰着） */
export function meterProblem(m: Pick<MeterDraft, 'centi' | 'at'>, now: number): string | null {
  if (m.centi === null) return '读数不对，点开改一下'
  // 和用电页一样留一分钟余量：手机时钟差几十秒不该拦
  if (m.at !== null && m.at > now + 60_000) return '时间不能晚于现在'
  return null
}
