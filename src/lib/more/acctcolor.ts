// 进阶分析里「按账户分色」的图（资产结构变化、白条未来负担）共用的配色。
//
// 账户的品牌色在 components/AccountIcon.tsx 的 accountColor 里。lib 不往上 import components
//（分层规矩：components → lib，反过来不行），所以由页面把 accountColor 当参数传进来；
// 不传就从 palette.CHART 的一个颜色起一条同色系渐变，n 个账户两两分得开。
//
// 品牌色直接拿来堆叠会撞色：中国银行和招商银行都是红、京东和拼多多也都是红。
// 折线图上两条红线还能靠位置分，堆叠图里两块挨着的红就糊成一块，看不出哪块是哪家。
// 所以撞了色的，后来那个换成同色系里另一档深浅（palette.childShade），不另发明颜色。
import type { Account } from '../../types'
import { childColors, childShade, hexToHsl } from '../palette'

/** 账户名 → 颜色（页面传 components/AccountIcon 的 accountColor） */
export type ColorOf = (name: string) => string

/** 色相差多少度以内算「同一个色」 */
const HUE_NEAR = 30
/** 明度差多少以内算「一样深」 */
const L_NEAR = 0.15
/** 饱和度低于它算灰色，灰色不比色相 */
const GREY = 0.15

/**
 * 两个颜色挨得太近，堆在一起分不开：色相差 < 30° 且明度差 < 0.15。
 * 两个都是灰色时只看明度；一灰一彩不算近。
 */
export function tooClose(a: string, b: string): boolean {
  const [h1, s1, l1] = hexToHsl(a)
  const [h2, s2, l2] = hexToHsl(b)
  if (Math.abs(l1 - l2) >= L_NEAR) return false
  const g1 = s1 < GREY
  const g2 = s2 < GREY
  if (g1 || g2) return g1 && g2
  const dh = Math.abs(h1 - h2) % 360
  return Math.min(dh, 360 - dh) < HUE_NEAR
}

/** 撞色时依次试的深浅档（childShade 的 sort）：先拉开明度最大的那几档 */
const SHADE_TRY = [2, 4, 6, 3, 5]

/**
 * 没有品牌色时的一组颜色：fallback 同色系的前 n 档深浅（palette.childShade 的 1…n 档）。
 * 不直接用 childColors(fallback, n)：n = 2 时它给的是渐变的两头，浅的那头（明度 0.78）在白卡片上几乎看不见；
 * childShade 那六档是交错排的（明度 .34 / .60 / .43 / .69 / .52 / .78），前几个账户先拿到看得清的那几档。
 * 六个以上才退回 childColors(fallback, n)，保证两两不同。
 */
export function fallbackColors(fallback: string, n: number): string[] {
  if (n > SHADES) return childColors(fallback, n)
  return Array.from({ length: n }, (_, i) => childShade(fallback, i + 1))
}
/** childShade 一共几档 */
const SHADES = 6

/**
 * 一组账户的颜色，和 accounts 一一对应。
 * - 给了 colorOf：用品牌色；和前面某个撞色的，换成它同色系里第一档不撞任何已发颜色的深浅。
 * - 没给：fallbackColors(fallback, 账户数)。
 *
 * 颜色按传进来的**整张账户表**发，不要先按「有没有数」筛掉再发——
 * 否则换个时间段、某个账户这段没数，别的账户就跟着换颜色。
 */
export function accountColors(accounts: Account[], colorOf: ColorOf | undefined, fallback: string): string[] {
  if (!colorOf) return fallbackColors(fallback, accounts.length)
  const out: string[] = []
  for (const a of accounts) {
    const raw = colorOf(a.name)
    if (!out.some((c) => tooClose(c, raw))) {
      out.push(raw)
      continue
    }
    const tries = SHADE_TRY.map((s) => childShade(raw, s))
    out.push(tries.find((c) => !out.some((o) => tooClose(o, c))) ?? tries[0])
  }
  return out
}
