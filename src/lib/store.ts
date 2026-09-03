// 全局状态。页面只从这里读数据、只调这里的动作；这里是唯一调用 api.ts 的地方。
import { create } from 'zustand'
import type { Account, CatKind, Category, Snapshot, Transaction } from '../types'
import * as api from './api'
import { nowIso } from './date'

const CACHE_KEY = 'jz_cache_v1'

interface Cache extends Snapshot {
  at: string
}

function readCache(): Cache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const c = JSON.parse(raw) as Cache
    if (!Array.isArray(c.accounts) || !Array.isArray(c.transactions)) return null
    return c
  } catch {
    return null
  }
}

function writeCache(s: Snapshot) {
  try {
    const c: Cache = { ...s, at: nowIso() }
    localStorage.setItem(CACHE_KEY, JSON.stringify(c))
  } catch {
    /* 存储满或被禁用时忽略 */
  }
}

export interface Toast {
  id: number
  msg: string
  undo?: () => void
}

export interface State extends Snapshot {
  auth: 'loading' | 'out' | 'in'
  /** 本次会话是否已从云端成功拉取过 */
  loaded: boolean
  syncing: boolean
  lastSync: string | null
  toast: Toast | null

  init: () => Promise<void>
  refresh: () => Promise<void>
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>

  addTx: (t: Transaction) => Promise<boolean>
  editTx: (t: Transaction) => Promise<boolean>
  removeTx: (id: string) => Promise<boolean>

  addCategory: (kind: CatKind, parentId: string | null, name: string) => Promise<Category | null>
  updateCategory: (id: string, patch: Partial<Pick<Category, 'name' | 'icon' | 'sort' | 'is_archived'>>) => Promise<boolean>
  updateAccount: (id: string, patch: Partial<Pick<Account, 'name' | 'sort' | 'is_archived'>>) => Promise<boolean>
  importSnapshot: (snap: Snapshot) => Promise<void>

  showToast: (msg: string, undo?: () => void) => void
  hideToast: () => void
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
  toast: null,

  async init() {
    const cache = readCache()
    if (cache) set({ accounts: cache.accounts, categories: cache.categories, transactions: cache.transactions, lastSync: cache.at })
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
      set({ ...snap, loaded: true, lastSync: nowIso() })
      writeCache(snap)
    } catch (e) {
      if (!get().loaded) get().showToast(`同步失败：${api.friendlyError(e)}`)
    } finally {
      set({ syncing: false })
    }
  },

  async signIn(email, password) {
    await api.signIn(email, password)
    set({ auth: 'in' })
    await get().refresh()
  },

  async signOut() {
    await api.signOut()
    try {
      localStorage.removeItem(CACHE_KEY)
    } catch {
      /* ignore */
    }
    set({ auth: 'out', accounts: [], categories: [], transactions: [], loaded: false, lastSync: null })
  },

  async addTx(t) {
    const prev = get().transactions
    const next = [t, ...prev]
    set({ transactions: next })
    writeCache({ ...get(), transactions: next })
    try {
      await api.insertTx(t)
      return true
    } catch (e) {
      set({ transactions: prev })
      writeCache({ ...get(), transactions: prev })
      get().showToast(`保存失败：${api.friendlyError(e)}`)
      return false
    }
  },

  async editTx(t) {
    const prev = get().transactions
    const next = prev.map((x) => (x.id === t.id ? t : x))
    set({ transactions: next })
    writeCache({ ...get(), transactions: next })
    try {
      await api.updateTx(t)
      return true
    } catch (e) {
      set({ transactions: prev })
      writeCache({ ...get(), transactions: prev })
      get().showToast(`修改失败：${api.friendlyError(e)}`)
      return false
    }
  },

  async removeTx(id) {
    const prev = get().transactions
    const next = prev.filter((x) => x.id !== id)
    set({ transactions: next })
    writeCache({ ...get(), transactions: next })
    try {
      await api.deleteTx(id)
      return true
    } catch (e) {
      set({ transactions: prev })
      writeCache({ ...get(), transactions: prev })
      get().showToast(`删除失败：${api.friendlyError(e)}`)
      return false
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
      const categories = [...get().categories, created]
      set({ categories })
      writeCache({ ...get(), categories })
      return created
    } catch (e) {
      get().showToast(`新增分类失败：${api.friendlyError(e)}`)
      return null
    }
  },

  async updateCategory(id, patch) {
    const prev = get().categories
    const next = prev.map((c) => (c.id === id ? { ...c, ...patch } : c))
    set({ categories: next })
    try {
      await api.updateCategory(id, patch)
      writeCache({ ...get(), categories: next })
      return true
    } catch (e) {
      set({ categories: prev })
      get().showToast(`修改分类失败：${api.friendlyError(e)}`)
      return false
    }
  },

  async updateAccount(id, patch) {
    const prev = get().accounts
    const next = prev.map((a) => (a.id === id ? { ...a, ...patch } : a))
    set({ accounts: next })
    try {
      await api.updateAccount(id, patch)
      writeCache({ ...get(), accounts: next })
      return true
    } catch (e) {
      set({ accounts: prev })
      get().showToast(`修改账户失败：${api.friendlyError(e)}`)
      return false
    }
  },

  async importSnapshot(snap) {
    await api.importAll(snap)
    await get().refresh()
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
  return useStore((s) => s.accounts).filter((a) => !a.is_archived).sort((a, b) => a.sort - b.sort)
}
