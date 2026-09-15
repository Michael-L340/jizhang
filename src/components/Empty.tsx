// 空状态 / 登录页的插画。用户 2026-09-15 用 AI 生成的焦糖 3D 图，和 App 图标一个味。
// 以前这几处只有一行灰字，页面像没加载完。
//
// 这几张细节多，缩到 40px 会糊，所以只当 90–140px 的插画用，不进分类图标库
// （分类图标那套走 lib/art.ts + CatIcon）。文件名带 -vN，换图改后缀，别原地覆盖（Safari 缓存）。
// 路径要带 BASE_URL：GitHub Pages 部署在 /jizhang/ 子目录下。
export const ILLUSTRATIONS = {
  /** 钱包 + 硬币：登录页 */
  wallet: 'wallet-v1.png',
  /** 账单 + 饼图：本月还没有支出 */
  bill: 'bill-v1.png',
  /** 小票 + ¥：还没有流水 */
  receipt: 'receipt-v1.png',
} as const

export type Illustration = keyof typeof ILLUSTRATIONS

export function illustrationUrl(name: Illustration): string {
  return `${import.meta.env.BASE_URL}art/${ILLUSTRATIONS[name]}`
}

interface Props {
  art: Illustration
  text: string
  size?: number
  className?: string
}

export function Empty({ art, text, size = 88, className = '' }: Props) {
  return (
    <div className={`flex flex-col items-center gap-1.5 text-center ${className}`} aria-live="polite">
      <img src={illustrationUrl(art)} width={size} height={size} alt="" aria-hidden className="select-none" style={{ width: size, height: size }} />
      <div className="text-sm text-muted">{text}</div>
    </div>
  )
}
