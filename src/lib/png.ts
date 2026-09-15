// 最小 PNG 读写：只为了在单测里量「图形有没有居中」。
//
// 账户图标、分类图标、空状态插画都是用户用 AI 生成的透明底 PNG，切图脚本
// （scripts/cut-art.py）负责按实心像素的外接框居中。但脚本是人手跑的，跑错参数、
// 拿错文件都不会报错——所以产物要再验一遍：读回 PNG，量 alpha 通道的外接框，
// 中心必须落在画布中心。这里不引第三方库（pngjs 之类为了一个测试不值得），
// 只支持 8 位 RGB / RGBA、不隔行——PIL 默认输出就是这样。
//
// 顺带一个编码器，让测试能造出「故意偏了 4px」的图来证明检查真的会红。
import { deflateSync, inflateSync } from 'node:zlib'

export interface Png {
  width: number
  height: number
  /** 每像素 4 字节 RGBA，逐行 */
  rgba: Uint8Array
}

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export function decodePng(buf: Uint8Array): Png {
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) throw new Error('不是 PNG')
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let pos = 8
  let width = 0
  let height = 0
  let channels = 0
  const idat: Uint8Array[] = []
  while (pos < buf.length) {
    const len = dv.getUint32(pos)
    const type = String.fromCharCode(...buf.subarray(pos + 4, pos + 8))
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = dv.getUint32(pos + 8)
      height = dv.getUint32(pos + 12)
      const depth = buf[pos + 16]
      const color = buf[pos + 17]
      const interlace = buf[pos + 20]
      if (depth !== 8) throw new Error(`只支持 8 位，这张是 ${depth} 位`)
      if (color !== 6 && color !== 2) throw new Error(`只支持 RGB/RGBA，这张的 color type 是 ${color}`)
      if (interlace !== 0) throw new Error('不支持隔行 PNG')
      channels = color === 6 ? 4 : 3
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (!width || !channels) throw new Error('缺 IHDR')
  const raw = inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d))))
  const stride = width * channels
  const out = new Uint8Array(width * height * 4)
  const prev = new Uint8Array(stride)
  const cur = new Uint8Array(stride)
  let p = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]
    for (let i = 0; i < stride; i++) {
      const x = raw[p++]
      const a = i >= channels ? cur[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      let v: number
      switch (filter) {
        case 0: v = x; break
        case 1: v = x + a; break
        case 2: v = x + b; break
        case 3: v = x + ((a + b) >> 1); break
        case 4: {
          const pp = a + b - c
          const pa = Math.abs(pp - a)
          const pb = Math.abs(pp - b)
          const pc = Math.abs(pp - c)
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default: throw new Error(`未知的 filter ${filter}`)
      }
      cur[i] = v & 0xff
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels
      const d = (y * width + x) * 4
      out[d] = cur[s]
      out[d + 1] = cur[s + 1]
      out[d + 2] = cur[s + 2]
      out[d + 3] = channels === 4 ? cur[s + 3] : 255
    }
    prev.set(cur)
  }
  return { width, height, rgba: out }
}

let crcTable: Uint32Array | null = null
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** 8 位 RGBA、不过滤、不隔行。只给测试造图用 */
export function encodePng(png: Png): Uint8Array {
  const { width, height, rgba } = png
  const raw = new Uint8Array((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1)
  }
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, width)
  dv.setUint32(4, height)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([Buffer.from(SIG), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))])
}

export interface Bounds {
  left: number
  top: number
  right: number
  bottom: number
  /** 外接框中心 */
  cx: number
  cy: number
}

/**
 * 不透明像素的外接框。alpha 低于 floor 的当透明——切图脚本已经把 <24 的残留清掉了，
 * 这里用同一个门槛，量的才是同一个框。空图返回 null。
 */
export function alphaBounds(png: Png, floor = 24): Bounds | null {
  let left = Infinity
  let top = Infinity
  let right = -1
  let bottom = -1
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (png.rgba[(y * png.width + x) * 4 + 3] < floor) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  if (right < 0) return null
  return { left, top, right, bottom, cx: (left + right) / 2, cy: (top + bottom) / 2 }
}
