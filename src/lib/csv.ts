// 导出 / 导入。导出优先走系统分享（iOS 主屏 App 里 <a download> 不可靠）。
import type { Account, Category, Snapshot, Transaction } from '../types'
import { fmtYuan } from './money'
import { TX_TYPE_LABEL } from '../types'

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
        esc(acc.get(t.account_id)),
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
  accounts: Account[]
  categories: Category[]
  transactions: Transaction[]
}

export function buildJson(snap: Snapshot): string {
  const file: ExportFile = {
    version: 1,
    exported_at: new Date().toISOString(),
    accounts: snap.accounts,
    categories: snap.categories,
    transactions: snap.transactions,
  }
  return JSON.stringify(file, null, 2)
}

/** 校验导入文件；不合法抛错 */
export function parseImport(text: string): Snapshot {
  const obj = JSON.parse(text) as Partial<ExportFile>
  if (!obj || obj.version !== 1 || !Array.isArray(obj.accounts) || !Array.isArray(obj.categories) || !Array.isArray(obj.transactions)) {
    throw new Error('不是本应用导出的 JSON 文件')
  }
  const strip = <T extends object>(rows: T[]): T[] => rows.map((r) => {
    const copy = { ...(r as Record<string, unknown>) }
    delete copy.user_id
    delete copy.updated_at
    return copy as T
  })
  return { accounts: strip(obj.accounts), categories: strip(obj.categories), transactions: strip(obj.transactions) }
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
