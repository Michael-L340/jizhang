import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AccountIcon } from '../components/AccountIcon'
import { Sheet } from '../components/Sheet'
import { changePassword, friendlyError } from '../lib/api'
import { backupHealth, backupLine, CACHE_LIMIT_BYTES, CACHE_WARN_BYTES } from '../lib/backup'
import { backupFilename, buildCsv, buildJson, exportTrustworthy, parseImport, readExportMeta, shareOrDownload, STALE_EXPORT_WARNING } from '../lib/csv'
import { fmtIsoZh, nowIso, today } from '../lib/date'
import { checkForUpdate, hardReload } from '../lib/sw'
import { RestoreFailed, useStore } from '../lib/store'
import type { Snapshot } from '../types'

/**
 * 可点的状态格右上角的小转圈箭头。
 * 三个格子长得一模一样，其中两个能点一个不能，不给记号根本看不出来
 * ——用户原话：「同步看不出是个按钮」。
 */
function TapMark() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="inline-block ml-1 align-[-1px]">
      <path d="M20 12a8 8 0 1 1-2.4-5.7M20 3.5V8h-4.5" />
    </svg>
  )
}

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
  const restoreSnapshot = useStore((st) => st.restoreSnapshot)
  const showToast = useStore((st) => st.showToast)
  const syncFailed = useStore((st) => st.syncFailed)
  const loaded = useStore((st) => st.loaded)
  const cacheBytes = useStore((st) => st.cacheBytes)
  const cacheDegraded = useStore((st) => st.cacheDegraded)
  const backup = useStore((st) => st.backup)
  const backupFailed = useStore((st) => st.backupFailed)
  const loadBackupStatus = useStore((st) => st.loadBackupStatus)
  // 备份状态一天才变一次，进这一页时读一次就够。它走 auth.getUser()，是一次真正的网络请求，
  // 不要塞进 refresh() 那套时序机制里跟着每次同步跑。
  // checked 是为了别在那半秒里先显示「还没有过自动备份」——备份好好的，闪一句这个会吓人。
  // 初值看 store 里有没有现成结果：来回切页面时不该再闪一次「读取中」。
  const [backupChecked, setBackupChecked] = useState(() => backup !== null || backupFailed)
  useEffect(() => {
    void loadBackupStatus().finally(() => setBackupChecked(true))
  }, [loadBackupStatus])
  const health = backupHealth(backup?.at ?? null, nowIso())
  /** 这次导出的东西信不信得过：本次会话成功同步过、且最近一次没失败 */
  const trustworthy = exportTrustworthy({ loaded, syncFailed })
  const snapshot = useMemo(() => ({ accounts, categories, transactions }), [accounts, categories, transactions])
  const [busy, setBusy] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  // 用 ref 不用 state：setMode 之后要立刻 click()，ref 是同步的，不用等重渲染
  const modeRef = useRef<'merge' | 'restore'>('merge')
  // 导入失败的信息要留在屏幕上。toast 只有 5 秒，而这段话用户需要读完并照着做
  const [importErr, setImportErr] = useState('')
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

  /**
   * 同步状态不可靠时不要静默导出：导出的是本机缓存，可能比云端少几百条，
   * 而用户拿它做「整库恢复」就会真的丢账。但也不能直接禁止——他可能正是在没网时想留个副本。
   */
  function exportAllowed(): boolean {
    return trustworthy || window.confirm(STALE_EXPORT_WARNING)
  }

  async function exportCsv() {
    if (!exportAllowed()) return
    setBusy('csv')
    try {
      const r = await shareOrDownload(backupFilename('csv', today(), trustworthy), buildCsv(snapshot), 'text/csv')
      showToast(r === 'shared' ? '已打开分享' : '已下载 CSV')
    } finally {
      setBusy('')
    }
  }

  async function exportJson() {
    if (!exportAllowed()) return
    setBusy('json')
    try {
      const content = buildJson(snapshot, { synced: trustworthy, lastSync })
      const r = await shareOrDownload(backupFilename('json', today(), trustworthy), content, 'application/json')
      showToast(r === 'shared' ? '已打开分享' : '已下载 JSON 备份')
    } finally {
      setBusy('')
    }
  }

  function pickFile(mode: 'merge' | 'restore') {
    modeRef.current = mode
    setImportErr('')
    fileRef.current?.click()
  }

  async function importJson(file: File) {
    const restore = modeRef.current === 'restore'
    setBusy('import')
    setImportErr('')
    try {
      const text = await file.text()
      // 第一步：解析并逐条校验，这一步没过就一个字节都不往云端发。
      // 整库恢复是先删光再重建，文件里只要有一行数据库不收，账本就真没了（校验规则见 lib/validate.ts）
      let snap: Snapshot
      try {
        snap = parseImport(text)
        if (restore && (!snap.accounts.length || !snap.categories.length)) {
          throw new Error('这个文件里没有账户或分类，不像是一份完整备份')
        }
      } catch (e) {
        setImportErr(`${friendlyError(e)}。已停止，云端一条数据都没动，账本原封不动。`)
        return
      }
      if (restore) {
        // 两种「这次恢复不太踏实」都要当面说清楚，用户仍可以坚持
        const meta = readExportMeta(text)
        const warn: string[] = []
        if (meta.synced === false) warn.push('注意：这个备份文件导出时本机还没同步过云端，它自己标了「未同步」，里面的账可能不全。')
        if (!trustworthy) warn.push('注意：这次打开 App 后还没成功同步过。万一恢复中途失败，自动退回用的是本机现在这份数据，可能比云端少几条。')
        const ok = window.confirm(
          `整库恢复会先删掉云端现在的 ${accounts.length} 个账户、${categories.length} 个分类、${transactions.length} 条流水，` +
            `再按这个文件重建成 ${snap.accounts.length} 个账户、${snap.categories.length} 个分类、${snap.transactions.length} 条流水。\n\n` +
            (warn.length ? `${warn.join('\n\n')}\n\n` : '') +
            '文件已经逐条查过，能导进去。中途万一断网会自动退回操作前的样子。\n\n请先确认这个备份文件还在手机或电脑里。继续？',
        )
        if (!ok) return
        await restoreSnapshot(snap)
        showToast('整库恢复完成')
      } else {
        const ok = window.confirm(
          `合并导入 ${snap.accounts.length} 个账户、${snap.categories.length} 个分类、${snap.transactions.length} 条流水。` +
            '同 ID 的会被覆盖，现有数据不会被删除。继续？',
        )
        if (!ok) return
        await importSnapshot(snap)
        showToast('导入完成')
      }
    } catch (e) {
      // RestoreFailed 的 message 已经把云端现在什么状态、下一步该干什么说全了，原样显示
      setImportErr(
        e instanceof RestoreFailed
          ? e.message
          : `${restore ? '整库恢复' : '导入'}失败：${friendlyError(e)}。已经写进去的部分不会自动撤销，用同一个文件再走一遍是安全的（同 ID 覆盖）。`,
      )
    } finally {
      setBusy('')
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const cachePct = Math.min(100, Math.round((cacheBytes / CACHE_LIMIT_BYTES) * 100))
  const cacheWarn = cacheDegraded || cacheBytes > CACHE_WARN_BYTES
  const backupTone = !backupChecked || backupFailed || health === 'none' ? 'muted' : health === 'stale' ? 'warn' : 'ok'
  const backupText = !backupChecked ? '读取中…' : backupFailed ? '读不到' : health === 'ok' ? '正常' : health === 'stale' ? '好像停了' : '未启用'
  // 状态卡下面那一行：有问题说问题，没问题就报一句上次备份
  const statusNote = syncFailed
    ? '最近一次同步失败，点「同步」再试。'
    : backupChecked && backupFailed
      ? '读不到备份状态：网络不通或登录过期，点上面那一格重试。'
      : cacheDegraded
        ? `缓存已满（${fmtBytes(cacheBytes)}），离线时看到的可能是旧数据，云端不受影响。`
        : cacheWarn
          ? `缓存快满了（${fmtBytes(cacheBytes)}），没网时看到的可能是旧账本，云端不受影响。`
          : backupChecked
            ? backupLine(backup, nowIso())
            : ''
  const [accOpen, setAccOpen] = useState(false)
  const assetsCount = accounts.filter((a) => a.kind !== 'credit').length

  return (
    <div className="px-4 pb-8">
      <div className="flex items-center justify-between pt-4 pb-3">
        <span className="text-2xl font-bold">设置</span>
        <button type="button" className="text-sm text-brand-ink px-2 py-1" onClick={() => nav(-1)}>
          返回
        </button>
      </div>

      {/* 状态卡：同步 / 备份 / 缓存 三格并排，一眼看健康度。细节只在出问题时才展开成一句话。 */}
      <div className="card p-3 mb-3">
        <div className="grid grid-cols-3 gap-1.5">
          <button type="button" className="rounded-xl bg-bg px-2.5 py-2 text-left active:opacity-60" onClick={() => void refresh()}>
            <span className="block text-[10.5px] text-muted">
              同步
              <TapMark />
            </span>
            <span className={`block text-[13px] font-semibold ${syncFailed ? 'text-expense' : ''}`}>
              <Dot tone={syncing ? 'muted' : syncFailed ? 'bad' : lastSync ? 'ok' : 'muted'} />
              {syncing ? '同步中…' : syncFailed ? '失败' : lastSync ? fmtIsoZh(lastSync) : '尚未'}
            </span>
          </button>
          <button
            type="button"
            className="rounded-xl bg-bg px-2.5 py-2 text-left active:opacity-60"
            onClick={() => {
              setBackupChecked(false)
              void loadBackupStatus().finally(() => setBackupChecked(true))
            }}
          >
            <span className="block text-[10.5px] text-muted">
              自动备份
              <TapMark />
            </span>
            <span className={`block text-[13px] font-semibold ${backupTone === 'warn' ? 'text-adjust' : ''}`}>
              <Dot tone={backupTone === 'ok' ? 'ok' : backupTone === 'warn' ? 'warn' : 'muted'} />
              {backupText}
            </span>
          </button>
          <div className="rounded-xl bg-bg px-2.5 py-2">
            <span className="block text-[10.5px] text-muted">本机缓存</span>
            <span className={`block num text-[13px] font-semibold ${cacheWarn ? 'text-expense' : ''}`}>{cachePct}%</span>
            <span className="block h-1 rounded-full bg-line overflow-hidden mt-1">
              <span className="block h-full rounded-full" style={{ width: `${cachePct}%`, background: cacheDegraded ? 'var(--color-expense)' : cacheWarn ? 'var(--color-adjust)' : 'var(--color-brand-ink)' }} />
            </span>
          </div>
        </div>
        {statusNote ? <div className={`text-[11px] mt-2 ${syncFailed || cacheWarn || (backupChecked && backupFailed) ? 'text-expense' : backupTone === 'warn' ? 'text-adjust' : 'text-muted'}`}>{statusNote}</div> : null}
        {/* 核对备份和恢复结果时要拿这两个数去对，别只留百分比 */}
        <div className="text-[11px] text-muted mt-1 num">
          共 {transactions.length} 条记录 · 缓存 {fmtBytes(cacheBytes)} / {fmtBytes(CACHE_LIMIT_BYTES)}
        </div>
      </div>

      <Group title="分类与账户">
        <Item icon="🏷️" label="分类管理" hint={`${stat.expenseRoots} 个支出大类 · ${stat.children} 个二级 · ${stat.incomeRoots} 个收入分类`} onClick={() => nav('/categories')} />
        <Item icon="💳" label="账户" hint={`${assetsCount} 个资产 · ${accounts.length - assetsCount} 个白条 · 点进去改名`} onClick={() => setAccOpen(true)} />
      </Group>

      <Group title="备份与恢复">
        {trustworthy ? null : <div className="text-xs text-expense leading-relaxed py-2 border-b border-line">这次打开 App 后还没成功同步过，现在导出的是本机缓存，可能不是最新的。建议先点上面的「同步」。</div>}
        <Item icon="📤" label="导出 CSV" hint="Excel 可打开" action={busy === 'csv' ? '…' : '导出'} onClick={exportCsv} />
        <Item icon="🗂️" label="导出 JSON 备份" hint={trustworthy ? '完整备份，可用于恢复' : '会标记为「未同步」'} action={busy === 'json' ? '…' : '导出'} onClick={exportJson} />
        <Item icon="📥" label="合并导入" hint="找回误删的几笔，不删现有数据" action={busy === 'import' ? '…' : '选文件'} onClick={() => pickFile('merge')} />
        <Item icon="♻️" label="整库恢复" hint="先清空，再按备份文件重建" action={busy === 'import' ? '…' : '选文件'} danger onClick={() => pickFile('restore')} />
        {importErr ? <div className="text-xs text-expense leading-relaxed py-2">{importErr}</div> : null}
      </Group>
      {/* 放在 Group 外面：隐藏元素也算 :last-child，留在卡片里会让最后一行多一条分隔线 */}
      <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])} />

      <Group title="账号">
        <Item icon="🔑" label="修改密码" onClick={() => setPwOpen(true)} />
        <Item
          icon="🔄"
          label="检查更新"
          hint={`当前版本 ${__APP_VERSION__}`}
          action={busy === 'upd' ? '检查中…' : '检查'}
          onClick={async () => {
            setBusy('upd')
            const r = await checkForUpdate()
            setBusy('')
            showToast(r === 'unsupported' ? '此浏览器不支持自动更新' : '已检查：若有新版本，顶部会出现更新条')
          }}
        />
        <Item
          icon="🧹"
          label="强制刷新"
          hint="清空程序缓存重新加载，账本不受影响"
          action="刷新"
          onClick={async () => {
            if (!window.confirm('清空程序缓存并重新加载？需要联网，账本数据和登录状态不受影响。')) return
            try {
              await hardReload()
            } catch (e) {
              // 没信号时不能往下走：清掉缓存又加载不回来，App 会变成打不开的白屏
              showToast(friendlyError(e))
            }
          }}
        />
        <Item
          icon="🚪"
          label="退出登录"
          hint="本机缓存会清除，云端不受影响"
          action="退出"
          danger
          onClick={async () => {
            if (window.confirm('退出登录？本机缓存会清除，云端数据不受影响。')) {
              await signOut()
              nav('/')
            }
          }}
        />
      </Group>

      <Sheet open={accOpen} onClose={() => setAccOpen(false)} title="账户 · 点一个改名">
        <div className="flex flex-col">
          {accounts
            .slice()
            .sort((a, b) => a.sort - b.sort)
            .map((a) => (
              <button
                key={a.id}
                type="button"
                className="flex items-center gap-3 py-2.5 text-left border-t border-line first:border-t-0"
                onClick={async () => {
                  const name = window.prompt('账户名称', a.name)?.trim()
                  if (name && name !== a.name) await updateAccount(a.id, { name })
                }}
              >
                <AccountIcon name={a.name} size={30} />
                <span className="flex-1 text-[15px]">{a.name}</span>
                <span className="text-xs text-muted">{a.kind === 'credit' ? '白条 · ' : ''}改名</span>
              </button>
            ))}
        </div>
      </Sheet>

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
          改完在电脑上跑一下 npm run backup:password 把新密码同步给自动备份，否则第二天起备份会失败。
        </div>
        <button type="button" disabled={busy === 'pw'} className="w-full rounded-2xl bg-brand text-on-brand py-3 font-semibold disabled:opacity-40" onClick={submitPassword}>
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

function Dot({ tone }: { tone: 'ok' | 'warn' | 'bad' | 'muted' }) {
  const bg = tone === 'ok' ? 'var(--color-income)' : tone === 'warn' ? 'var(--color-adjust)' : tone === 'bad' ? 'var(--color-expense)' : 'var(--color-muted)'
  return <span className="inline-block w-1.5 h-1.5 rounded-full mr-1 align-[1px]" style={{ background: bg }} />
}

function Group(props: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="text-[11px] text-muted px-1 mb-1.5 tracking-wide">{props.title}</div>
      <div className="card px-4">{props.children}</div>
    </div>
  )
}

/** 一行：小图标 + 标题/说明 + 右侧动作文字（没有 action 就是 › ）。整行可点。 */
function Item(props: { icon: string; label: string; hint?: string; action?: string; danger?: boolean; onClick: () => void }) {
  return (
    <button type="button" className="w-full flex items-center gap-3 py-3 border-b border-line last:border-0 text-left" onClick={props.onClick}>
      <span className="w-7 h-7 rounded-lg bg-brand-soft flex items-center justify-center text-[15px] shrink-0">{props.icon}</span>
      <span className="flex-1 min-w-0">
        <span className={`block text-[15px] ${props.danger ? 'text-expense' : ''}`}>{props.label}</span>
        {props.hint ? <span className="block text-xs text-muted truncate">{props.hint}</span> : null}
      </span>
      <span className={`text-sm shrink-0 ${props.action ? (props.danger ? 'text-expense' : 'text-brand-ink') : 'text-muted'}`}>{props.action ?? '›'}</span>
    </button>
  )
}
