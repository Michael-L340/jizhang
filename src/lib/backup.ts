// 自动备份状态与本机缓存占用的纯计算。不依赖 store / api，所以能在 node 里测。
//
// 备份不在这个仓库里跑：另一个**私有**仓库 Michael-L340/jizhang-backup 的 GitHub Actions
// 每天（北京时间 01:37）用同一个账号登录、导出一份和设置页「导出 JSON 完整备份」
// 一模一样的文件提交进去，推送成功后把结果写进 Supabase Auth 的 user_metadata.backup：
//   { at: ISO 时间, transactions: 数字, accounts: 数字, categories: 数字 }
// App 这边只读 at 和 transactions，其余字段有就有、没有也不影响。
//
// 为什么不让前端直接查 GitHub API 看备份跑没跑：这个 App 的构建产物部署在**公开**仓库，
// 任何塞进前端的令牌都等于公开发布。走 user_metadata 不需要任何新令牌。

import { fmtDateRel, fmtIsoTimeZh, today } from './date'

/** 备份脚本写进 user_metadata.backup 的东西，App 只用这两个字段 */
export interface BackupStatus {
  /** 备份成功推送的时刻，ISO 8601 */
  at: string
  transactions: number
}

export type BackupHealth = 'none' | 'ok' | 'stale'

/** 超过这么久没备份就当它坏了。备份每天跑一次，48 小时 = 连着两天没跑，不是偶发抖动 */
export const BACKUP_STALE_MS = 48 * 60 * 60 * 1000

/** localStorage 的大致上限（5 MiB，按 UTF-16 字节算） */
export const CACHE_LIMIT_BYTES = 5 * 1024 * 1024

/** 到这里就该提醒用户了：5 MiB 的七成。写满之后离线看到的会是旧账本 */
export const CACHE_WARN_BYTES = 3.5 * 1024 * 1024

export function backupHealth(at: string | null, now: string): BackupHealth {
  if (!at) return 'none'
  const t = Date.parse(at)
  if (Number.isNaN(t)) return 'none'
  const gap = Date.parse(now) - t
  // 只比「过去多久」这一个方向。手机时钟比服务器慢时 gap 是负数，自然落进 ok——
  // 千万别写成 Math.abs(gap)，那会把一次时钟偏差报成「已 3 天没有自动备份」
  return gap > BACKUP_STALE_MS ? 'stale' : 'ok'
}

/** 设置页那一行字。三种状态各说各的话，用户不用自己去换算时间差 */
export function backupLine(status: BackupStatus | null, now: string): string {
  const health = backupHealth(status?.at ?? null, now)
  if (health === 'none' || !status) return '还没有过自动备份'
  if (health === 'stale') {
    const days = Math.floor((Date.parse(now) - Date.parse(status.at)) / 86_400_000)
    return `已 ${days} 天没有自动备份，去 GitHub 看看 Actions 是不是停了`
  }
  const day = fmtDateRel(today(new Date(status.at)), today(new Date(now)))
  return `上次自动备份：${day} ${fmtIsoTimeZh(status.at)}，${groupDigits(status.transactions)} 条`
}

/** 1234 → '1,234'。不用 toLocaleString：那东西的输出跟运行环境的 ICU 数据走，测不稳 */
function groupDigits(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * 本机缓存占用的字节数。浏览器按 **UTF-16** 记 localStorage 配额，键和值都算进去，
 * 所以是 (key.length + value.length) × 2。
 *
 * 别用 `new Blob([v]).size` —— 那是 UTF-8 字节数，两个方向都错：一个 UUID（全是 ASCII）
 * 会被少算一半，一句中文备注又会被多算 50%。占用是拿来跟 5 MiB 配额比的，用错口径
 * 就会「进度条还剩一半，写入已经开始失败」。
 */
export function cacheBytes(entries: Array<[string, string]>): number {
  let n = 0
  for (const [k, v] of entries) n += (k.length + v.length) * 2
  return n
}
