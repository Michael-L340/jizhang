// 分类配色。同一个分类在饼图、图例、折线图里永远是同一个颜色。
import type { Category } from '../types'

const BY_NAME: { test: (n: string) => boolean; color: string }[] = [
  { test: (n) => n.includes('餐饮') || n.includes('吃'), color: '#f5a524' },
  { test: (n) => n.includes('娱乐') || n.includes('游戏'), color: '#7c5cff' },
  { test: (n) => n.includes('非经常') || n.includes('大额'), color: '#14b8a6' },
  { test: (n) => n.includes('经常') || n.includes('固定'), color: '#2f6fed' },
  { test: (n) => n.includes('意外') || n.includes('其他'), color: '#e5484d' },
  { test: (n) => n.includes('工资') || n.includes('实习'), color: '#1f9d55' },
  { test: (n) => n.includes('生活费'), color: '#2f6fed' },
  { test: (n) => n.includes('奖学金'), color: '#f5a524' },
  { test: (n) => n.includes('理财'), color: '#7c5cff' },
  { test: (n) => n.includes('退款'), color: '#14b8a6' },
]

const FALLBACK = ['#2f6fed', '#f5a524', '#14b8a6', '#7c5cff', '#e5484d', '#0ea5e9', '#f97316', '#a855f7', '#64748b']

/** 一级分类的固定颜色 */
export function categoryColor(name: string, index = 0): string {
  for (const r of BY_NAME) if (r.test(name)) return r.color
  return FALLBACK[index % FALLBACK.length]
}

function hex2rgb(h: string): [number, number, number] {
  const v = h.replace('#', '')
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]
}

/** 把颜色按 t（0-1）向白色混合，用于二级分类的同色系深浅 */
export function tint(color: string, t: number): string {
  const [r, g, b] = hex2rgb(color)
  const m = (c: number) => Math.round(c + (255 - c) * t)
  return `#${[m(r), m(g), m(b)].map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

/** 二级分类在父色基础上依次变浅 */
export function childColors(parentColor: string, n: number): string[] {
  if (n <= 1) return [parentColor]
  return Array.from({ length: n }, (_, i) => tint(parentColor, (i / Math.max(n - 1, 1)) * 0.62))
}

/** 按显示顺序给一组一级分类分配颜色 */
export function colorsFor(cats: { name: string }[]): string[] {
  return cats.map((c, i) => categoryColor(c.name, i))
}

export function rootOf(cats: Category[], id: string | null): Category | undefined {
  if (!id) return undefined
  const map = new Map(cats.map((c) => [c.id, c]))
  const c = map.get(id)
  if (!c) return undefined
  return c.parent_id ? map.get(c.parent_id) ?? c : c
}
