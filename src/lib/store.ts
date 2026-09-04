// 全局状态。页面只从这里读数据、只调这里的动作；这里是唯一调用 api.ts 的地方。
import { useMemo } from 'react'
import { create } from 'zustand'
import type { Account, CatKind, Category, Snapshot, Transaction } from '../types'
import * as api from './api'
import { nowIso } from './date'
import { applyPending, DELETED, type Pending } from './pending'

const CACHE_KEY = 'jz_cache_v1'

interface Cache extends Snapshot {
  at: string
}

function readCache(): Cache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const c = JSON.parse(raw) as Cache
    if (!Array.isArray(c.accounts) || !Array.isArray(c.categories) || !Array.isArray(c.transactions)) return null
    return c
  } catch {
    return null
  }
}

/**
 * 写缓存。只写三张表，不要把整个 store 展开进来（否则 auth/syncing/toast 也会被写）。
 * 返回写入的字符数；浏览器按 UTF-16 计配额，字节数 = 字符数 × 2。
 * 抛错交给调用方处理，不再静默吞掉。
 */
function writeCache(s: Snapshot): number {
  const c: Cache = { accounts: s.accounts, categories: s.categories, transactions: s.transactions, at: nowIso() }
  const json = JSON.stringify(c)
  localStorage.setItem(CACHE_KEY, json)
  return CACHE_KEY.length + json.length
}

/** localStorage 的大致上限（5 MiB，按 UTF-16 字节算） */
export const CACHE_LIMIT_BYTES = 5 * 1024 * 1024

export interface Toast {
  id: number
  msg: string
  undo?: () => void | Promise<void>
}

export interface State extends Snapshot {
  auth: 'loading' | 'out' | 'in'
  /** 本次会话是否已从云端成功拉取过 */
  loaded: boolean
  syncing: boolean
  lastSync: string | null
  /** 上次同步是否失败（首次加载成功后失败不再静默） */
  syncFailed: boolean
  toast: Toast | null
  /** 本机缓存占用字节数（UTF-16），0 表示还没写过 */
  cacheBytes: number
  /** 缓存写不进去了（配额满或被禁用），离线看到的数据可能是旧的 */
  cacheDegraded: boolean

  init: () => Promise<void>
  refresh: () => Promise<void>
  /** 去抖写入本机缓存，从当前 state 现读，不接受外部快照 */
  persist: () => void
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>

  addTx: (t: Transaction) => Promise<boolean>
  editTx: (t: Transaction) => Promise<boolean>
  removeTx: (id: string) => Promise<boolean>

  addCategory: (kind: CatKind, parentId: string | null, name: string) => Promise<Category | null>
  updateCategory: (id: string, patch: Partial<Pick<Category, 'name' | 'icon' | 'sort' | 'is_archived' | 'note' | 'parent_id'>>) => Promise<boolean>
  updateAccount: (id: string, patch: Partial<Pick<Account, 'name' | 'sort' | 'is_archived'>>) => Promise<boolean>
  /** 合并导入：同 id 覆盖，不删任何东西 */
  importSnapshot: (snap: Snapshot) => Promise<void>
  /** 整库恢复：先清空云端再整份写入。不可撤销，调用方必须已经跟用户确认过 */
  restoreSnapshot: (snap: Snapshot) => Promise<void>

  showToast: (msg: string, undo?: () => void | Promise<void>) => void
  hideToast: () => void
}

// ── 在途写入的补丁表 ──────────────────────────────────────────
// 一次写请求飞在路上时，refresh() 拉回的快照里还没有它。直接 set 会把它冲掉，
// 用户看到「刚记的那笔消失了」而实际上云端已经存了，很容易重记一遍。
// 所以 refresh 落地前先把在途补丁叠回去。
const pendingTx: Pending<Transaction> = new Map()
const pendingCat: Pending<Category> = new Map()

// ── 缓存写入去抖 ────────────────────────────────────────────
// 每次增删改都同步 JSON.stringify 全量流水，数据多了会让「保存」明显卡顿，
// 而撤销路径还会连着触发两次。尾部去抖 500ms。
let persistTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 导入 / 恢复之后把界面拉到云端真实状态。
 * refresh() 在 syncing 时会静默早退（手机上选文件会把 App 切后台，回来那次同步可能还在飞），
 * 直接调用有概率什么都不做，所以先等上一次同步落地，最多等 10 秒。
 */
async function pullAfterWrite(get: () => State): Promise<void> {
  for (let i = 0; i < 40 && get().syncing; i++) await new Promise((r) => setTimeout(r, 250))
  await get().refresh()
}

let toastSeq = 0
let toastTimer: ReturnType<typeof setTimeout> | null = null
let unsubAuth: (() => void) | null = null

export const useStore = create<State>((set, get) => ({
  accounts: [],
  categories: [],
  transactions: [],
  auth: 'loading',
  loaded: false,
  syncing: false,
  lastSync: null,
  syncFailed: false,
  toast: null,
  cacheBytes: 0,
  cacheDegraded: false,

  async init() {
    const cache = readCache()
    if (cache) {
      set({ accounts: cache.accounts, categories: cache.categories, transactions: cache.transactions, lastSync: cache.at })
      try {
        set({ cacheBytes: (CACHE_KEY.length + (localStorage.getItem(CACHE_KEY)?.length ?? 0)) * 2 })
      } catch {
        /* 读不到就当没有 */
      }
    }
    const signedIn = await api.hasSession()
    set({ auth: signedIn ? 'in' : 'out' })
    unsubAuth?.()
    unsubAuth = api.onAuthChange((ok) => {
      const prev = get().auth
      set({ auth: ok ? 'in' : 'out' })
      if (ok && prev !== 'in') void get().refresh()
    })
    if (signedIn) await get().refresh()
  },

  async refresh() {
    if (get().syncing || get().auth !== 'in') return
    set({ syncing: true })
    try {
      const snap = await api.fetchAll()
      // 把还在飞的写入叠回去，否则刚记的那笔会被这份快照冲掉
      const merged: Snapshot = {
        accounts: snap.accounts,
        categories: applyPending(snap.categories, pendingCat),
        transactions: applyPending(snap.transactions, pendingTx),
      }
      set({ ...merged, loaded: true, lastSync: nowIso(), syncFailed: false })
      get().persist()
    } catch (e) {
      // 首次加载成功之后失败也要留痕，否则断网/登录过期/项目休眠全都无声
      set({ syncFailed: true })
      if (!get().loaded) get().showToast(`同步失败：${api.friendlyError(e)}`)
    } finally {
      set({ syncing: false })
    }
  },

  persist() {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      const { accounts, categories, transactions } = get()
      try {
        const bytes = writeCache({ accounts, categories, transactions }) * 2
        set({ cacheBytes: bytes, cacheDegraded: false })
      } catch {
        // 配额满或被禁用。云端数据不受影响，但离线看到的会是旧的，必须让用户知道
        if (!get().cacheDegraded) {
          set({ cacheDegraded: true })
          get().showToast('本机缓存已满，离线时看到的可能是旧数据')
        }
      }
    }, 500)
  },

  async signIn(email, password) {
    await api.signIn(email, password)
    set({ auth: 'in' })
    await get().refresh()
  },

  async signOut() {
    await api.signOut()
    // 先取消在途的去抖写入，否则它会落在 removeItem 之后，缓存又被写回来
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    pendingTx.clear()
    pendingCat.clear()
    try {
      localStorage.removeItem(CACHE_KEY)
    } catch {
      /* ignore */
    }
    set({ auth: 'out', accounts: [], categories: [], transactions: [], loaded: false, lastSync: null, cacheBytes: 0, cacheDegraded: false, syncFailed: false })
  },

  async addTx(t) {
    pendingTx.set(t.id, t)
    // 函数式 set + 按 id 打补丁：整数组快照回滚会把并发操作的结果一起抹掉
    set((s) => ({ transactions: [t, ...s.transactions] }))
    get().persist()
    try {
      await api.insertTx(t)
      return true
    } catch (e) {
      set((s) => ({ transactions: s.transactions.filter((x) => x.id !== t.id) }))
      get().persist()
      get().showToast(`保存失败：${api.friendlyError(e)}`)
      return false
    } finally {
      pendingTx.delete(t.id)
    }
  },

  async editTx(t) {
    const before = get().transactions.find((x) => x.id === t.id)
    pendingTx.set(t.id, t)
    set((s) => ({ transactions: s.transactions.map((x) => (x.id === t.id ? t : x)) }))
    get().persist()
    try {
      await api.updateTx(t)
      return true
    } catch (e) {
      // 用 map 换回旧值而不是插回去：这条可能已被并发删除，插回去会让它复活
      if (before) set((s) => ({ transactions: s.transactions.map((x) => (x.id === t.id ? before : x)) }))
      get().persist()
      get().showToast(`修改失败：${api.friendlyError(e)}`)
      return false
    } finally {
      pendingTx.delete(t.id)
    }
  },

  async removeTx(id) {
    const row = get().transactions.find((x) => x.id === id)
    pendingTx.set(id, DELETED)
    set((s) => ({ transactions: s.transactions.filter((x) => x.id !== id) }))
    get().persist()
    try {
      await api.deleteTx(id)
      return true
    } catch (e) {
      // 位置无所谓：列表都靠 groupByDay/sortTxs 重排。但要幂等，
      // 万一 refresh 已经把它拉回来了，不能插成两条
      if (row) set((s) => (s.transactions.some((x) => x.id === id) ? s : { transactions: [row, ...s.transactions] }))
      get().persist()
      get().showToast(`删除失败：${api.friendlyError(e)}`)
      return false
    } finally {
      pendingTx.delete(id)
    }
  },

  async addCategory(kind, parentId, name) {
    const trimmed = name.trim()
    if (!trimmed) return null
    const siblings = get().categories.filter((c) => c.kind === kind && c.parent_id === parentId)
    const existing = siblings.find((c) => c.name === trimmed)
    if (existing) {
      if (existing.is_archived) await get().updateCategory(existing.id, { is_archived: false })
      return existing
    }
    const sort = siblings.reduce((m, c) => Math.max(m, c.sort), 0) + 1
    try {
      const created = await api.addCategory({ kind, parent_id: parentId, name: trimmed, sort })
      // 登记为在途：紧接着的一次 refresh 可能还拉不到它，会把它冲掉
      pendingCat.set(created.id, created)
      set((st) => ({ categories: [...st.categories, created] }))
      get().persist()
      setTimeout(() => pendingCat.delete(created.id), 10_000)
      return created
    } catch (e) {
      get().showToast(`新增分类失败：${api.friendlyError(e)}`)
      return null
    }
  },

  async updateCategory(id, patch) {
    const before = get().categories.find((c) => c.id === id)
    const after = before ? { ...before, ...patch } : undefined
    if (after) pendingCat.set(id, after)
    set((s) => ({ categories: s.categories.map((c) => (c.id === id ? { ...c, ...patch } : c)) }))
    try {
      await api.updateCategory(id, patch)
      get().persist()
      return true
    } catch (e) {
      if (before) set((s) => ({ categories: s.categories.map((c) => (c.id === id ? before : c)) }))
      get().showToast(`修改分类失败：${api.friendlyError(e)}`)
      return false
    } finally {
      pendingCat.delete(id)
    }
  },

  async updateAccount(id, patch) {
    const before = get().accounts.find((a) => a.id === id)
    set((s) => ({ accounts: s.accounts.map((a) => (a.id === id ? { ...a, ...patch } : a)) }))
    try {
      await api.updateAccount(id, patch)
      get().persist()
      return true
    } catch (e) {
      if (before) set((s) => ({ accounts: s.accounts.map((a) => (a.id === id ? before : a)) }))
      get().showToast(`修改账户失败：${api.friendlyError(e)}`)
      return false
    }
  },

  async importSnapshot(snap) {
    try {
      await api.importAll(snap)
    } finally {
      // importAll 每 500 条一批逐批提交，失败时前面的批次已经在云端了。
      // 不管成败都把界面拉到云端真实状态，否则用户看到的是「什么都没发生」。
      await pullAfterWrite(get)
    }
  },

  async restoreSnapshot(snap) {
    try {
      await api.wipeAll()
      await api.importAll(snap)
    } finally {
      await pullAfterWrite(get)
    }
  },

  showToast(msg, undo) {
    if (toastTimer) clearTimeout(toastTimer)
    const id = ++toastSeq
    set({ toast: { id, msg, undo } })
    toastTimer = setTimeout(() => {
      if (get().toast?.id === id) set({ toast: null })
    }, 5000)
  },

  hideToast() {
    if (toastTimer) clearTimeout(toastTimer)
    set({ toast: null })
  },
}))

// ---------- 便捷选择器 ----------

export function useActiveAccounts(): Account[] {
  const accounts = useStore((s) => s.accounts)
  // 不加 useMemo 的话每次 render 都产出新数组，会打穿五个页面里依赖它的 useMemo，
  // 其中 balanceSeries 每次都要整份复制并排序全部流水。
  // 注意：filter 必须在 sort 之前，否则 sort 会原地改 store 里的数组。
  return useMemo(() => accounts.filter((a) => !a.is_archived).sort((a, b) => a.sort - b.sort), [accounts])
}
