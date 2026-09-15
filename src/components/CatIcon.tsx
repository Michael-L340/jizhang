import { artUrl, imgKey, isImgIcon } from '../lib/art'

interface Props {
  /** 分类的 icon 字段：emoji、`img:<名字>`，或者没设 */
  icon: string | null | undefined
  /** 图片的边长（px）。emoji 不看它，字号由调用方的 className 决定 */
  size?: number
  className?: string
  /** 没有图标、或者图片找不到时显示的文字 */
  fallback?: string
}

/**
 * 分类图标。全 App 渲染 category.icon 的唯一出口。
 *
 * icon 是 text 列，既可能是 emoji 也可能是 `img:<名字>`（用户自己生成的 3D PNG）。
 * 两种写法的排版差得远——emoji 是一个字，图片得给宽高——所以不能在每个页面各判一次，
 * 漏掉一处的表现是页面上明晃晃地写着「img:lunch」。
 *
 * 图片指到登记表里没有的 key 时退回 fallback：icon 是从云端拉回来的，
 * 哪天把一张图从 art.ts 里撤掉，老数据还指着它，不能让整页白屏。
 */
export function CatIcon({ icon, size = 24, className = '', fallback = '' }: Props) {
  if (isImgIcon(icon)) {
    const url = artUrl(imgKey(icon) ?? '')
    if (url) {
      return (
        <img
          src={url}
          width={size}
          height={size}
          alt=""
          aria-hidden
          className={`shrink-0 ${className}`}
          style={{ width: size, height: size, objectFit: 'contain', display: 'block' }}
        />
      )
    }
    return <span className={className}>{fallback}</span>
  }
  return <span className={className}>{icon || fallback}</span>
}
