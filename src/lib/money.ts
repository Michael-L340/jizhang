// 元 ↔ 分 的唯一转换点。除此文件外，程序里所有金额都是整数「分」。

/** 把用户输入的字符串（元）解析成分；非法返回 null */
export function parseYuan(input: string): number | null {
  const s = input.trim().replace(/,/g, '')
  if (!/^-?\d{0,9}(\.\d{0,2})?$/.test(s) || s === '' || s === '-' || s === '.' || s === '-.') return null
  const neg = s.startsWith('-')
  const [intPart, decPart = ''] = s.replace('-', '').split('.')
  const cents = Number(intPart || '0') * 100 + Number((decPart + '00').slice(0, 2))
  return neg ? -cents : cents
}

/** 数据库 numeric（可能是 number 或 string）→ 分 */
export function centsFromDb(v: number | string): number {
  return Math.round(Number(v) * 100)
}

/** 分 → 数据库 numeric 的字符串表示，避免浮点误差 */
export function centsToDb(cents: number): string {
  const neg = cents < 0
  const abs = Math.abs(cents)
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** 分 → 显示文本，如 1,234.50；sign=true 时正数带 + */
export function fmtYuan(cents: number, opts: { sign?: boolean; symbol?: boolean } = {}): string {
  const neg = cents < 0
  const abs = Math.abs(cents)
  const int = Math.floor(abs / 100).toLocaleString('en-US')
  const dec = String(abs % 100).padStart(2, '0')
  const body = `${opts.symbol ? '¥' : ''}${int}.${dec}`
  if (neg) return `-${body}`
  return opts.sign && cents > 0 ? `+${body}` : body
}

/** 分 → 四舍五入到元、千分位、带 ¥，如 25425 → 「¥254」、-500 → 「-¥5」。趋势卡的「日均」用 */
export function fmtYuanWhole(cents: number): string {
  const yuan = Math.round(Math.abs(cents) / 100)
  const body = `¥${yuan.toLocaleString('en-US')}`
  return cents < 0 && yuan > 0 ? `-${body}` : body
}

/** 分 → 元的数字（12.3），给助手的工具结果用：AI 读的是元。只在这里换算 */
export function yuanNumber(cents: number): number {
  return Number(centsToDb(cents))
}

/**
 * 助手给的金额（元）→ 分。严格：只认正数、最多两位小数、不超过 1 亿元；
 * 数字带浮点尾巴（22.799999999）只在离两位小数不到 1e-6 时认；字符串只认「12」「12.5」「1,234.56」（可带 ¥ / 元）。
 * 空串、0、负数、科学计数法、0x10 这类一律 null——宁可让用户在卡片上自己填，也不悄悄记成 0
 */
export function parseAiYuan(v: unknown): number | null {
  let s: string
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null
    const r = Math.round(v * 100) / 100
    if (Math.abs(r - v) > 1e-6) return null
    s = r.toFixed(2)
  } else if (typeof v === 'string') {
    s = v.trim().replace(/^¥/, '').replace(/元$/, '').replace(/,/g, '')
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return null
  } else return null
  const c = parseYuan(s)
  return c !== null && c > 0 && c <= 10_000_000_000 ? c : null
}

/**
 * 分 → 日历格子里那种短写：不带 ¥、不带千分位、整数元，上万写「1.2万」（「2万」不写成「2.0万」）。
 * 不到 1 元的保留小数（0.5 元写「0.5」，别四舍五入成「1」或「0」）。只看大小，正负号由调用方加
 */
export function fmtShortYuan(cents: number): string {
  const abs = Math.abs(cents)
  if (abs >= 1000000) return `${(abs / 1000000).toFixed(1).replace(/\.0$/, '')}万`
  if (abs < 100) return yuanPlain(abs)
  return String(Math.round(abs / 100))
}

/** 分 → 不带千分位、去掉末尾零的元，如 1250 → 「12.5」、10000 → 「100」。给输入框回填和筛选标签用 */
export function yuanPlain(cents: number): string {
  const s = centsToDb(cents)
  return s.endsWith('.00') ? s.slice(0, -3) : s.endsWith('0') ? s.slice(0, -1) : s
}

/**
 * 余额核对的那条算式：差额 = 实际余额 − 推算余额。
 * @param input          用户输入的实际余额（元，字符串）
 * @param computedCents  由流水推算出来的余额（分）
 * @returns 差额（分）；input 解析不出金额时返回 null，页面据此把按钮置灰。
 *
 * 抽在这里是因为页面（Accounts.tsx）跑在浏览器里，node 单测没有 DOM 进不去；
 * 算式留在页面里就等于没人看着它。
 */
export function calcDelta(input: string, computedCents: number): number | null {
  const real = parseYuan(input)
  if (real === null) return null
  return real - computedCents
}
