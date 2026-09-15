import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ILLUSTRATIONS } from './Empty'

describe('空状态插画', () => {
  it('每张都真的在 public/art 里——路径是拼字符串，拼错了浏览器只会静默显示裂图', () => {
    for (const [k, f] of Object.entries(ILLUSTRATIONS)) expect(existsSync(join(__dirname, '../../public/art', f)), `${k} → ${f}`).toBe(true)
  })

  it('文件名带版本号，换图要改后缀而不是原地覆盖', () => {
    for (const f of Object.values(ILLUSTRATIONS)) expect(f).toMatch(/-v\d+\.png$/)
  })
})
