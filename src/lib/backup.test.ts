// 自动备份状态与缓存占用的纯计算。
//
// 这两件事都属于「算错了不会报错，只会安静地骗人」：备份早就停了却显示「正常」，
// 或者缓存明明快满了进度条还剩一半。所以口径全部锁在这里。
import { describe, expect, it } from 'vitest'
import { backupHealth, backupLine, cacheBytes, CACHE_LIMIT_BYTES, CACHE_WARN_BYTES } from './backup'
import { enteredLabel, fmtIsoZh } from './date'

const H = 3600_000

describe('backupHealth', () => {
  it('没备份过（null）是 none，不是 stale', () => {
    // 显示的话完全不同：「还没有过自动备份」vs「已 N 天没有自动备份」。
    // 混成一个会让刚配好备份的人以为它已经坏了
    expect(backupHealth(null, '2026-09-05T02:00:00.000Z')).toBe('none')
  })

  it('时间戳读不懂也当 none，不能算出 NaN 天', () => {
    expect(backupHealth('昨天', '2026-09-05T02:00:00.000Z')).toBe('none')
    expect(backupHealth('', '2026-09-05T02:00:00.000Z')).toBe('none')
  })

  it('今天凌晨刚跑过是 ok', () => {
    expect(backupHealth('2026-09-04T17:37:00.000Z', '2026-09-05T02:00:00.000Z')).toBe('ok')
  })

  it('正好 48 小时还算 ok，超过 48 小时才是 stale', () => {
    // 备份每天跑一次。阈值定在 48 小时 = 连着两天没跑，一次偶发失败不报警。
    // 边界写反（>= 或 24 小时）会让每天正常跑的备份天天报「好像停了」
    const now = '2026-09-05T02:00:00.000Z'
    const at48 = new Date(Date.parse(now) - 48 * H).toISOString()
    const at48plus = new Date(Date.parse(now) - 48 * H - 1).toISOString()
    expect(backupHealth(at48, now)).toBe('ok')
    expect(backupHealth(at48plus, now)).toBe('stale')
  })

  it('手机时钟偏差把备份时间推到「未来」，当 ok，不能报警', () => {
    // 只比「过去多久」这一个方向。写成 Math.abs(gap) 的话，时钟差三天就会
    // 报「已 3 天没有自动备份」，而备份其实半小时前刚跑完
    expect(backupHealth('2026-09-08T02:00:00.000Z', '2026-09-05T02:00:00.000Z')).toBe('ok')
  })
})

describe('backupLine', () => {
  it('没备份过就直说', () => {
    expect(backupLine(null, '2026-09-05T02:00:00.000Z')).toBe('还没有过自动备份')
  })

  it('正常时报出北京时间和条数，条数带千位分隔', () => {
    // 01:37 是备份脚本的固定时间（北京时间）。UTC 是前一天 17:37 —— 直接拿
    // toISOString 切日期会显示成「昨天 17:37」，用户对不上号
    expect(backupLine({ at: '2026-09-04T17:37:00.000Z', transactions: 1234 }, '2026-09-05T02:00:00.000Z')).toBe('上次自动备份：今天 01:37，1,234 条')
  })

  it('跨北京日界：UTC 还是 9 月 4 日，北京已经是 5 日 00:00', () => {
    // 用 UTC 算日子的写法在这里会显示「昨天 16:00」，两个字段全错
    expect(backupLine({ at: '2026-09-04T16:00:00.000Z', transactions: 5 }, '2026-09-05T02:00:00.000Z')).toBe('上次自动备份：今天 00:00，5 条')
  })

  it('昨天跑的说「昨天」', () => {
    expect(backupLine({ at: '2026-09-03T17:37:00.000Z', transactions: 900 }, '2026-09-05T02:00:00.000Z')).toBe('上次自动备份：昨天 01:37，900 条')
  })

  it('停了就说停了几天，并指到 GitHub Actions', () => {
    // 「上次备份：8月30日」用户得自己掰指头算。直接说「已 3 天」
    expect(backupLine({ at: '2026-09-02T01:00:00.000Z', transactions: 1234 }, '2026-09-05T02:00:00.000Z')).toBe('已 3 天没有自动备份，去 GitHub 看看 Actions 是不是停了')
  })
})

describe('cacheBytes', () => {
  it('按 UTF-16 算：一个汉字是 2 字节，不是 UTF-8 的 3 字节', () => {
    // localStorage 的配额按 UTF-16 计。用 new Blob([v]).size（UTF-8）会两头都错：
    // 全是 ASCII 的 UUID 少算一半，中文备注多算 50%，
    // 结果就是「进度条还剩一半，写入已经开始失败」
    expect(cacheBytes([['k', '中文']])).toBe(6)
    expect(cacheBytes([['k', 'ab']])).toBe(6)
  })

  it('键也占配额，不能只算值', () => {
    expect(cacheBytes([['jz_cache_v1', 'ab']])).toBe((11 + 2) * 2)
  })

  it('多个键相加；空表是 0', () => {
    expect(cacheBytes([])).toBe(0)
    expect(cacheBytes([['a', 'b'], ['c', 'd']])).toBe(8)
  })
})

describe('阈值', () => {
  it('提醒线是 5 MiB 的七成，且必须小于上限', () => {
    expect(CACHE_LIMIT_BYTES).toBe(5 * 1024 * 1024)
    expect(CACHE_WARN_BYTES).toBe(3.5 * 1024 * 1024)
    expect(CACHE_WARN_BYTES).toBeLessThan(CACHE_LIMIT_BYTES)
  })
})

// 设置页「上次同步 X月X日 HH:mm」用的是 fmtIsoZh，它一直没有任何用例护着。
// 补在这里而不是新建文件：它和 fmtIsoTimeZh 是一对孪生函数，一起改一起坏。
// 这条只在 TZ=UTC 下才有约束力（见 vite.config.ts）——在东八区的机器上，
// 就算把 timeZone: 'Asia/Shanghai' 整个删掉也照样是绿的。
describe('fmtIsoZh 按北京时间显示', () => {
  it('UTC 16:00 是北京第二天 00:00', () => {
    expect(fmtIsoZh('2026-09-04T16:00:00.000Z')).toBe('9/5 00:00')
  })
  it('UTC 15:59 还是北京同一天的 23:59', () => {
    expect(fmtIsoZh('2026-09-04T15:59:59.999Z')).toBe('9/4 23:59')
  })
  it('跨年也对', () => {
    expect(fmtIsoZh('2026-12-31T16:00:00.000Z')).toBe('1/1 00:00')
  })
})

// 录入时间标签。created_at 是录入时刻（updateTx 显式不更新这一列），
// 这几条同时压住「北京时间」和「跨天补记要带月日」两件事。
describe('enteredLabel', () => {
  it('同一天只显示时分', () => {
    expect(enteredLabel('2026-09-05T11:03:00.000Z', '2026-09-05')).toBe('19:03')
  })
  it('9月1日的账 9月5日才补记，要带上月日', () => {
    expect(enteredLabel('2026-09-05T11:03:00.000Z', '2026-09-01')).toBe('9/5 19:03')
  })
  it('按北京时间判断是不是同一天：UTC 16:00 已经是北京第二天', () => {
    expect(enteredLabel('2026-09-04T16:00:00.000Z', '2026-09-05')).toBe('00:00')
    expect(enteredLabel('2026-09-04T16:00:00.000Z', '2026-09-04')).toBe('9/5 00:00')
  })
  it('月日不补零', () => {
    expect(enteredLabel('2026-01-02T03:00:00.000Z', '2026-01-01')).toBe('1/2 11:00')
  })
})
