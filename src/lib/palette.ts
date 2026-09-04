// 分类配色。同一个分类在饼图、图例、折线图里永远是同一个颜色。
const BY_NAME: { test: (n: string) => boolean; color: string }[] = [
  { test: (n) => n.includes('餐饮') || n.includes('日常') || n.includes('吃'), color: '#f5a524' },
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

function rgb2hex(r: number, g: number, b: number): string {
  const c = (x: number) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

/** hex → [色相 0-360, 饱和度 0-1, 明度 0-1] */
export function hexToHsl(hex: string): [number, number, number] {
  const [r, g, b] = hex2rgb(hex).map((v) => v / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return [0, 0, l]
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
  else if (max === g) h = ((b - r) / d + 2) * 60
  else h = ((r - g) / d + 4) * 60
  return [h, s, l]
}

function hslToHex(h: number, s: number, l: number): string {
  const hh = ((h % 360) + 360) % 360
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1))
  const m = l - c / 2
  const seg = Math.floor(hh / 60) % 6
  const [r, g, b] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][seg]
  return rgb2hex((r + m) * 255, (g + m) * 255, (b + m) * 255)
}

/** 色相左右各摆多少度。太大会跑出这个色系，太小又分不清 */
const HUE_SPREAD = 28
/** 明度从多暗走到多亮。范围写死而不跟着父色走，保证任何一个大类下的对比度都一样 */
const L_MIN = 0.34
const L_MAX = 0.78

/**
 * 二级分类的配色：同一个色系，但同时拉开明度和色相。
 *
 * 原来只是把父色往白色里兑（0 到 62%），6 个二级分类之间只差 12% 的白，
 * 最后两片肉眼几乎分不出来。现在明度从 36% 走到 76%、色相左右各摆 20 度，
 * 相邻两级的差别一眼能看见。
 *
 * 最后一步是交错：饼图和图例都按金额排序，如果直接按渐变顺序发色，相邻两片永远
 * 是渐变里挨着的两个、差别最小。把渐变的前半段和后半段交替取出，相邻两片就总是
 * 来自渐变的两端——二级分类多到十几个时，这一步比拉大范围管用得多。
 */
export function childColors(parentColor: string, n: number): string[] {
  if (n <= 1) return [parentColor]
  const [h0, s0] = hexToHsl(parentColor)
  const ramp = Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1)
    const h = h0 + (t - 0.5) * HUE_SPREAD
    const l = L_MIN + t * (L_MAX - L_MIN)
    // 越亮的越降一点饱和度，否则浅色那几片会显得发荧光
    const s = Math.max(0.32, Math.min(0.92, s0 * (1 - t * 0.18)))
    return hslToHex(h, s, l)
  })
  const out: string[] = []
  const mid = Math.ceil(n / 2)
  for (let i = 0; i < mid; i++) {
    out.push(ramp[i])
    if (i + mid < n) out.push(ramp[i + mid])
  }
  return out
}
