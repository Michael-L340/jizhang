// 导出 / 导入。导出优先走系统分享（iOS 主屏 App 里 <a download> 不可靠）。
import type { Account, Category, Snapshot, Transaction } from '../types'
import { fmtYuan } from './money'
import { TX_TYPE_LABEL } from '../types'
import { validateImport } from './validate'

function esc(v: string | null | undefined): string {
  const s = v ?? ''
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function buildCsv(snap: Snapshot): string {
  const acc = new Map(snap.accounts.map((a) => [a.id, a.name]))
  const cat = new Map(snap.categories.map((c) => [c.id, c]))
  const header = ['日期', '类型', '金额', '一级分类', '二级分类', '账户', '转入账户', '备注', 'ID']
  const lines = [header.join(',')]
  const sorted = [...snap.transactions].sort((a, b) => (a.date === b.date ? (a.created_at < b.created_at ? -1 : 1) : a.date < b.date ? -1 : 1))
  for (const t of sorted) {
    const c = t.category_id ? cat.get(t.category_id) : undefined
    const parent = c?.parent_id ? cat.get(c.parent_id) : c
    const child = c?.parent_id ? c : undefined
    lines.push(
      [
        t.date,
        TX_TYPE_LABEL[t.type],
        fmtYuan(t.amount).replace(/,/g, ''),
        esc(parent?.name),
        esc(child?.name),
        esc(t.account_id ? acc.get(t.account_id) : ''),
        esc(t.to_account_id ? acc.get(t.to_account_id) : ''),
        esc(t.note),
        t.id,
      ].join(','),
    )
  }
  return '\uFEFF' + lines.join('\n')
}

export interface ExportFile {
  version: 1
  exported_at: string
  /**
   * 导出时本次会话有没有成功同步过云端。false = 这份文件是本机缓存的样子，可能比云端少几笔，
   * 不该拿它做「整库恢复」。字段缺失表示这个文件是加这条标记之前导的，不知道。
   */
  synced?: boolean
  /** 导出时最后一次成功同步的时间；null = 本次会话一次都没成功过 */
  last_sync?: string | null
  accounts: Account[]
  categories: Category[]
  transactions: Transaction[]
}

/** meta 不传就不写同步标记（给测试和老调用方留的口子） */
export function buildJson(snap: Snapshot, meta?: { synced: boolean; lastSync: string | null }): string {
  const file: ExportFile = {
    version: 1,
    exported_at: new Date().toISOString(),
    ...(meta ? { synced: meta.synced, last_sync: meta.lastSync } : {}),
    accounts: snap.accounts,
    categories: snap.categories,
    transactions: snap.transactions,
  }
  return JSON.stringify(file, null, 2)
}

/**
 * 解析并**逐条校验**导入文件；不合法抛错，抛错时一个字节都还没往云端发。
 *
 * 这里必须严，因为「整库恢复」会先删光云端再按这个文件重建：文件是坏的，数据就真没了。
 * 具体每一条规则、以及它对应数据库里的哪句 SQL，见 validate.ts。
 *
 * version 只要求 ≥ 1：以后格式升到 2，老代码读新文件、新代码读老文件都不该被一句
 * 「不是本应用导出的 JSON」拦死——真出事那天手上只有一份老备份是很常见的。
 */
export function parseImport(text: string): Snapshot {
  const obj = JSON.parse(text) as Partial<ExportFile>
  if (!obj || typeof obj.version !== 'number' || obj.version < 1 || !Array.isArray(obj.accounts) || !Array.isArray(obj.categories) || !Array.isArray(obj.transactions)) {
    throw new Error('不是本应用导出的 JSON 文件')
  }
  return validateImport({ accounts: obj.accounts, categories: obj.categories, transactions: obj.transactions })
}

/** 读文件头上的自述：这份备份导出时同步过没有。读不出来就是「不知道」（null） */
export function readExportMeta(text: string): { synced: boolean | null; lastSync: string | null } {
  try {
    const obj = JSON.parse(text) as Partial<ExportFile>
    return { synced: typeof obj?.synced === 'boolean' ? obj.synced : null, lastSync: typeof obj?.last_sync === 'string' ? obj.last_sync : null }
  } catch {
    return { synced: null, lastSync: null }
  }
}

// ── 导出前的自查：这份「完整备份」凭什么叫完整 ──────────────────────
// 导出用的是 store 里的快照。本次打开 App 后一次都没同步成功过的话（没信号、
// Supabase 免费项目休眠、登录过期，或者另一台设备记了账而本机没拉到），
// 那份快照就是本机缓存，可能比云端少几百条，而文件里看不出任何痕迹。
// 用它做「整库恢复」= 先删光云端，再写回一份残缺的——那些账就真没了。
//
// 判据只看 loaded 和 syncFailed：
//   loaded=false     本次会话没成功拉过云端，界面上是缓存，肯定不可信
//   syncFailed=true  最近一次同步失败了，之后云端可能又变过，也不敢保证
// cacheDegraded 故意不算：它说的是「写不进本机缓存」，而导出取的是内存里的快照，
// 只要这次同步成功过，内存里就是新的，和缓存写没写进去无关。

export function exportTrustworthy(s: { loaded: boolean; syncFailed: boolean }): boolean {
  return s.loaded && !s.syncFailed
}

export const STALE_EXPORT_WARNING =
  '这次打开 App 后还没成功同步过云端，导出的可能不是最新的——另一台设备记的账、或者云端有而本机还没拉到的，都不会在这个文件里。\n\n' +
  '建议联网后先点「立即同步」再导出。这份文件会标上「未同步」，不要拿它做整库恢复。\n\n仍然要导出吗？'

/** 不可信的导出在文件名上留个记号，免得三个月后分不清哪份是全的 */
export function backupFilename(kind: 'json' | 'csv', day: string, trustworthy: boolean): string {
  const base = kind === 'json' ? '记账备份' : '记账'
  return `${base}-${day}${trustworthy ? '' : '-未同步'}.${kind}`
}

export async function shareOrDownload(filename: string, content: string, mime: string): Promise<'shared' | 'downloaded'> {
  const file = new File([content], filename, { type: mime })
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean }
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: filename })
      return 'shared'
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') return 'shared'
    }
  }
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return 'downloaded'
}
