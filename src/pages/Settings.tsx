import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { buildCsv, buildJson, parseImport, shareOrDownload } from '../lib/csv'
import { fmtIsoZh, today } from '../lib/date'
import { friendlyError } from '../lib/api'
import { checkForUpdate, hardReload } from '../lib/sw'
import { useStore } from '../lib/store'
import type { CatKind, Category } from '../types'

export function Settings() {
  const nav = useNavigate()
  const s = useStore()
  const [busy, setBusy] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const roots = useMemo(() => s.categories.filter((c) => !c.parent_id).sort((a, b) => a.sort - b.sort), [s.categories])
  const childrenOf = (id: string) => s.categories.filter((c) => c.parent_id === id && (showArchived || !c.is_archived)).sort((a, b) => a.sort - b.sort)

  async function rename(c: Category) {
    const name = window.prompt('新名称', c.name)?.trim()
    if (name && name !== c.name) await s.updateCategory(c.id, { name })
  }

  async function addChild(kind: CatKind, parentId: string | null) {
    const name = window.prompt(parentId ? '新二级分类名' : '新收入分类名')?.trim()
    if (name) await s.addCategory(kind, parentId, name)
  }

  async function exportCsv() {
    setBusy('csv')
    try {
      const r = await shareOrDownload(`记账-${today()}.csv`, buildCsv(s), 'text/csv')
      s.showToast(r === 'shared' ? '已打开分享' : '已下载 CSV')
    } finally {
      setBusy('')
    }
  }

  async function exportJson() {
    setBusy('json')
    try {
      const r = await shareOrDownload(`记账备份-${today()}.json`, buildJson(s), 'application/json')
      s.showToast(r === 'shared' ? '已打开分享' : '已下载 JSON 备份')
    } finally {
      setBusy('')
    }
  }

  async function importJson(file: File) {
    setBusy('import')
    try {
      const snap = parseImport(await file.text())
      if (!window.confirm(`将导入 ${snap.accounts.length} 个账户、${snap.categories.length} 个分类、${snap.transactions.length} 条流水（同 ID 覆盖）。继续？`)) return
      await s.importSnapshot(snap)
      s.showToast('导入完成')
    } catch (e) {
      s.showToast(`导入失败：${friendlyError(e)}`)
    } finally {
      setBusy('')
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="px-4 pb-8">
      <div className="flex items-center justify-between pt-4 pb-3">
        <span className="text-2xl font-bold">设置</span>
        <button type="button" className="text-sm text-brand px-2 py-1" onClick={() => nav(-1)}>
          返回
        </button>
      </div>

      <Section title="数据">
        <Row label={s.lastSync ? `上次同步 ${fmtIsoZh(s.lastSync)}` : '尚未同步'} action={s.syncing ? '同步中…' : '立即同步'} onClick={() => void s.refresh()} />
        <Row label="导出 CSV（Excel 可打开）" action={busy === 'csv' ? '…' : '导出'} onClick={exportCsv} />
        <Row label="导出 JSON 完整备份" action={busy === 'json' ? '…' : '导出'} onClick={exportJson} />
        <Row label="从 JSON 备份导入 / 恢复" action={busy === 'import' ? '…' : '选择文件'} onClick={() => fileRef.current?.click()} />
        <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])} />
      </Section>

      <Section title="账户">
        {s.accounts
          .sort((a, b) => a.sort - b.sort)
          .map((a) => (
            <Row
              key={a.id}
              label={a.name}
              action="改名"
              onClick={async () => {
                const name = window.prompt('账户名称', a.name)?.trim()
                if (name && name !== a.name) await s.updateAccount(a.id, { name })
              }}
            />
          ))}
      </Section>

      <Section
        title="支出用途"
        right={
          <button type="button" className="text-xs text-muted" onClick={() => setShowArchived(!showArchived)}>
            {showArchived ? '隐藏已归档' : '显示已归档'}
          </button>
        }
      >
        {roots
          .filter((c) => c.kind === 'expense')
          .map((p) => (
            <div key={p.id} className="py-2 border-b border-line last:border-0">
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="block font-medium">
                    {p.icon} {p.name}
                  </span>
                  <button
                    type="button"
                    className={`block text-left text-xs ${p.note ? 'text-muted' : 'text-brand'}`}
                    onClick={async () => {
                      const note = window.prompt(`「${p.name}」的含义说明`, p.note ?? '')
                      if (note !== null && note.trim() !== (p.note ?? '')) await s.updateCategory(p.id, { note: note.trim() || null })
                    }}
                  >
                    {p.note || '＋ 添加含义说明'}
                  </button>
                </span>
                <span className="flex gap-3 text-xs text-brand shrink-0 pt-0.5">
                  <button type="button" onClick={() => rename(p)}>
                    改名
                  </button>
                  <button type="button" onClick={() => addChild('expense', p.id)}>
                    ＋二级
                  </button>
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {childrenOf(p.id).map((c) => (
                  <ChildChip key={c.id} c={c} onRename={() => rename(c)} onToggle={() => void s.updateCategory(c.id, { is_archived: !c.is_archived })} />
                ))}
              </div>
            </div>
          ))}
      </Section>

      <Section
        title="收入分类"
        right={
          <button type="button" className="text-xs text-brand" onClick={() => addChild('income', null)}>
            ＋新增
          </button>
        }
      >
        <div className="flex flex-wrap gap-1.5 py-2">
          {roots
            .filter((c) => c.kind === 'income' && (showArchived || !c.is_archived))
            .map((c) => (
              <ChildChip key={c.id} c={c} onRename={() => rename(c)} onToggle={() => void s.updateCategory(c.id, { is_archived: !c.is_archived })} />
            ))}
        </div>
      </Section>

      <Section title="账号">
        <Row
          label="检查更新"
          action={busy === 'upd' ? '检查中…' : '检查'}
          onClick={async () => {
            setBusy('upd')
            const r = await checkForUpdate()
            setBusy('')
            s.showToast(r === 'unsupported' ? '此浏览器不支持自动更新' : '已检查：若有新版本，顶部会出现更新条')
          }}
        />
        <Row
          label="强制刷新（拿最新版本）"
          action="刷新"
          onClick={async () => {
            if (window.confirm('清空程序缓存并重新加载？账本数据和登录状态不受影响。')) await hardReload()
          }}
        />
        <Row
          label="退出登录"
          action="退出"
          danger
          onClick={async () => {
            if (window.confirm('退出登录？本机缓存会清除，云端数据不受影响。')) {
              await s.signOut()
              nav('/')
            }
          }}
        />
        <div className="text-xs text-muted py-2">版本 {__APP_VERSION__}</div>
      </Section>
    </div>
  )
}

function Section(props: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="card px-4 py-2 mb-3">
      <div className="flex items-center justify-between py-2">
        <span className="text-xs text-muted">{props.title}</span>
        {props.right}
      </div>
      {props.children}
    </div>
  )
}

function Row(props: { label: string; action: string; onClick: () => void; danger?: boolean }) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-line last:border-0">
      <span className="text-sm">{props.label}</span>
      <button type="button" className={`text-sm ${props.danger ? 'text-expense' : 'text-brand'}`} onClick={props.onClick}>
        {props.action}
      </button>
    </div>
  )
}

function ChildChip({ c, onRename, onToggle }: { c: Category; onRename: () => void; onToggle: () => void }) {
  return (
    <span className={`inline-flex items-center gap-1 chip ${c.is_archived ? 'opacity-40 line-through' : ''}`} style={{ padding: '4px 8px 4px 12px' }}>
      <button type="button" onClick={onRename}>
        {c.name}
      </button>
      <button type="button" className="text-muted px-1" title={c.is_archived ? '恢复' : '归档'} onClick={onToggle}>
        {c.is_archived ? '↺' : '×'}
      </button>
    </span>
  )
}
