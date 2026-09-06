// 账户图标。品牌标志路径来源：
//   微信 / 支付宝 —— simple-icons（图标路径以 CC0 发布）
//   中国银行 / 招商银行 —— icongo/bank-logos（MIT），只取其中 fill 为品牌红的那一条路径，
//     舍弃 fill='#231815'（近黑）的中文字样。
//     招行那条红色路径里，圆圈右侧那六条横线是标志本身的一部分（红圆 + 白色 M +
//     右侧横向渐变条），2026-09-04 两次误判：先当成中文残留裁掉，又因为一次被截断的
//     网络抓取以为官方没有。以实物为准：**必须保留**。
// 商标归各品牌所有，此处仅用于个人记账中标识自己的账户。
//
// 四个图标的底板统一是圆形、统一直径，图形本身都填满各自的 viewBox，
// 所以同一个 scale 下渲染出来一样大。
//
// 配色方向：四个都是「品牌色底 + 白色标」，由用户 2026-09-04 拍板。
//   银行的官方形象其实是白底红标，做成红底白标等于负片；但四个图标并排时统一更重要，
//   用户看过两个版本后选了统一。plate: 'light'（白底品牌色标）保留着，改一个字就能换回去。
// 浅色底板要加一道极淡的边，否则在白色卡片上会看不见边界。
interface Props {
  name: string
  size?: number
}

interface Brand {
  /** 品牌色。图表里的线和圆点也用它 */
  color: string
  /** brand = 品牌色底 + 白色标；light = 白底 + 品牌色标 */
  plate: 'brand' | 'light'
  viewBox: string
  path: string
  /** 标记相对整个图标的占比。四个品牌都在 0.58~0.6，看起来才一样大 */
  scale: number
  /** 标记本身的颜色。默认 brand 底板上是白色；美团黄底配白字看不清，官方就是黑标 */
  fg?: string
  /** 位图图标（App Store 官方图标裁圆）。有它时 path / viewBox 不用 */
  image?: string
  /** 完全自绘的图标（花呗：渐变底 + 开口圆环），有它时其他字段不用 */
  render?: (size: number) => React.ReactNode
}

// 白条平台用 App Store 上的官方图标（位图，128px，裁成圆）。开源图标库里这几家只有线条画，
// 用户 2026-09-06 看过之后要的是主屏上那个样子。文件名带 -vN，换图时改名，不然 Safari 会用旧缓存。
// 路径要带 BASE_URL：GitHub Pages 部署在 /jizhang/ 子目录下。
const brandImg = (file: string) => `${import.meta.env.BASE_URL}brand/${file}`
const JD: Brand = { color: '#e1251b', plate: 'brand', scale: 1, viewBox: '0 0 1 1', path: '', image: brandImg('jd-v1.png') }
const PDD: Brand = { color: '#e02e24', plate: 'brand', scale: 1, viewBox: '0 0 1 1', path: '', image: brandImg('pdd-v1.png') }
const MEITUAN_APP: Brand = { color: '#ffc300', plate: 'brand', scale: 1, viewBox: '0 0 1 1', path: '', image: brandImg('meituan-v1.png') }
// 花呗没有独立 App、也没有开源矢量版，照用户发的截图手绘：蓝色渐变圆底 + 白色开口圆环 + 右上一个小点
const HUABEI: Brand = {
  color: '#1d7cf7',
  plate: 'brand',
  scale: 1,
  viewBox: '0 0 48 48',
  path: '',
  render: (size) => (
    <svg width={size} height={size} viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <defs>
        <linearGradient id="hb-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#38a6ff" />
          <stop offset="1" stopColor="#0a5ff0" />
        </linearGradient>
      </defs>
      <circle cx="24" cy="24" r="24" fill="url(#hb-grad)" />
      <path d="M35.95 24.95 A12 12 0 1 1 25.05 14.05" fill="none" stroke="#fff" strokeWidth="5.6" strokeLinecap="round" />
      <circle cx="35.67" cy="14.33" r="2.9" fill="#fff" />
    </svg>
  ),
}

const WECHAT: Brand = { color: '#07C160', plate: 'brand', scale: 0.6, viewBox: '0 0 24 24', path: 'M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z' }
const ALIPAY: Brand = { color: '#1677FF', plate: 'brand', scale: 0.58, viewBox: '0 0 24 24', path: 'M19.695 15.07c3.426 1.158 4.203 1.22 4.203 1.22V3.846c0-2.124-1.705-3.845-3.81-3.845H3.914C1.808.001.102 1.722.102 3.846v16.31c0 2.123 1.706 3.845 3.813 3.845h16.173c2.105 0 3.81-1.722 3.81-3.845v-.157s-6.19-2.602-9.315-4.119c-2.096 2.602-4.8 4.181-7.607 4.181-4.75 0-6.361-4.19-4.112-6.949.49-.602 1.324-1.175 2.617-1.497 2.025-.502 5.247.313 8.266 1.317a16.796 16.796 0 0 0 1.341-3.302H5.781v-.952h4.799V6.975H4.77v-.953h5.81V3.591s0-.409.411-.409h2.347v2.84h5.744v.951h-5.744v1.704h4.69a19.453 19.453 0 0 1-1.986 5.06c1.424.52 2.702 1.011 3.654 1.333m-13.81-2.032c-.596.06-1.71.325-2.321.869-1.83 1.608-.735 4.55 2.968 4.55 2.151 0 4.301-1.388 5.99-3.61-2.403-1.182-4.438-2.028-6.637-1.809' }
const BOC: Brand = { color: '#B81C22', plate: 'brand', scale: 0.6, viewBox: '0.00 367.60 288.80 288.70', path: 'M144.4 367.6c79.7 0 144.4 64.6 144.4 144.3s-64.6 144.4-144.4 144.4S0 591.7 0 512c0-79.7 64.6-144.4 144.4-144.4zM31.6 512c0 56.2 41.4 103.8 97 111.7v-53h-24.8c-16.2 0-29.3-13.1-29.3-29.3v-58.7c0-16.2 13.1-29.3 29.3-29.3h24.8v-53c-55.7 7.8-97 55.4-97 111.6z m128.5-111.7v53H185c16.2 0 29.3 13.2 29.3 29.3v58.6c0 16.2-13.1 29.3-29.3 29.4h-24.9v53c61.7-8.7 104.6-65.8 95.9-127.5-7-49.7-46.1-88.8-95.9-95.8z m18.1 84.6h-67.7c-2.4 0-4.4 1.9-4.5 4.3v45.3c0 2.4 1.9 4.4 4.3 4.5h67.9c2.4 0 4.4-1.9 4.5-4.3v-45.3c0-2.4-2-4.5-4.5-4.5z' }
const CMB: Brand = { color: '#E50113', plate: 'brand', scale: 0.6, viewBox: '0.00 389.00 246.00 245.90', path: 'M119.8 389l-3.1 0.3-6.2 0.3-6.2 0.8-3.1 0.6-3.1 0.6-2.8 0.6-3.1 0.8-5.7 1.7-5.7 1.7-5.7 2.3-5.4 2.5-5.2 2.8-2.6 1.4-2.5 1.4-2.6 1.7-2.5 1.4-4.8 3.7-2.3 1.7-2.5 1.7-4.2 4-4.2 4.2-2.3 2-2 2.3-2 2-2 2.3-3.4 4.8-3.7 4.8-3.1 5.1-1.4 2.6-1.4 2.3-2.8 5.4-2.5 5.4-2 5.7-2 5.7-1.7 5.5-1.4 5.9-1.1 6.2-0.9 6.2-0.3 6.2L0 512v3.1l0.3 3.1 0.3 6.5 0.9 5.9 0.6 3.1 0.6 3.1 0.6 2.8 0.8 3.1 1.7 5.7 2 5.9 2 5.4 2.5 5.7 2.8 5.1 1.4 2.8 1.4 2.5 1.7 2.5 1.4 2.3 3.7 4.8 1.7 2.5 1.7 2.3 4 4.5 4.2 4.2 2 2 2.3 2 2 2 2.3 2 4.8 3.7 4.8 3.4 5.1 3.1 2.5 1.4 2.6 1.7 5.4 2.5 5.4 2.5 5.7 2.3 5.7 2 5.7 1.4 5.9 1.4 6.2 1.1 6.2 0.9 6.2 0.6h11.3l4.8-0.3 4.8-0.6 2.5-0.3 2.3-0.3 4.8-0.8 4.5-1.1 4.8-1.1 4.5-1.4 4.3-1.7 4.5-1.7 4.2-1.7 4.3-2 4.2-2.3 4-2.3 4-2.5 3.7-2.6 3.7-2.8 3.7-2.8 3.4-3.1 3.4-3.1 3.4-3.4 3.1-3.1 3.1-3.7 2.8-3.7 2.6-3.7 2.8-3.7 2.3-4 2.5-4.2 2-4 2-4.2 2-4.2 1.7-4.5h-17.2l2.6 5.9-26.6 38.7H52L23.5 563l62.8-162 35.5 85 33.9-85.7 32.5 76h52.6l-1.7-4.5-1.7-4.8-1.7-4.5-2.3-4.2-2-4.5-2.6-4.2-2.5-4-2.5-4-3.1-4-1.4-2-1.4-2-3.1-3.7-3.4-3.4-3.4-3.4-3.7-3.4-3.7-3.1-3.7-2.8-4-2.8-4-2.8-4.2-2.5-4.2-2.3-4.2-2.3-4.5-2-4.5-2-2.3-0.8-2.3-0.9-4.7-1.3-4.8-1.4-4.8-1.1-5.1-0.8-4.8-0.9-5.1-0.3-5.4-0.6h-8.2z m-7 172.7h68.1l-34.8-84.2-33.3 84.2z m-69.8 0h68.1l-34.8-84.2L43 561.7z m148.1-78.6l2.3 5.1h50.3l-1.1-5.1h-51.5z m5.1 11.9l2 5.1h47.2l-0.6-5.1h-48.6z m5.1 11.9l2 5.1H246v-5.1h-44.7z m4.8 11.8l2.3 5.1h37l0.6-5.1h-39.9z m5 11.9l2.3 5.1h30.2l0.9-5.1h-33.4z m5.1 11.9l2.3 4.8h22.3l1.4-4.8h-26z' }

// 通用兜底：银行卡 / 钱包
const GENERIC_BANK: Brand = {
  color: '#3f5c8c',
  plate: 'brand',
  scale: 0.56,
  viewBox: '0 0 24 24',
  path: 'M2.5 9.6 12 4l9.5 5.6v1.4H2.5V9.6ZM5 13h2v5H5v-5Zm4 0h2v5H9v-5Zm4 0h2v5h-2v-5Zm4 0h2v5h-2v-5ZM2.5 19.4h19V21h-19v-1.6Z',
}
const GENERIC_WALLET: Brand = {
  color: '#7a808c',
  plate: 'brand',
  scale: 0.56,
  viewBox: '0 0 24 24',
  path: 'M4 6h13a2 2 0 0 1 2 2v1h-2.5a3 3 0 0 0 0 6H21v3a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Zm12.5 5H22v2h-5.5a1 1 0 0 1 0-2Z',
}

// 白条 / 先用后付：统一用一张卡的形状，只换平台色。两段矩形中间留一道空隙当磁条，
// 用底色透出来，不用第二种颜色。
const GENERIC_CREDIT: Brand = {
  color: '#8a6026',
  plate: 'brand',
  scale: 0.56,
  viewBox: '0 0 24 24',
  path: 'M2 6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v1.5H2V6Zm0 4.5h20V18a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-7.5Zm3 4h6v1.8H5v-1.8Z',
}

/** 全部品牌，供测试逐个检查形状与大小是否统一 */
export const BRANDS: Record<string, Brand> = { WECHAT, ALIPAY, BOC, CMB, GENERIC_BANK, GENERIC_WALLET, GENERIC_CREDIT }

export function brandOf(name: string): Brand {
  const n = name.trim()
  if (n.includes('微信')) return WECHAT
  if (n.includes('支付宝')) return ALIPAY
  if (n.includes('招商') || n.includes('招行')) return CMB
  if (n.includes('中国银行') || n.includes('中行')) return BOC
  if (n.includes('工商') || n.includes('工行')) return { ...GENERIC_BANK, color: '#c8102e' }
  if (n.includes('建设') || n.includes('建行')) return { ...GENERIC_BANK, color: '#004a95' }
  if (n.includes('农业') || n.includes('农行')) return { ...GENERIC_BANK, color: '#009944' }
  if (n.includes('交通') || n.includes('交行')) return { ...GENERIC_BANK, color: '#005bac' }
  if (n.includes('邮储') || n.includes('邮政')) return { ...GENERIC_BANK, color: '#00703c' }
  // 白条平台要排在「卡 / 信用」那条之前，否则「信用购」之类会落到银行图标
  if (n.includes('京东')) return JD
  if (n.includes('花呗')) return HUABEI
  if (n.includes('拼多多')) return PDD
  if (n.includes('美团')) return MEITUAN_APP
  if (n.includes('白条') || n.includes('分期') || n.includes('月付') || n.includes('先用后付')) return GENERIC_CREDIT
  if (n.includes('银行') || n.includes('卡') || n.includes('信用')) return GENERIC_BANK
  if (n.includes('现金')) return { ...GENERIC_WALLET, color: '#f5a524' }
  return GENERIC_WALLET
}

export function AccountIcon({ name, size = 40 }: Props) {
  const b = brandOf(name)
  if (b.render) return <span className="inline-flex shrink-0">{b.render(size)}</span>
  if (b.image) {
    return <img src={b.image} width={size} height={size} alt="" className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />
  }
  const light = b.plate === 'light'
  const inner = size * b.scale
  return (
    <span
      className="inline-flex items-center justify-center shrink-0"
      style={{
        width: size,
        height: size,
        background: light ? '#fff' : b.color,
        borderRadius: '50%',
        // 白底在白卡片上会糊成一片，加一道极淡的边把轮廓交代清楚
        boxShadow: light ? 'inset 0 0 0 1px rgba(0,0,0,.09)' : undefined,
      }}
      aria-hidden
    >
      <svg width={inner} height={inner} viewBox={b.viewBox} fill={light ? b.color : b.fg ?? '#fff'} xmlns="http://www.w3.org/2000/svg">
        <path d={b.path} />
      </svg>
    </span>
  )
}

/** 账户主题色，给图表和圆点用。始终是品牌色，和底板是深是浅无关 */
export function accountColor(name: string): string {
  return brandOf(name).color
}
