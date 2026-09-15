// 守的是「图标真的居中」。
//
// 白条圆标先后用过系统 emoji 💳（两次被用户指出没居中）和自绘 SVG（几何上居中，但
// 用户后来要换成自己生成的 3D 图）。位图没有几何可以断言，只能读回像素来量：
// 不透明像素的外接框中心 = 画布中心。切图脚本 scripts/cut-art.py 负责做到，这里负责验。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { alphaBounds, decodePng, encodePng, type Png } from './png'

const PUBLIC = join(__dirname, '../../public')

/** 画一张 size×size、正中偏 (dx, dy) 处有个 w×h 实心块的图 */
function blockPng(size: number, w: number, h: number, dx = 0, dy = 0, alpha = 255): Png {
  const rgba = new Uint8Array(size * size * 4)
  const x0 = Math.round((size - w) / 2 + dx)
  const y0 = Math.round((size - h) / 2 + dy)
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * size + x) * 4
      rgba[i] = 200
      rgba[i + 1] = 120
      rgba[i + 2] = 40
      rgba[i + 3] = alpha
    }
  return { width: size, height: size, rgba }
}

/** 偏差的容差：外接框宽高为偶数时中心落在 .5 上，画布中心也是 .5，所以真居中是 0；留 1px 给取整 */
const TOL = 1

function offset(png: Png): { dx: number; dy: number } {
  const b = alphaBounds(png)
  if (!b) throw new Error('整张图都是透明的')
  const mid = (png.width - 1) / 2
  return { dx: b.cx - mid, dy: b.cy - ((png.height - 1) / 2) }
}

describe('PNG 读写', () => {
  it('编码再解码，像素一个不差', () => {
    const src = blockPng(16, 6, 4, 1, -2)
    const back = decodePng(encodePng(src))
    expect([back.width, back.height]).toEqual([16, 16])
    expect(Buffer.from(back.rgba).equals(Buffer.from(src.rgba))).toBe(true)
  })

  it('能读 PIL 写出来的带过滤的真实文件', () => {
    // 真实文件每行的 filter 不是 0，五种过滤都可能出现；解错任何一种，像素就是垃圾，
    // 外接框会量到整张图。用「框比画布小」来兜这一点。
    const png = decodePng(readFileSync(join(PUBLIC, 'brand/credit-v1.png')))
    expect([png.width, png.height]).toEqual([256, 256])
    const b = alphaBounds(png)!
    expect(b.left).toBeGreaterThan(0)
    expect(b.right).toBeLessThan(255)
  })
})

describe('居中检查本身靠得住', () => {
  it('正中的块，偏差为 0', () => {
    expect(offset(blockPng(64, 20, 10))).toEqual({ dx: 0, dy: 0 })
  })

  it('故意偏 4px 的块，能量出 4px——否则下面对真实文件的断言就是摆设', () => {
    expect(offset(blockPng(64, 20, 10, 4, 0)).dx).toBe(4)
    expect(offset(blockPng(64, 20, 10, 0, -3)).dy).toBe(-3)
  })

  it('几乎透明的残留不算图形——ChatGPT 抠图留的那圈黑边就是这种', () => {
    // 正中一个实心块，左上角远处再放一块 alpha=10 的「脏」像素
    const png = blockPng(64, 20, 10)
    png.rgba[(2 * 64 + 2) * 4 + 3] = 10
    expect(offset(png)).toEqual({ dx: 0, dy: 0 })
    // 门槛以上就要算：同一个位置 alpha 提到 30，框被拉到左上角
    png.rgba[(2 * 64 + 2) * 4 + 3] = 30
    expect(offset(png).dx).toBeLessThanOrEqual(-10)
  })
})

describe('仓库里的位图图标都居中', () => {
  // 白条分组的圆标 + 分类图标 / 空状态插画。四家白条平台的官方图标是裁圆的实心图，
  // 铺满整个圆，没有「居中」可言，不在这里。
  const files = [
    'brand/credit-v1.png',
    ...(existsSync(join(PUBLIC, 'art')) ? readdirSync(join(PUBLIC, 'art')) : []).filter((f) => f.endsWith('.png')).map((f) => `art/${f}`),
  ]

  it('白条圆标必须在列表里', () => {
    expect(files).toContain('brand/credit-v1.png')
  })

  for (const f of files) {
    it(`${f} 的外接框中心落在画布中心（±${TOL}px）`, () => {
      const png = decodePng(readFileSync(join(PUBLIC, f)))
      expect(png.width, '必须是正方形').toBe(png.height)
      const { dx, dy } = offset(png)
      expect(Math.abs(dx), `横向偏了 ${dx}px`).toBeLessThanOrEqual(TOL)
      expect(Math.abs(dy), `竖向偏了 ${dy}px`).toBeLessThanOrEqual(TOL)
      // 四周要留一点空，贴边的图缩到 40px 圆里会被圆切掉一角
      const b = alphaBounds(png)!
      const pad = Math.min(b.left, b.top, png.width - 1 - b.right, png.height - 1 - b.bottom)
      expect(pad, '图形贴到画布边了').toBeGreaterThanOrEqual(png.width * 0.02)
    })
  }
})
