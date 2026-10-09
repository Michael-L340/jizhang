// 全局状态。页面只从这里读数据、只调这里的动作；这里是唯一调用 api.ts 的地方。
import { useMemo } from 'react'
import { create } from 'zustand'
import type { Account, CatKind, Category, FacadeAdjust, MeterReading, Snapshot, Transaction } from '../types'
import * as api from './api'
import { CACHE_LIMIT_BYTES, cacheBytes, IDB_LIMIT_BYTES, type BackupStatus } from './backup'
import { dropLegacy, LEDGER_KEY, readLedger, readOutboxDump, removeLedger, removeOutboxDump, storageQuota, writeLedger, writeOutboxDump, type Backend } from './cache'
import { nowIso } from './date'
import { applyPending, DELETED, type Pending } from './pending'
import { packOutbox, unpackOutbox, type Outbox, type OutboxDump } from './outbox'
import { INNER_TTL_MS, type Mode } from './facade'

// 账本快照存 IndexedDB、待传队列存 localStorage，存哪、怎么兜底都在 cache.ts；这里只管内容。
interface Cache extends Snapshot {
  at: string
  /**
   * 1.3.30 及以前：待上传队列包在这份缓存里。现在单独存（cache.ts 的 OUTBOX_KEY），新代码写的缓存不带这个键。
   * 所以 localStorage 那份老缓存带着它 = 旧代码写的：首次搬家，或者回退到旧版本又升回来（见 init 的 mergeLegacyOutbox）。
   */
  outbox?: OutboxDump
}

function parseCache(raw: string | null): Cache | null {
  try {
    if (!raw) return null
    const c = JSON.parse(raw) as Cache
    if (!Array.isArray(c.accounts) || !Array.isArray(c.categories) || !Array.isArray(c.transactions)) return null
    // 冷启动先拿缓存渲染，而这份缓存可能是加新列之前的版本写的，那些键根本不存在。
    // undefined 不等于 null，会一路走进算式：dayInMonth(ym, undefined) 算出 "2026-09-NaN"，
    // 「本月应还」在首屏就是错的（等一次同步回来才会自愈）。在入口补齐，别让 undefined 流出去。
    return {
      ...c,
      accounts: c.accounts.map((a) => ({ ...a, repay_day: a.repay_day ?? null, facade_offset: a.facade_offset ?? null, defer_after_repay: a.defer_after_repay ?? null })),
      transactions: c.transactions.map((t) => ({ ...t, installments: t.installments ?? null, settles: t.settles ?? null, hidden: t.hidden ?? null, is_offset: t.is_offset ?? null })),
      // 0010 之前写的缓存没有这一节。补成空数组就行：下一次同步会拉到云端的
      facade_adjusts: Array.isArray(c.facade_adjusts) ? c.facade_adjusts : [],
      // 0011 之前写的缓存没有电表读数，同上
      meter_readings: Array.isArray(c.meter_readings) ? c.meter_readings : [],
    }
  } catch {
    return null
  }
}

interface CacheRead {
  cache: Cache | null
  raw: string | null
  backend: Backend
  /** IndexedDB 这次没读出来（不是「没有」）。这时 state 是白纸，不许拿它去盖本机那份 */
  failed: boolean
  /** localStorage 那份老缓存（不管选没选它）。它带着的 outbox 要并进队列 */
  legacy: Cache | null
}

/**
 * 读缓存。IndexedDB 和 localStorage 两边都可能有一份（上一个会话 IndexedDB 打不开、退回 localStorage 写的），
 * 都在就挑 `at` 新的那份——但**没有账户的那份永远赢不了有账户的**：at 只说明什么时候写的，不说明全不全
 * （和 refresh 里「拉回来账户是空的就不收」同一个判据）。绝不抛：读不到对 App 只是「没有缓存」。
 */
async function readCache(): Promise<CacheRead> {
  const r = await readLedger()
  const a = parseCache(r.idb)
  const b = parseCache(r.local)
  const full = (c: Cache | null) => !!c && c.accounts.length > 0
  const bWins = !!b && (!a || (full(b) && !full(a)) || (full(b) === full(a) && Date.parse(b.at) > Date.parse(a.at)))
  if (bWins) return { cache: b, raw: r.local, backend: r.backend, failed: r.failed, legacy: b }
  return { cache: a, raw: r.idb, backend: r.backend, failed: r.failed, legacy: b }
}

/** 缓存里只放数据表（Snapshot 那几张）和时间戳，不要把整个 store 展开进来（否则 auth/syncing/toast/mode 也会被写） */
function serializeCache(s: Snapshot): string {
  const c: Cache = {
    accounts: s.accounts,
    categories: s.categories,
    transactions: s.transactions,
    facade_adjusts: s.facade_adjusts,
    meter_readings: s.meter_readings,
    at: nowIso(),
  }
  return JSON.stringify(c)
}

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
  /** 本次同步开始的时间戳；卡死超过 STALE_SYNC_MS 就允许重新发起 */
  syncingSince: number | null
  lastSync: string | null
  /** 上次同步是否失败（首次加载成功后失败不再静默）。导出可信度看它，所以一失败就立刻置起来 */
  syncFailed: boolean
  /** 上次同步失败的原因，已经翻成中文。成功后清空 */
  syncError: string | null
  /** 失败了但正在自动重试——界面这时候别报红，也别弹 toast */
  syncRetrying: boolean
  toast: Toast | null
  /** 本机缓存占用字节数（按 UTF-16 算，偏保守），0 表示还没写过 */
  cacheBytes: number
  /** 缓存写不进去了（配额满、被禁用、IndexedDB 挂起），离线看到的数据可能是旧的 */
  cacheDegraded: boolean
  /**
   * 本机缓存的上限（字节）。退回 localStorage 时是固定的 5 MiB；用 IndexedDB 时是浏览器报的配额
   * （`navigator.storage.estimate()`，按手机剩余空间给），浏览器不支持就是 null——设置页据此显示「上限随手机剩余空间」
   */
  cacheQuota: number | null
  /** 待传队列存不进本机（localStorage 满了或被禁）：那几笔只在内存里，关掉 App 就没了 */
  outboxUnsaved: boolean
  /** 每日自动备份的状态（另一个私有仓库跑的，见 backup.ts）。null = 没备份过或还没读到 */
  backup: BackupStatus | null
  /** 备份状态读失败（网络不通 / 登录过期）。和「从来没备份过」要分开显示 */
  backupFailed: boolean
  /** 还没传上云端的记录条数。>0 说明本机比云端多／少几笔，备份里也还没有 */
  outboxCount: number
  /**
   * 里外页面。outer = 平时用的外页面（余额被偏移量修饰过），inner = 只有本人知道的里页面（真实余额）。
   * **绝不写进缓存**：冷启动必须永远是 outer，否则这个开关就没有意义了。
   * persist() 只写数据表，所以这条不用额外处理——但以后有人想「顺手把整个 store 存下来」时，
   * 这就是不能那么干的理由。
   */
  mode: Mode

  init: () => Promise<void>
  /** @param auto 内部自动重试调用时为 true，不重置退避阶梯 */
  refresh: (auto?: boolean) => Promise<void>
  /** 把待上传队列补传到云端。联网时自动调，用户也能手动点 */
  flushOutbox: () => Promise<void>
  /** 去抖写入本机缓存，从当前 state 现读，不接受外部快照 */
  persist: () => void
  /**
   * 读每日自动备份的状态。故意**不**走 refresh() 那套在途补丁 / 超时锁的机制：
   * 它不改账本，一天看一次就够，由设置页挂载时调用。
   * 但「只有最后一次的答案算数」这条必须有（backupSeq），设置页来回切就会有两次在飞。
   */
  loadBackupStatus: () => Promise<void>
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>

  addTx: (t: Transaction) => Promise<boolean>
  editTx: (t: Transaction) => Promise<boolean>
  removeTx: (id: string) => Promise<boolean>

  addCategory: (kind: CatKind, parentId: string | null, name: string) => Promise<Category | null>
  updateCategory: (id: string, patch: Partial<Pick<Category, 'name' | 'icon' | 'sort' | 'is_archived' | 'note' | 'parent_id'>>) => Promise<boolean>
  updateAccount: (id: string, patch: Partial<Pick<Account, 'name' | 'sort' | 'is_archived' | 'facade_offset' | 'defer_after_repay'>>) => Promise<boolean>
  /**
   * 记一条外页面校准（0010）。先写云端再进 state，和 addCategory 一样不做乐观更新：
   * 校准是难得一做的事，失败了让弹层留在原地比「界面先变了再弹回去」清楚。没有离线队列。
   */
  addFacadeAdjust: (f: FacadeAdjust) => Promise<boolean>
  /**
   * 记一条电表读数（0011）。和 addFacadeAdjust 一个路数：先写云端再进 state，不做乐观更新，没有离线队列。
   * 失败弹 toast、返回 false，页面据此把输入框留在原地让人再点一次。
   */
  addMeterReading: (r: MeterReading) => Promise<boolean>
  /**
   * 删一条电表读数。同样先删云端再从 state 拿掉；成功后登记一个「已删除」的在途补丁，
   * 否则一次比删除更早出门的同步落地时，会把这条又带回来。
   */
  removeMeterReading: (id: string) => Promise<boolean>
  /** 合并导入：同 id 覆盖，不删任何东西 */
  importSnapshot: (snap: Snapshot) => Promise<void>
  /**
   * 整库恢复：先清空云端再整份写入。调用方必须已经跟用户确认过，且 snap 必须过了 validate.ts。
   * 中途失败会拿操作前的快照自动回滚一次，失败时抛的是 RestoreFailed，message 可直接显示。
   */
  restoreSnapshot: (snap: Snapshot) => Promise<void>

  setMode: (m: Mode) => void
  /** 切走 App 时记一下时间点 */
  noteHidden: () => void
  /** 切回前台：离开超过 INNER_TTL_MS 就自动退回外页面 */
  noteVisible: () => void

  showToast: (msg: string, undo?: () => void | Promise<void>) => void
  hideToast: () => void
}

/**
 * 上一次切走 App 的时间点。放模块级而不是 state：它只用来算一个判断，
 * 放进 state 会让每次前后台切换都触发一轮全局重渲染。
 */
let hiddenAt: number | null = null

// ── 在途写入的补丁表 ──────────────────────────────────────────
// 一次写请求飞在路上时，refresh() 拉回的快照里还没有它。直接 set 会把它冲掉，
// 用户看到「刚记的那笔消失了」而实际上云端已经存了，很容易重记一遍。
// 所以 refresh 落地前先把在途补丁叠回去。
const pendingTx: Pending<Transaction> = new Map()
const pendingCat: Pending<Category> = new Map()
const pendingFa: Pending<FacadeAdjust> = new Map()
const pendingMr: Pending<MeterReading> = new Map()

// ── 待上传队列 ────────────────────────────────────────────────
// 上面那两张补丁表管的是「请求飞在路上」，60 秒就过期；这一张管的是「请求根本没发出去」，
// 只有真的传上去才删、还要写进缓存跨会话保留。详见 outbox.ts 顶部。
const outboxTx: Outbox = new Map()
/** 补传是串行的，防止 online 事件和 refresh 各触发一次、同一条被传两遍 */
let flushing = false

// 补丁不能一写完就删，那只挡住了一个方向的时序。
// 反过来的顺序照样出事：refresh 先发出 GET（此刻服务端还没有这笔）→ 用户立刻记一笔、
// POST 后发先至并成功 → 那份「比写入更早出门」的快照这时才落地，补丁表已空，
// 于是用过期快照覆盖了正确的状态，刚记的那笔从界面消失、刚删的那条复活。
//
// 正确的退休判据不是「写完了没」，而是「有没有一次在写完之后才出门的同步回来过」。
// 所以给每次真正发出的 GET 编号，写成功时记下当时的号，只有更晚的号回来才允许丢补丁。
let fetchSeq = 0
const settledTx = new Map<string, number>()
const settledCat = new Map<string, number>()
const settledFa = new Map<string, number>()
const settledMr = new Map<string, number>()

// 备份状态这一路也编号，理由同类但简单得多：只有「最后一次问的答案」算数。
// 设置页每次挂载都发一次，来回切页就有两次在飞；退出登录也算改朝换代。
// 不编号有两种翻车：
//   1. 第一次慢且最后失败、第二次快且成功 —— 慢的那次晚回来，把「正常」覆盖成「读不到」；
//   2. 在途那次落在 signOut 之后 —— signOut 刚清掉的备份时间又被写回来。
let backupSeq = 0

/** 快照落地前淘汰已经被这次 GET 覆盖到的补丁。g < my 意味着这次 GET 出门时该写入已经落库 */
function retirePatches(my: number): void {
  for (const [id, g] of settledTx) {
    if (g >= my) continue
    pendingTx.delete(id)
    settledTx.delete(id)
  }
  for (const [id, g] of settledCat) {
    if (g >= my) continue
    pendingCat.delete(id)
    settledCat.delete(id)
  }
  for (const [id, g] of settledFa) {
    if (g >= my) continue
    pendingFa.delete(id)
    settledFa.delete(id)
  }
  for (const [id, g] of settledMr) {
    if (g >= my) continue
    pendingMr.delete(id)
    settledMr.delete(id)
  }
}

/**
 * 写成功：等一次「出门时间晚于本次写入」的同步回来再退休。
 * 兜底定时器是防止长期不同步时补丁表越攒越多；60 秒安全地大于 FETCH_TIMEOUT_MS，
 * 所以不会出现「补丁已删、更早出门的 GET 还在飞」。
 */
function settle(map: Map<string, number>, pending: Map<string, unknown>, id: string): void {
  map.set(id, fetchSeq)
  setTimeout(() => {
    if (map.get(id) === undefined) return
    map.delete(id)
    pending.delete(id)
  }, PATCH_TTL_MS)
}

/** 写失败：立刻删补丁。留着的话，那份还在飞的旧快照落地时会把一条根本没进云端的记录塞回来 */
function drop(map: Map<string, number>, pending: Map<string, unknown>, id: string): void {
  map.delete(id)
  pending.delete(id)
}

/**
 * 写失败且不是数据被拒 —— 也就是没网、网太慢、登录过期 —— 就进待传队列。
 * 补丁表那条要一并删掉：两张表管的是同一个 id 的话，队列才是权威的那个。
 */
/** 返回队列存没存进本机。没存进去时调用方别说「已存在本机」 */
function enqueue(id: string, v: Transaction | typeof DELETED): boolean {
  drop(settledTx, pendingTx, id)
  outboxTx.set(id, v)
  return saveOutbox()
}

/** 离线写入那句 toast：队列没存进本机就不能说「已存在本机」——关掉 App 这几笔就没了 */
function offlineToast(saved: boolean, what: string): string {
  return saved ? `没网，${what}已存在本机，联网后自动上传` : `没网，这台设备也存不下：先别关 App，联网后会自动上传`
}

/** 队列最近一次落盘成功了没有。老缓存（里面包着一份队列）只在它为真时才许删 */
let outboxOnDisk = true

/**
 * 队列一变就立刻落盘（同步的 localStorage），不等账本那 500ms 的去抖：
 * 它是本机唯一一份云端没有的数据，App 在这半秒里被杀掉就是真丢账。
 * 写不进去（配额满、被禁）单独标 outboxUnsaved，**不和账本共用 cacheDegraded**：
 * 账本写成功会清 cacheDegraded，队列只在内存里这件事就从设置页上消失了（审查 F3）。
 */
function saveOutbox(): boolean {
  try {
    writeOutboxDump({ at: nowIso(), entries: packOutbox(outboxTx) })
    outboxOnDisk = true
  } catch {
    outboxOnDisk = false
  }
  if (useStore.getState().outboxUnsaved !== !outboxOnDisk) useStore.setState({ outboxUnsaved: !outboxOnDisk })
  return outboxOnDisk
}

/** 账本写不进去：标降级，只提示一次。云端数据不受影响，但离线看到的会是旧的，必须让用户知道 */
function noteCacheFailure(): void {
  if (useStore.getState().cacheDegraded) return
  useStore.setState({ cacheDegraded: true })
  useStore.getState().showToast('本机缓存写不进去，离线时看到的可能是旧数据')
}

/** 退出登录就换代：之前排上的写入落地时不许再动 state（它写的是上一个账号的账本；删除排在它后面，cache.ts 保证） */
let cacheGen = 0
/** 每次落盘编号：只有最后一次的结果能改 cacheDegraded / cacheBytes（先发的晚到不许覆盖后发的，审查 F16） */
let writeSeq = 0
/**
 * 内存里这本账能不能拿去盖本机缓存。冷启动 IndexedDB 读失败时 state 是一张白纸，
 * 这时写下去会把本机那份好的覆盖成空的（或者带着新的 at 在下次冷启动时赢过它，审查 F9/F14）。
 * 读到了缓存、确实没有缓存、或者同步成功过一次，才是真的
 */
let ledgerTrusted = true

/** 设置页显示上限用。退回 localStorage 就是固定的 5 MiB；IndexedDB 去问浏览器，问不到就是 null */
let quotaBackend: Backend | null = null
function noteBackend(b: Backend): void {
  if (b === quotaBackend) return
  quotaBackend = b
  if (b === 'local') {
    useStore.setState({ cacheQuota: CACHE_LIMIT_BYTES })
    return
  }
  useStore.setState({ cacheQuota: IDB_LIMIT_BYTES })
  void storageQuota().then((q) => {
    if (quotaBackend === 'idb') useStore.setState({ cacheQuota: q === null ? IDB_LIMIT_BYTES : Math.min(q, IDB_LIMIT_BYTES) })
  })
}

/** 已经在队列里的 id 的后续增删改：只改队列和界面，马上试着补传，返回 true（对用户来说已经记下了） */
function queueWrite(id: string, v: Transaction | typeof DELETED, patch: (s: State) => Partial<State>): true {
  if (!enqueue(id, v)) useStore.getState().showToast(offlineToast(false, ''))
  useStore.setState(patch)
  useStore.setState({ outboxCount: outboxTx.size })
  useStore.getState().persist()
  void useStore.getState().flushOutbox()
  return true
}

/** 单次 fetchAll 的超时。没有它，iOS 后台冻结时飞在路上的请求可能永远不 settle */
/**
 * 同步失败后的自动重试间隔。
 *
 * 用户 2026-09-10 反馈：隔一段时间点开 App 就弹「同步失败」，手动点一下重试又好了。
 * 根因是**切回前台/冷启动的第一下请求最容易失败**——手机刚唤醒网络还没就绪，而 JWT
 * 提前 90 秒就算过期（supabase-js 的 EXPIRY_MARGIN_MS），隔久一点打开必然要先换一次
 * token，那也是一个网络请求。而这里以前失败就到此为止：整个 App 只有「切回前台 /
 * online 事件 / 手动点」三个触发点，第一下失败就一直红着。
 *
 * 三档一共等 23 秒。手动点一下就重来一轮（`refresh()` 不带 auto 会把阶梯清零）。
 */
const RETRY_DELAYS_MS = [2_000, 6_000, 15_000]
let retryTimer: ReturnType<typeof setTimeout> | null = null
/** 已经自动重试过几次；成功或用户手动同步都归零 */
let retryAt = 0

function cancelRetry(): void {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
}

const FETCH_TIMEOUT_MS = 30_000
/** 上一次同步超过这个时间还没落地就视为已死，允许重新发起。必须大于 FETCH_TIMEOUT_MS */
const STALE_SYNC_MS = 45_000
/** 在途补丁的兜底存活时间。必须大于 FETCH_TIMEOUT_MS */
const PATCH_TTL_MS = 60_000

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

/**
 * 「整库恢复」失败时抛的错。message 已经是给用户看的**完整**说明——包括云端现在是什么状态、
 * 该怎么办——页面直接原样显示就行，别再往后面拼别的话，那样只会自相矛盾。
 */
export class RestoreFailed extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'RestoreFailed'
  }
}

/**
 * 把磁盘上的待传队列装进内存，返回要不要马上写回 jz_outbox_v1。两个来源：
 *   - jz_outbox_v1：新代码写的，带 at；
 *   - localStorage 老缓存里的 outbox 字段：只有 1.3.30 及以前会写。
 * 规则（审查 F8/F13/F20）：
 *   - 自己的键不存在 → 第一次搬家，整份接老缓存的；
 *   - 老缓存比自己的键新 → 回退到旧版本又升回来：旧代码在这期间离线记的账只在老缓存里。两份**并起来**，
 *     同一笔以老缓存为准（它更新）。只在自己的键里的那几笔（回退期间旧代码看不见）也留着——
 *     宁可补传出一笔重复的，也不能吞掉一笔；
 *   - 否则以自己的键为准：它是上次读老缓存时并出来的，老缓存里的那份已经过时，再并会把传过的旧版本又传一遍。
 */
function mergeOutbox(legacy: Cache | null): boolean {
  const dump = readOutboxDump()
  const old = legacy && legacy.outbox !== undefined ? unpackOutbox(legacy.outbox) : null
  const own = unpackOutbox(dump.found ? dump.entries : null)
  let merged = own
  let dirty = false
  if (!dump.found) {
    merged = old ?? new Map()
    dirty = true
  } else if (old && legacy && (dump.at === null || Date.parse(legacy.at) > Date.parse(dump.at))) {
    merged = new Map([...own, ...old])
    dirty = true
  }
  for (const [id, v] of merged) outboxTx.set(id, v)
  return dirty
}

let toastSeq = 0
let toastTimer: ReturnType<typeof setTimeout> | null = null
let unsubAuth: (() => void) | null = null

export const useStore = create<State>((set, get) => ({
  accounts: [],
  categories: [],
  transactions: [],
  facade_adjusts: [],
  meter_readings: [],
  auth: 'loading',
  loaded: false,
  syncing: false,
  syncingSince: null,
  lastSync: null,
  syncFailed: false,
  syncError: null,
  syncRetrying: false,
  toast: null,
  cacheBytes: 0,
  cacheDegraded: false,
  cacheQuota: null,
  outboxUnsaved: false,
  backup: null,
  backupFailed: false,
  outboxCount: 0,
  mode: 'outer',

  async init() {
    // 读缓存是异步的（IndexedDB），但 App 这时还停在「加载中」（auth 是 loading），
    // 不会先闪一下空账本；cache.ts 有超时，最多等 OPEN_TIMEOUT_MS
    let read: CacheRead = { cache: null, raw: null, backend: 'local', failed: false, legacy: null }
    try {
      read = await readCache()
    } catch {
      /* 读不到就当没有 */
    }
    const { cache, raw, backend, failed } = read
    // 读失败（不是「没有」）：在同步成功之前，内存里这本账不许拿去盖本机那份
    ledgerTrusted = !failed
    // 队列要在拉云端之前装回来，否则第一次 refresh 会把上次没传上去的那几笔冲掉
    if (mergeOutbox(read.legacy)) saveOutbox()
    // 没读到缓存也要把队列叠上去：那几笔是云端没有的，不显示的话首页写着「N 笔还没上传」列表里却找不到
    if (cache || outboxTx.size) {
      set({
        accounts: cache?.accounts ?? [],
        categories: cache?.categories ?? [],
        // 账本和队列分开写、各有各的落盘时间，哪份新不一定；队列是「用户改完、云端至今不知道的最新状态」，叠在最上面
        transactions: applyPending(cache?.transactions ?? [], outboxTx),
        facade_adjusts: cache?.facade_adjusts ?? [],
        meter_readings: cache?.meter_readings ?? [],
        lastSync: cache?.at ?? null,
        cacheBytes: raw ? cacheBytes([[LEDGER_KEY, raw]]) : 0,
      })
    }
    set({ outboxCount: outboxTx.size })
    noteBackend(backend)
    if (failed && !cache) get().showToast('本机缓存这次没读出来，联网后会恢复')
    // 本机存着会话钥匙就先按登录着渲染（缓存的账本马上能看、能记）；下面那句断网时要等 25 秒才回来
    if (api.hasStoredSession()) set({ auth: 'in' })
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

  async refresh(auto = false) {
    if (get().auth !== 'in') return
    // 用户主动来的（切回前台、online、点重试）就把退避阶梯清零，重新给三次机会
    if (!auto) {
      cancelRetry()
      retryAt = 0
    }
    const since = get().syncingSince
    // 「正在同步」曾经是一把没有超时的锁：请求一旦永远不返回，此后整个会话的同步
    // 都会在这一行被静默丢掉，杀掉 App 才能恢复。超过 STALE_SYNC_MS 就当上一次已死。
    if (since !== null && Date.now() - since < STALE_SYNC_MS) return
    const my = ++fetchSeq
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
    set({ syncing: true, syncingSince: Date.now() })
    try {
      const snap = await api.fetchAll(ac.signal)
      if (my !== fetchSeq) return
      // supabase-js 在 session 没了的时候**不会报错**，而是拿 anon key 把请求发出去
      // （`_getAccessToken` 的兜底：`(await getSession()) ?? supabaseKey`）。RLS 一挡，
      // 服务器返回「零行、无错误」。照单全收的话，界面会被清空、`persist()` 还会把
      // 本机缓存一起覆盖成空的——云端数据没事，但离线副本真的没了，而且全程零报错。
      // 账户表永远不该是空的（0001 迁移就预置了四个），所以「拉回来是空的、本地明明有」
      // 只可能是没带上身份，当失败处理，走重试。
      if (!snap.accounts.length && get().accounts.length) throw new Error('Auth session missing!') // 已被更新的一轮取代，这份旧快照不许落地
      // 顺序要紧：先按世代淘汰过期补丁，再把仍在途的叠回去
      retirePatches(my)
      const merged: Snapshot = {
        accounts: snap.accounts,
        categories: applyPending(snap.categories, pendingCat),
        // 两层叠加，顺序不能反：先盖在途补丁，再盖待传队列。
        // 队列在最上面，因为那是用户改完、云端至今不知道的最新状态。
        transactions: applyPending(applyPending(snap.transactions, pendingTx), outboxTx),
        facade_adjusts: applyPending(snap.facade_adjusts, pendingFa),
        meter_readings: applyPending(snap.meter_readings, pendingMr),
      }
      cancelRetry()
      retryAt = 0
      set({ ...merged, loaded: true, lastSync: nowIso(), syncFailed: false, syncError: null, syncRetrying: false })
      ledgerTrusted = true
      get().persist()
      // 网通了，把欠的补上。不 await：补传失败不该让这次同步显示成失败
      void get().flushOutbox()
    } catch (e) {
      if (my !== fetchSeq) return
      // 首次加载成功之后失败也要留痕，否则断网/登录过期/项目休眠全都无声。
      // syncFailed 一失败就置起来（导出可信度看它，宁可保守），但**界面先别喊**：
      // 还有重试机会时只标 syncRetrying，让红条说「正在自动重试」而不是甩个失败给用户。
      const why = api.friendlyError(e)
      // 明确断网就别空转了——重试三次也是白搭，网回来时 online 事件会把它接上
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false
      const canRetry = !offline && retryAt < RETRY_DELAYS_MS.length
      set({ syncFailed: true, syncError: why, syncRetrying: canRetry })
      if (canRetry) {
        const delay = RETRY_DELAYS_MS[retryAt++]
        cancelRetry()
        retryTimer = setTimeout(() => void get().refresh(true), delay)
        return
      }
      if (!get().loaded) get().showToast(`同步失败：${why}`)
    } finally {
      clearTimeout(timer)
      if (my === fetchSeq) set({ syncing: false, syncingSince: null })
    }
  },

  /**
   * 把待传队列补上去。串行、一条一条来，中途再断网就停下，剩下的留到下次。
   *
   * 三个调用点：每次 refresh 成功之后、浏览器 online 事件、用户手动点「立即上传」。
   * 所以必须能重入而不重复发送 —— flushing 那把锁就是干这个的。
   */
  async flushOutbox() {
    if (flushing || get().auth !== 'in' || outboxTx.size === 0) return
    flushing = true
    try {
      // 先拷一份再遍历：循环体里会删 outboxTx，边删边遍历行为不确定
      for (const [id, v] of [...outboxTx.entries()]) {
        try {
          if (v === DELETED) await api.deleteTx(id)
          else await api.upsertTx(v)
          // 和普通写入一样登记在途补丁再 settle：online 事件会同时触发补传和同步，
          // 那次同步出门时这几笔还没落库，落地时它们已经不在队列里，没有补丁就会被冲掉（刚联网，离线记的账消失）
          pendingTx.set(id, v)
          settle(settledTx, pendingTx, id)
          // 只删「我刚传的那一版」。这一条在等响应的几百毫秒里可能又被改过
          // （改的那次也没网，于是队列里换成了新版本）；无条件 delete 会把新版本一起抹掉，
          // 结果云端是旧值、界面是新值、队列空了——再也没有东西会去纠正它。
          if (outboxTx.get(id) === v) outboxTx.delete(id)
          // 传完一笔就落一次盘：补到一半 App 被杀，下次启动不该把传过的旧版本再传一遍（会顶掉别的设备上的改动，审查 F19）
          saveOutbox()
        } catch (e) {
          if (!api.isPermanentError(e)) break // 还是没网，后面的也别试了
          // 数据被拒：重传一万次也是同样结果，只能扔掉并告诉用户。
          // 界面上也要一起撤掉，否则会留下一条「本机有、云端永远没有」的幽灵记录。
          // 同样只删我传的那一版：新版本也许是合法的，该留给下一轮试。
          if (outboxTx.get(id) !== v) continue
          outboxTx.delete(id)
          saveOutbox()
          if (v !== DELETED) set((st) => ({ transactions: st.transactions.filter((x) => x.id !== id) }))
          get().showToast(`有 1 笔上传被拒绝，已从本机移除：${api.friendlyError(e)}`)
        }
      }
    } finally {
      flushing = false
      set({ outboxCount: outboxTx.size })
      saveOutbox()
      get().persist()
    }
  },

  persist() {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      // 冷启动没读出缓存、又还没同步成功过：内存里是白纸，写下去会盖掉本机那份好的
      if (!ledgerTrusted) return
      const { accounts, categories, transactions, facade_adjusts, meter_readings } = get()
      // 序列化在这里同步做（现读 state），落盘是异步的；多次写入由 cache.ts 排成一队，后写的后落地
      const json = serializeCache({ accounts, categories, transactions, facade_adjusts, meter_readings })
      const gen = cacheGen
      const my = ++writeSeq
      writeLedger(json, { dropLegacy: outboxOnDisk }).then(
        (backend) => {
          if (backend === null || gen !== cacheGen || my !== writeSeq) return
          set({ cacheBytes: cacheBytes([[LEDGER_KEY, json]]), cacheDegraded: false })
          noteBackend(backend)
          // localStorage 被老缓存占满、队列写不进去（1.3.30 时代缓存快 5 MiB 的设备）：账本已经进了 IndexedDB、
          // 队列在内存里，老缓存可以删了腾地方，再存一次队列
          if (backend === 'idb' && !outboxOnDisk) void dropLegacy().then(() => saveOutbox())
        },
        () => {
          if (gen !== cacheGen || my !== writeSeq) return
          noteCacheFailure()
        },
      )
    }, 500)
  },

  async loadBackupStatus() {
    const my = ++backupSeq
    let failed = false
    const b = await api.fetchBackupStatus(() => {
      failed = true
    })
    // 已被更新的一轮（或一次 signOut）取代，这份旧答案不许落地
    if (my !== backupSeq) return
    set({ backup: b, backupFailed: failed })
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
    pendingFa.clear()
    pendingMr.clear()
    settledTx.clear()
    settledCat.clear()
    settledFa.clear()
    settledMr.clear()
    // 换个人登录进来必须是外页面
    hiddenAt = null
    set({ mode: 'outer' })
    // 推进号码，让还在飞的那次 loadBackupStatus 回来时自己作废，
    // 否则下面刚清掉的 backup 会被它写回来
    backupSeq++
    // 换代：已经排上、还没落地的那次写入回来时不许再碰 state；cache.ts 的队列保证删一定落在它后面
    cacheGen++
    // 队列也要清：换个账号登进来，把上一个账号的记录补传过去是灾难。
    // 代价是退出登录会丢掉还没传上去的那几笔，所以退出前要拦一下（见 Settings.tsx）。
    outboxTx.clear()
    removeOutboxDump()
    outboxOnDisk = true
    ledgerTrusted = true
    try {
      // 搜索词、筛选、上次用的账户这些也是这个账号的痕迹，一起清。只删自己前缀的键，同一个域名下还住着交易日志
      for (const k of Object.keys(localStorage)) if (/^jz_(ledger_|entry_memory|repay_from|stats_)/.test(k)) localStorage.removeItem(k)
    } catch {
      /* ignore */
    }
    // 不 await：删不掉不该让退出登录失败，顺序由 cache.ts 的队列保证
    void removeLedger()
    // 纯粹是不留垃圾：定时器真响了 refresh() 也会因为 auth 不是 'in' 当场早退，
    // 所以这两行**测不出来**（写过一条用例，加不加都绿，按规矩删了）。留着是为了
    // 退出登录之后别有个定时器还挂在那儿。
    cancelRetry()
    retryAt = 0
    set({ auth: 'out', accounts: [], categories: [], transactions: [], facade_adjusts: [], meter_readings: [], loaded: false, lastSync: null, cacheBytes: 0, cacheDegraded: false, syncFailed: false, syncError: null, syncRetrying: false, syncing: false, syncingSince: null, backup: null, backupFailed: false, outboxCount: 0, outboxUnsaved: false })
  },

  /**
   * 这个 id 还在待传队列里（断网时记的、改的）：不直接发请求，队列里换成新状态再补传。
   * 直接发的话：update / delete 命中 0 行不报错，当成功，但队列里的旧版本还在，
   * 下次同步「队列在最上面」把界面打回旧值，补传再把旧值写进云端——改动丢了、删掉的复活。
   */
  async addTx(t) {
    if (outboxTx.has(t.id)) return queueWrite(t.id, t, (s) => ({ transactions: [t, ...s.transactions.filter((x) => x.id !== t.id)] }))
    pendingTx.set(t.id, t)
    // 函数式 set + 按 id 打补丁：整数组快照回滚会把并发操作的结果一起抹掉
    set((s) => ({ transactions: [t, ...s.transactions] }))
    get().persist()
    try {
      await api.insertTx(t)
      // 成功不能立刻删补丁：可能有一次「比这次写入更早出门」的同步还在飞，
      // 它落地时会用一份没有这笔的快照把界面盖回去
      settle(settledTx, pendingTx, t.id)
      return true
    } catch (e) {
      // 数据被服务器拒了：立刻删干净。留着的话那份旧快照落地时会把一条根本没进云端的
      // 记录塞回来，用户明明看到「保存失败」，账本里却多出一笔幽灵记录
      if (api.isPermanentError(e)) {
        drop(settledTx, pendingTx, t.id)
        set((s) => ({ transactions: s.transactions.filter((x) => x.id !== t.id) }))
        get().persist()
        get().showToast(`保存失败：${api.friendlyError(e)}`)
        return false
      }
      // 没网：这笔留在界面上，进待传队列，联网后自动补。
      // 返回 true 是故意的——对用户来说这笔账**已经记下了**，页面该照常收尾。
      const saved = enqueue(t.id, t)
      set({ outboxCount: outboxTx.size })
      get().persist()
      get().showToast(offlineToast(saved, ''))
      return true
    }
  },

  async editTx(t) {
    if (outboxTx.has(t.id)) return queueWrite(t.id, t, (s) => ({ transactions: s.transactions.map((x) => (x.id === t.id ? t : x)) }))
    const before = get().transactions.find((x) => x.id === t.id)
    pendingTx.set(t.id, t)
    set((s) => ({ transactions: s.transactions.map((x) => (x.id === t.id ? t : x)) }))
    get().persist()
    try {
      await api.updateTx(t)
      settle(settledTx, pendingTx, t.id)
      return true
    } catch (e) {
      if (api.isPermanentError(e)) {
        drop(settledTx, pendingTx, t.id)
        // 用 map 换回旧值而不是插回去：这条可能已被并发删除，插回去会让它复活
        if (before) set((s) => ({ transactions: s.transactions.map((x) => (x.id === t.id ? before : x)) }))
        get().persist()
        get().showToast(`修改失败：${api.friendlyError(e)}`)
        return false
      }
      // 没网：改完的样子留在界面上，队列里存最终状态。
      // 这条本来就在队列里（断网时记的）也没关系——一个 id 只有一条，直接覆盖。
      const saved = enqueue(t.id, t)
      set({ outboxCount: outboxTx.size })
      get().persist()
      get().showToast(offlineToast(saved, '改动'))
      return true
    }
  },

  async removeTx(id) {
    if (outboxTx.has(id)) return queueWrite(id, DELETED, (s) => ({ transactions: s.transactions.filter((x) => x.id !== id) }))
    const row = get().transactions.find((x) => x.id === id)
    pendingTx.set(id, DELETED)
    set((s) => ({ transactions: s.transactions.filter((x) => x.id !== id) }))
    get().persist()
    try {
      await api.deleteTx(id)
      settle(settledTx, pendingTx, id)
      return true
    } catch (e) {
      if (api.isPermanentError(e)) {
        drop(settledTx, pendingTx, id)
        // 位置无所谓：列表都靠 groupByDay/sortTxs 重排。但要幂等，
        // 万一 refresh 已经把它拉回来了，不能插成两条
        if (row) set((s) => (s.transactions.some((x) => x.id === id) ? s : { transactions: [row, ...s.transactions] }))
        get().persist()
        get().showToast(`删除失败：${api.friendlyError(e)}`)
        return false
      }
      // 没网：界面上就当删了，队列里记一条「删除」。
      // 就算这笔本来也没传上去过（断网记的、断网又删的），补传时 delete 一个
      // 云端不存在的 id 是安全的空操作，不用额外记「它到底进没进过云端」。
      const saved = enqueue(id, DELETED)
      set({ outboxCount: outboxTx.size })
      get().persist()
      get().showToast(offlineToast(saved, '删除'))
      return true
    }
  },

  async addCategory(kind, parentId, name) {
    const trimmed = name.trim()
    if (!trimmed) return null
    const findSame = (): Category | undefined => get().categories.find((c) => c.kind === kind && c.parent_id === parentId && c.name === trimmed)
    // 同名的分类已经在库里：直接复用它。分类只归档不删除，同名多半就是同一件事，
    // 所以归档过的要原地取消归档——但必须说一声，历史记录会跟着一起回来，
    // 不吭声的话用户以为自己建了个干干净净的新分类。
    const reuse = async (existing: Category): Promise<Category> => {
      if (existing.is_archived && (await get().updateCategory(existing.id, { is_archived: false }))) {
        get().showToast(`「${existing.name}」之前归档过，已经恢复，历史记录一起回来了`)
      }
      return existing
    }
    const existing = findSame()
    if (existing) return await reuse(existing)
    const siblings = get().categories.filter((c) => c.kind === kind && c.parent_id === parentId)
    const sort = siblings.reduce((m, c) => Math.max(m, c.sort), 0) + 1
    try {
      const created = await api.addCategory({ kind, parent_id: parentId, name: trimmed, sort })
      // 登记为在途：紧接着的一次 refresh 可能还拉不到它，会把它冲掉
      pendingCat.set(created.id, created)
      settle(settledCat, pendingCat, created.id)
      set((st) => ({ categories: [...st.categories, created] }))
      get().persist()
      return created
    } catch (e) {
      // 网慢时连点两次「确定」：两个请求都出了门，第二个被唯一索引挡下。
      // 这不是失败——分类已经建好了，弹一句红字反而让人以为没建成，再去点第三次。
      // 先看本地（第一次请求的结果可能已经落到 state 里），本地没有就同步一次再找，
      // 都找不到才是真的失败。
      if (api.isDuplicateName(e)) {
        const local = findSame()
        if (local) return await reuse(local)
        await pullAfterWrite(get)
        const synced = findSame()
        if (synced) return await reuse(synced)
      }
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
      settle(settledCat, pendingCat, id)
      get().persist()
      return true
    } catch (e) {
      drop(settledCat, pendingCat, id)
      if (before) set((s) => ({ categories: s.categories.map((c) => (c.id === id ? before : c)) }))
      get().showToast(`修改分类失败：${api.friendlyError(e)}`)
      return false
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

  async addFacadeAdjust(f) {
    try {
      await api.insertFacadeAdjust(f)
      // 登记为在途：紧接着的一次 refresh 可能还拉不到它，会把它冲掉（和 addCategory 一样）
      pendingFa.set(f.id, f)
      settle(settledFa, pendingFa, f.id)
      set((s) => ({ facade_adjusts: [...s.facade_adjusts, f] }))
      get().persist()
      return true
    } catch (e) {
      // 措辞不带「外页面」：这条 toast 会在外页面上弹，外页面不许出现任何露馅的字（CLAUDE.md）
      get().showToast(`校准失败：${api.friendlyError(e)}`)
      return false
    }
  },

  async addMeterReading(r) {
    try {
      await api.insertMeterReading(r)
      // 登记为在途：紧接着的一次 refresh 可能还拉不到它，会把它冲掉（和 addFacadeAdjust 一样）
      pendingMr.set(r.id, r)
      settle(settledMr, pendingMr, r.id)
      // 同一条可能已经被同步带回来了（插入还没返回时跑了一次 refresh），按 id 去重，别让列表里出现两份
      set((s) => ({ meter_readings: [...s.meter_readings.filter((x) => x.id !== r.id), r] }))
      get().persist()
      return true
    } catch (e) {
      get().showToast(`记录读数失败：${api.friendlyError(e)}`)
      return false
    }
  },

  async removeMeterReading(id) {
    try {
      await api.deleteMeterReading(id)
      // 反方向的同一件事：删之前就出门的那次同步还带着这条，落地时不能让它复活
      pendingMr.set(id, DELETED)
      settle(settledMr, pendingMr, id)
      set((s) => ({ meter_readings: s.meter_readings.filter((x) => x.id !== id) }))
      get().persist()
      return true
    } catch (e) {
      get().showToast(`删除读数失败：${api.friendlyError(e)}`)
      return false
    }
  },

  async importSnapshot(snap) {
    try {
      await api.importAll(snap, { onlyNew: true })
    } finally {
      // importAll 每 500 条一批逐批提交，失败时前面的批次已经在云端了。
      // 不管成败都把界面拉到云端真实状态，否则用户看到的是「什么都没发生」。
      await pullAfterWrite(get)
    }
  },

  async restoreSnapshot(snap) {
    // 回滚底稿。wipeAll 一执行，云端就没有第二份了，所以先把「操作前的样子」留在内存里。
    // 它只是本机现在显示的样子：本次会话没同步成功过的话，它可能比云端少几条——
    // 页面在确认框里已经就这一点提醒过用户（Settings.tsx 的 exportTrustworthy 那段）。
    const before: Snapshot = {
      accounts: get().accounts,
      categories: get().categories,
      transactions: get().transactions,
      facade_adjusts: get().facade_adjusts,
      meter_readings: get().meter_readings,
    }
    // 电表读数也算：只记过电表、没记过账的话，失败时同样要写回去，否则「已经退回操作前的样子」是假话
    const hadData = before.accounts.length > 0 || before.categories.length > 0 || before.transactions.length > 0 || before.meter_readings.length > 0
    try {
      await api.wipeAll()
      await api.importAll(snap)
    } catch (e) {
      const why = api.friendlyError(e)
      // wipeAll 的第一句（0011 起是删电表读数）就失败 = 云端还没被动过，没什么可回滚的，也别吓唬人。
      // 'facade_adjusts' 已经不是第一句了：它失败时电表读数已经删掉，必须走下面的回滚
      if ((e as Partial<api.WipeFailure>).step === 'meter_readings') {
        // 「第一句就失败」多半是真没删成；但响应在路上丢了的话，那句 DELETE 其实执行了。
        // 电表读数写回去是安全的（按 id 覆盖），顺手做一遍，这句话才敢说「还是原来的样子」
        if (before.meter_readings.length) {
          try {
            await api.upsertMeterReadings(before.meter_readings)
          } catch {
            /* 没网：本来就没删成 */
          }
        }
        throw new RestoreFailed(`恢复失败：${why}。云端一条数据都没删，账本还是原来的样子，联网之后可以再试一次。`)
      }
      // 到这里云端已经被清空（或清了一半），必须立刻把底稿写回去。
      // importAll 是按 id 的 upsert，重复执行安全；每 500 条一批，不是事务。
      let rollbackErr: string | null = null
      if (hadData) {
        try {
          await api.importAll(before)
        } catch (e2) {
          rollbackErr = api.friendlyError(e2)
        }
      }
      throw new RestoreFailed(
        rollbackErr === null
          ? `恢复失败：${why}。你的账本已经退回操作前的样子（备份文件里有、操作前没有的记录可能还留着，多出来的看一眼条数就知道）。`
          : `恢复失败：${why}。自动退回也没成功（${rollbackErr}），云端现在可能只有一部分数据。` +
            '别在这个页面上做别的操作：手机里那个备份文件先别删，等有网了回到这一页，用同一个文件再走一次「整库恢复」——' +
            '同一个文件重复导入是安全的，不会变成两份。',
      )
    } finally {
      await pullAfterWrite(get)
    }
  },

  setMode(m) {
    if (get().mode !== m) set({ mode: m })
  },

  noteHidden() {
    hiddenAt = Date.now()
  },

  noteVisible() {
    // 你在里页面时最常做的事恰恰是切去银行 App 查余额再切回来，所以「一切走就回外」太烦；
    // 但要是把手机放下走开了，回来时它得已经变回外页面。60 秒是这两件事的折中。
    if (get().mode === 'inner' && hiddenAt !== null && Date.now() - hiddenAt >= INNER_TTL_MS) {
      set({ mode: 'outer' })
    }
    hiddenAt = null
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
