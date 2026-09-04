import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AccountIcon } from '../components/AccountIcon'
import { Sheet } from '../components/Sheet'
import { changePassword, friendlyError } from '../lib/api'
import { buildCsv, buildJson, parseImport, shareOrDownload } from '../lib/csv'
import { fmtIsoZh, today } from '../lib/date'
import { checkForUpdate, hardReload } from '../lib/sw'
import { CACHE_LIMIT_BYTES, useStore } from '../lib/store'

export function Settings() {
  const nav = useNavigate()
  // 按需订阅：原来 useStore() 全订阅，每次 toast/同步/记账都会重渲染整个设置页
  const accounts = useStore((st) => st.accounts)
  const categories = useStore((st) => st.categories)
  const transactions = useStore((st) => st.transactions)
  const lastSync = useStore((st) => st.lastSync)
  const syncing = useStore((st) => st.syncing)
  const refresh = useStore((st) => st.refresh)
  const signOut = useStore((st) => st.signOut)
  const updateAccount = useStore((st) => st.updateAccount)
  const importSnapshot = useStore((st) => st.importSnapshot)
  const showToast = useStore((st) => st.showToast)
  const syncFailed = useStore((st) => st.syncFailed)
  const cacheBytes = useStore((st) => st.cacheBytes)
  const cacheDegraded = useStore((st) => st.cacheDegraded)
  const snapshot = useMemo(() => ({ accounts, categories, transactions }), [accounts, categories, transactions])
  const [busy, setBusy] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const [pwOpen, setPwOpen] = useState(false)
  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')
  const [pwErr, setPwErr] = useState('')

  const stat = useMemo(() => {
    const roots = categories.filter((c) => !c.parent_id && !c.is_archived)
    return {
      expenseRoots: roots.filter((c) => c.kind === 'expense').length,
      children: categories.filter((c) => c.parent_id && !c.is_archived).length,
      incomeRoots: roots.filter((c) => c.kind === 'income').length,
    }
  }, [categories])

  async function submitPassword() {
    setPwErr('')
    if (pw1.length < 6) return setPwErr('密码至少 6 位')
    if (pw1 !== pw2) return setPwErr('两次输入不一致')
    setBusy('pw')
    try {
      await changePassword(pw1)
      setPwOpen(false)
      setPw1('')
      setPw2('')
      showToast('密码已修改，请记牢')
    } catch (e) {
      setPwErr(friendlyError(e))
    } finally {
      setBusy('')
    }
  }

  async function exportCsv() {
    setBusy('csv')
    try {
      const r = await shareOrDownload(`记账-${today()}.csv`, buildCsv(snapshot), 'text/csv')
      showToast(r === 'shared' ? '已打开分享' : '已下载 CSV')
    } finally {
      setBusy('')
    }
  }

  async function exportJson() {
    setBusy('json')
    try {
      const r = await shareOrDownload(`记账备份-${today()}.json`, buildJson(snapshot), 'application/json')
      showToast(r === 'shared' ? '已打开分享' : '已下载 JSON 备份')
    } finally {
      setBusy('')
    }
  }

  async function importJson(file: File) {
    setBusy('import')
    try {
      const snap = parseImport(await file.text())
      if (!window.confirm(`将导入 ${snap.accounts.length} 个账户、${snap.categories.length} 个分类、${snap.transactions.length} 条流水（同 ID 覆盖）。继续？`)) return
      await importSnapshot(snap)
      showToast('导入完成')
    } catch (e) {
      showToast(`导入失败：${friendlyError(e)}`)
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

      <Section title="分类与账户">
        <Nav
          label="分类管理"
          hint={`${stat.expenseRoots} 个支出大类 · ${stat.children} 个二级 · ${stat.incomeRoots} 个收入分类`}
          onClick={() => nav('/categories')}
        />
        <div className="py-3 border-b border-line last:border-0">
          <div className="text-sm mb-2">账户</div>
          <div className="flex flex-col gap-1">
            {accounts
              .slice()
              .sort((a, b) => a.sort - b.sort)
              .map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className="flex items-center gap-2.5 py-1.5 text-left"
                  onClick={async () => {
                    const name = window.prompt('账户名称', a.name)?.trim()
                    if (name && name !== a.name) await updateAccount(a.id, { name })
                  }}
                >
                  <AccountIcon name={a.name} size={26} />
                  <span className="flex-1 text-[15px]">{a.name}</span>
                  <span className="text-xs text-muted">改名</span>
                </button>
              ))}
          </div>
        </div>
      </Section>

      <Section title="数据">
        <Row
          label={`${lastSync ? `上次同步 ${fmtIsoZh(lastSync)}` : '尚未同步'}${syncFailed ? ' · 最近一次失败' : ''}`}
          action={syncing ? '同步中…' : '立即同步'}
          onClick={() => void refresh()}
          danger={syncFailed}
        />
        <div className="py-3 border-b border-line last:border-0">
          <div className="flex items-center justify-between text-sm">
            <span>本机缓存</span>
            <span className="num text-muted">
              {fmtBytes(cacheBytes)} / {fmtBytes(CACHE_LIMIT_BYTES)}
            </span>
          </div>
          <div className="mt-2 h-1.5 rounded-full bg-bg overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(100, Math.round((cacheBytes / CACHE_LIMIT_BYTES) * 100))}%`,
                background: cacheDegraded ? 'var(--color-expense)' : cacheBytes / CACHE_LIMIT_BYTES > 0.7 ? 'var(--color-adjust)' : 'var(--color-brand)',
              }}
            />
          </div>
          <div className={`text-xs mt-1.5 ${cacheDegraded ? 'text-expense' : 'text-muted'}`}>
            {cacheDegraded
              ? '缓存已满，离线时看到的可能是旧数据。云端数据不受影响，请告诉我处理。'
              : `${transactions.length} 条记录。缓存是为了打开快和离线可看，写满后会提示。`}
          </div>
        </div>
        <Row label="导出 CSV（Excel 可打开）" action={busy === 'csv' ? '…' : '导出'} onClick={exportCsv} />
        <Row label="导出 JSON 完整备份" action={busy === 'json' ? '…' : '导出'} onClick={exportJson} />
        <Row label="从 JSON 备份导入 / 恢复" action={busy === 'import' ? '…' : '选择文件'} onClick={() => fileRef.current?.click()} />
        <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])} />
      </Section>

      <Section title="账号与版本">
        <Row label="修改密码" action="修改" onClick={() => setPwOpen(true)} />
        <Row
          label="检查更新"
          action={busy === 'upd' ? '检查中…' : '检查'}
          onClick={async () => {
            setBusy('upd')
            const r = await checkForUpdate()
            setBusy('')
            showToast(r === 'unsupported' ? '此浏览器不支持自动更新' : '已检查：若有新版本，顶部会出现更新条')
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
              await signOut()
              nav('/')
            }
          }}
        />
        <div className="text-xs text-muted py-2">版本 {__APP_VERSION__}</div>
      </Section>

      <Sheet open={pwOpen} onClose={() => setPwOpen(false)} title="修改密码">
        <input
          className="w-full rounded-xl bg-bg px-4 py-3 mb-2"
          type="password"
          autoComplete="new-password"
          placeholder="新密码（至少 6 位）"
          value={pw1}
          onChange={(e) => setPw1(e.target.value)}
        />
        <input
          className="w-full rounded-xl bg-bg px-4 py-3 mb-2"
          type="password"
          autoComplete="new-password"
          placeholder="再输一次"
          value={pw2}
          onChange={(e) => setPw2(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submitPassword()}
        />
        {pwErr ? <div className="text-sm text-expense mb-2">{pwErr}</div> : null}
        <div className="text-xs text-muted mb-3">
          改完之后其他设备上已登录的状态不受影响，下次重新登录才需要新密码。
          <br />
          如果已经配了自动备份，改完请告诉我同步更新备份用的密码，否则备份第二天起会失败。
        </div>
        <button type="button" disabled={busy === 'pw'} className="w-full rounded-2xl bg-brand text-white py-3 font-semibold disabled:opacity-40" onClick={submitPassword}>
          {busy === 'pw' ? '提交中…' : '确认修改'}
        </button>
      </Sheet>
    </div>
  )
}

function fmtBytes(n: number): string {
  if (n <= 0) return '0'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <div className="card px-4 py-2 mb-3">
      <div className="py-2 text-xs text-muted">{props.title}</div>
      {props.children}
    </div>
  )
}

function Nav({ label, hint, onClick }: { label: string; hint?: string; onClick: () => void }) {
  return (
    <button type="button" className="w-full flex items-center gap-3 py-3 border-b border-line last:border-0 text-left" onClick={onClick}>
      <span className="flex-1 min-w-0">
        <span className="block text-[15px]">{label}</span>
        {hint ? <span className="block text-xs text-muted truncate">{hint}</span> : null}
      </span>
      <span className="text-muted">›</span>
    </button>
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
