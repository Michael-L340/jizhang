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

const TX_TYPES = new Set(['expense', 'income', 'transfer', 'adjust'])

/**
 * 校验导入文件；不合法抛错。
 *
 * 这里必须严，因为「整库恢复」会先删光云端再按这个文件重建：文件是坏的，
 * 数据就真没了。尤其是金额——本应用的 JSON 里 amount 是整数「分」（12.50 元存成 1250），
 * 如果哪天有人写了个备份脚本直接把数据库里的「元」倒出来，值会变成 12.5，
 * 导入后金额全部变成百分之一，而且不会报任何错。所以这里逐条卡整数。
 *
 * version 只要求 ≥ 1：以后格式升到 2，老代码读新文件、新代码读老文件都不该被一句
 * 「不是本应用导出的 JSON」拦死——真出事那天手上只有一份老备份是很常见的。
 */
export function parseImport(text: string): Snapshot {
  const obj = JSON.parse(text) as Partial<ExportFile>
  if (!obj || typeof obj.version !== 'number' || obj.version < 1 || !Array.isArray(obj.accounts) || !Array.isArray(obj.categories) || !Array.isArray(obj.transactions)) {
    throw new Error('不是本应用导出的 JSON 文件')
  }
  const strip = <T extends object>(rows: T[]): T[] => rows.map((r) => {
    const copy = { ...(r as Record<string, unknown>) }
    delete copy.user_id
    delete copy.updated_at
    return copy as T
  })
  const snap = { accounts: strip(obj.accounts), categories: strip(obj.categories), transactions: strip(obj.transactions) }

  const bad = (i: number, why: string) => new Error(`备份文件第 ${i + 1} 条流水${why}，文件可能已损坏，没有导入任何数据`)
  snap.accounts.forEach((a, i) => {
    if (typeof a?.id !== 'string' || typeof a?.name !== 'string') throw new Error(`备份文件第 ${i + 1} 个账户缺少 id 或名称，文件可能已损坏`)
  })
  snap.categories.forEach((c, i) => {
    if (typeof c?.id !== 'string' || typeof c?.name !== 'string') throw new Error(`备份文件第 ${i + 1} 个分类缺少 id 或名称，文件可能已损坏`)
  })
  snap.transactions.forEach((t, i) => {
    if (typeof t?.id !== 'string') throw bad(i, '缺少 id')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t?.date ?? '')) throw bad(i, '的日期格式不对')
    if (!TX_TYPES.has(t?.type)) throw bad(i, '的类型不认识')
    if (!Number.isInteger(t?.amount)) throw bad(i, `的金额不是整数分（读到 ${String(t?.amount)}）`)
  })
  return snap
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
