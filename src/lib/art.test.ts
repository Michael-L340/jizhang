// 「我的图」登记表。守的是三件事：key 不重、文件名带版本号、`img:` 编码能往返。
//
// 每条用例都先证明过会红（变异法，写在各自的注释里）。
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ART, artUrl, imgKey, isImgIcon, toImgIcon } from './art'

const PUBLIC_ART = join(__dirname, '../../public/art')

describe('我的图登记表', () => {
  // 变异：把 dinner 的 key 改成 'lunch' → 红
  it('key 不能重——key 是存进数据库的那一份，重了就有一张图永远选不中', () => {
    const keys = ART.map((a) => a.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  // 变异：把 file 改成 'bag.png'（去掉 -v1）→ 红
  it('文件名必须带 -vN：不带版本号的话换图之后 Safari 一直用缓存里那张，删掉重装都救不回来', () => {
    for (const a of ART) expect(a.file, `${a.key} 的文件名 ${a.file}`).toMatch(/-v\d+\.png$/)
  })

  // 变异：把 file 改成 'bag-v2.png'（仓库里没有这个文件）→ 红
  it('登记的每个文件都真的在 public/art/ 里——写错一个字母，线上就是一张裂图', () => {
    for (const a of ART) expect(existsSync(join(PUBLIC_ART, a.file)), `缺少 public/art/${a.file}`).toBe(true)
  })

  // 变异：把 artUrl 里的模板串改成 `/art/${a.file}`（丢掉 BASE_URL）→ 红
  it('URL 带上 BASE_URL：线上部署在 /jizhang/ 子目录，写死 /art/... 会 404', () => {
    // 测试环境里 BASE_URL 是 '/'（vite.config.ts 没设 base，VITE_BASE 只在 deploy 时给）
    expect(import.meta.env.BASE_URL).toBe('/')
    expect(artUrl('bag')).toBe('/art/bag-v1.png')
  })

  // 变异：让 artUrl 在找不到时返回 `${BASE_URL}art/undefined` 而不是 null → 红
  it('登记表里没有的 key 返回 null——icon 是从云端拉回来的，撤掉一张图之后老数据还指着它', () => {
    expect(artUrl('没有这张图')).toBeNull()
  })
})

describe('img: 前缀', () => {
  // 变异：把 toImgIcon 的前缀写成 'image:' → 红（imgKey 认的还是 'img:'）
  it('编码再解码，拿回原来的 key', () => {
    for (const a of ART) {
      const stored = toImgIcon(a.key)
      expect(isImgIcon(stored)).toBe(true)
      expect(imgKey(stored)).toBe(a.key)
      expect(artUrl(imgKey(stored) as string)).toContain(a.file)
    }
  })

  // 变异：把 isImgIcon 的 startsWith 换成 includes → 红（'午餐img:x' 会被当成图片）
  it('只认开头的 img:，emoji 和普通文字都不是图片', () => {
    expect(isImgIcon('🍚')).toBe(false)
    expect(isImgIcon('')).toBe(false)
    expect(isImgIcon(null)).toBe(false)
    expect(isImgIcon(undefined)).toBe(false)
    expect(isImgIcon('午餐img:bag')).toBe(false)
    expect(imgKey('🍚')).toBeNull()
  })

  // 变异：把 imgKey 的 slice(PREFIX.length) 改成 slice(3) → 红（会多带一个冒号）
  it('key 里带冒号也不会被切坏', () => {
    expect(imgKey('img:a:b')).toBe('a:b')
    expect(imgKey('img:')).toBe('')
  })
})
