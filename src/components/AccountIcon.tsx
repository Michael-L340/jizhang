// 四个账户的图标。按名称匹配；改了账户名也能靠关键词命中，都不命中就用通用钱包图标。
interface Props {
  name: string
  size?: number
}

interface Style {
  bg: string
  fg: string
  path: string
  round?: boolean
}

const BANK_PATH = 'M3 9.5L12 4l9 5.5M5 10v8m4-8v8m6-8v8m4-8v8M3 20h18'
const WALLET_PATH = 'M3 8a2 2 0 012-2h12a2 2 0 012 2M3 8v10a2 2 0 002 2h14a2 2 0 002-2v-3M3 8h16a2 2 0 012 2v3M17 13.5h.01'
const ALIPAY_PATH = 'M4 15c2.6-1.2 6.4-2.2 9.2-1 2.3 1 4 2.6 5.1 4M7 6h10M12 4v7M6.5 11h11'
const WECHAT_PATH = 'M9 4C5.1 4 2 6.6 2 9.8c0 1.8 1 3.4 2.6 4.5L4 17l2.6-1.3c.8.2 1.6.3 2.4.3M22 15c0-2.8-2.7-5-6-5s-6 2.2-6 5 2.7 5 6 5c.7 0 1.4-.1 2-.3L21 21l-.6-2c1-.8 1.6-1.9 1.6-3z'

function styleOf(name: string): Style {
  const n = name.trim()
  if (n.includes('微信')) return { bg: '#07c160', fg: '#fff', path: WECHAT_PATH, round: true }
  if (n.includes('支付宝')) return { bg: '#1677ff', fg: '#fff', path: ALIPAY_PATH, round: true }
  if (n.includes('招商')) return { bg: '#c7000b', fg: '#fff', path: BANK_PATH }
  if (n.includes('中国银行') || n.includes('中行')) return { bg: '#b01c2e', fg: '#fff', path: BANK_PATH }
  if (n.includes('工商') || n.includes('工行')) return { bg: '#c8102e', fg: '#fff', path: BANK_PATH }
  if (n.includes('建设') || n.includes('建行')) return { bg: '#004a95', fg: '#fff', path: BANK_PATH }
  if (n.includes('农业') || n.includes('农行')) return { bg: '#009944', fg: '#fff', path: BANK_PATH }
  if (n.includes('交通') || n.includes('交行')) return { bg: '#005bac', fg: '#fff', path: BANK_PATH }
  if (n.includes('邮储') || n.includes('邮政')) return { bg: '#00703c', fg: '#fff', path: BANK_PATH }
  if (n.includes('银行') || n.includes('卡')) return { bg: '#3f5c8c', fg: '#fff', path: BANK_PATH }
  if (n.includes('现金')) return { bg: '#f5a524', fg: '#fff', path: WALLET_PATH, round: true }
  return { bg: '#7a808c', fg: '#fff', path: WALLET_PATH, round: true }
}

export function AccountIcon({ name, size = 40 }: Props) {
  const s = styleOf(name)
  return (
    <span
      className="inline-flex items-center justify-center shrink-0"
      style={{ width: size, height: size, background: s.bg, borderRadius: s.round ? '50%' : size * 0.28 }}
      aria-hidden
    >
      <svg width={size * 0.56} height={size * 0.56} viewBox="0 0 24 24" fill="none" stroke={s.fg} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d={s.path} />
      </svg>
    </span>
  )
}

/** 账户主题色，给图表和圆点用 */
export function accountColor(name: string): string {
  return styleOf(name).bg
}
