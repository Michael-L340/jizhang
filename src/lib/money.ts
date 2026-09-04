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
