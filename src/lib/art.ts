// 「我的图」——用户自己用 AI 生成的 3D 图标。
//
// 为什么不直接把文件名存进 categories.icon：分类的 icon 是 text 列，存什么都能存，
// 但存死文件名之后换一版图（bag-v1 → bag-v2）就得去改每一条历史数据。
// 所以库里存的是 `img:<key>`，key → 文件名的对应只在这张登记表里，换图只改一行。
//
// 文件名必须带 -vN：图片不像 JS 那样自动带哈希，名字不变的话 Safari 会一直用缓存里那张，
// 连「从主屏删掉再重新添加」都救不回来（AccountIcon 的品牌图上实测过）。换图时把后缀 +1，
// 别原地覆盖——art.test.ts 守着这条命名。

export interface ArtIcon {
  /** 存进数据库的稳定标识，换图不变 */
  key: string
  /** 面板里用不到（图本身就是标签），留着给无障碍和以后的搜索 */
  name: string
  /** public/art/ 下的文件名，带 -vN */
  file: string
}

export const ART: ArtIcon[] = [
  { key: 'bag', name: '购物袋', file: 'bag-v1.png' },
  { key: 'breakfast', name: '早餐', file: 'breakfast-v1.png' },
  { key: 'lunch', name: '午餐', file: 'lunch-v1.png' },
  { key: 'dinner', name: '晚餐', file: 'dinner-v1.png' },
  // 下面三张原本打算放登录页和空状态当插画，用户 2026-09-15 说那几页保持纯文字、
  // 图留着收进「我的图」——所以它们和上面四张一样，只在选图标面板里出现
  { key: 'wallet', name: '钱包', file: 'wallet-v1.png' },
  { key: 'bill', name: '账单', file: 'bill-v1.png' },
  { key: 'receipt', name: '小票', file: 'receipt-v1.png' },
]

const PREFIX = 'img:'

const BY_KEY = new Map(ART.map((a) => [a.key, a]))

/**
 * 图片的 URL。路径要带 BASE_URL：GitHub Pages 部署在 /jizhang/ 子目录下，
 * 写死 `/art/...` 在线上会 404。
 * 登记表里没有这个 key 就返回 null——icon 是从云端拉回来的，删过一张图之后
 * 老数据还指着它，调用方拿 null 退回文字，别让整页崩掉。
 */
export function artUrl(key: string): string | null {
  const a = BY_KEY.get(key)
  return a ? `${import.meta.env.BASE_URL}art/${a.file}` : null
}

/** icon 字段存的是不是一张图 */
export function isImgIcon(icon: string | null | undefined): boolean {
  return typeof icon === 'string' && icon.startsWith(PREFIX)
}

/** 从 `img:bag` 取出 bag；不是图片就返回 null */
export function imgKey(icon: string | null | undefined): string | null {
  return isImgIcon(icon) ? (icon as string).slice(PREFIX.length) : null
}

/** bag → `img:bag` */
export function toImgIcon(key: string): string {
  return PREFIX + key
}
