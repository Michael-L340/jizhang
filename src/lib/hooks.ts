import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Account, Category } from '../types'
import { useStore } from './store'
import { packRecent, RECENT_MS, unpackRecent } from './recent'

export function useAccountMap(): Map<string, Account> {
  const accounts = useStore((s) => s.accounts)
  return useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])
}

export function useCategoryMap(): Map<string, Category> {
  const categories = useStore((s) => s.categories)
  return useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
}

/** 记住用户的选择：切页面再回来保持原样，重开 App 也还在 */
export function usePersistedState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? initial : (JSON.parse(raw) as T)
    } catch {
      return initial
    }
  })
  const set = useCallback(
    (next: T) => {
      setValue(next)
      try {
        localStorage.setItem(key, JSON.stringify(next))
      } catch {
        /* 存储被禁用时只保留内存里的值 */
      }
    },
    [key],
  )
  return [value, set]
}

/**
 * 最近用过就保留的状态：切页面、点进一笔再回来还在；超过 RECENT_MS 没碰就回到默认。
 * 给「当前看的月份」「搜索词」这种属于本次使用的东西用；长期偏好用 usePersistedState。
 * 打开时还新鲜就顺手续期，连着用就一直不丢。
 */
export function useRecentState<T>(key: string, initial: T | (() => T)): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    let raw: string | null = null
    try {
      raw = localStorage.getItem(key)
    } catch {
      /* 存储被禁用 */
    }
    const kept = unpackRecent<T>(raw, Date.now(), RECENT_MS)
    if (kept === undefined) return typeof initial === 'function' ? (initial as () => T)() : initial
    saveRecent(key, kept)
    return kept
  })
  const set = useCallback(
    (next: T) => {
      setValue(next)
      saveRecent(key, next)
    },
    [key],
  )
  return [value, set]
}

function saveRecent(key: string, value: unknown) {
  try {
    localStorage.setItem(key, packRecent(value, Date.now()))
  } catch {
    /* ignore */
  }
}

/** 读写 localStorage 的小工具，失败时静默 */
export function loadLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback
  } catch {
    return fallback
  }
}

export function saveLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* ignore */
  }
}
