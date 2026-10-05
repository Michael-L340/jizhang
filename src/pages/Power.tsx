import { lazy, Suspense, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sheet } from '../components/Sheet'
import { fmtIsoZh, nowIso } from '../lib/date'
import { newId } from '../lib/id'
import {
  beijingDayOf,
  costCents,
  dailyUsage,
  DAY_MS,
  fmtDuration,
  fmtKwh,
  fmtReading,
  fmtSpan,
  hourProfile,
  peakHours,
  intervals,
  parsePrice,
  parseReading,
  preview,
  PRICE_KEY,
  sortReadings,
  summarize,
} from '../lib/meter'
import { dailyOption, hourOption } from '../lib/meterChart'
import { fmtYuan } from '../lib/money'
import { useStore } from '../lib/store'
import type { MeterReading } from '../types'

const Chart = lazy(() => import('../components/Chart'))

/** 最近读数列表先列几条，「看全部」再展开 */
const LIST_FIRST = 8

function readPrice(): number | null {
  try {
    const v = parsePrice(localStorage.getItem(PRICE_KEY) ?? '')
    return v ?? null
  } catch {
    return null
  }
}

/** 北京时间的 datetime-local 值（2026-10-03T21:40）↔ 时间戳 */
const toLocalInput = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 16)
const fromLocalInput = (v: string) => Date.parse(`${v}:00+08:00`)

/**
 * 设置 → 用电记录（2026-10-03）：看一眼电表、输入累计读数，一天几次都行；
 * 页面把读数换算成「今天用了几度、每天多少、一天里几点最费电、这个月大概多少钱」。算法全在 lib/meter.ts。
 * 和里外页面无关，两边看到的一样。
 */
export function Power() {
  const nav = useNavigate()
  const readings = useStore((s) => s.meter_readings)
  const addMeterReading = useStore((s) => s.addMeterReading)
  const removeMeterReading = useStore((s) => s.removeMeterReading)
  const [price, setPriceState] = useState(readPrice)
  const [entryOpen, setEntryOpen] = useState(false)
  const [priceOpen, setPriceOpen] = useState(false)
  const [picked, setPicked] = useState<MeterReading | null>(null)
  const [showAll, setShowAll] = useState(false)
  // 页面打开那一刻算「今天」「这个月」；记了一次之后跟着读数重算
  const now = useMemo(() => new Date(), [readings])

  const sorted = useMemo(() => sortReadings(readings), [readings])
  const last = sorted[sorted.length - 1]
  const sum = useMemo(() => summarize(readings, now), [readings, now])
  const todayYmd = beijingDayOf(now.getTime())
  const days = useMemo(() => dailyUsage(readings, beijingDayOf(now.getTime() - 29 * DAY_MS), todayYmd), [readings, now, todayYmd])
  // 一天里几点最费电：最近 30 天
  const slots = useMemo(() => hourProfile(readings, now.getTime() - 30 * DAY_MS, now.getTime()), [readings, now])
  const topHours = useMemo(() => peakHours(slots), [slots])
  const hasSlots = slots.some((x) => x.perHour !== null)
  const ivs = useMemo(() => intervals(readings), [readings])
  // 列表里每条读数旁边写「比上一次多几度」：按到达这条的那一段查
  const ivTo = useMemo(() => new Map(ivs.map((iv) => [iv.to.id, iv])), [ivs])
  const newestFirst = useMemo(() => [...sorted].reverse(), [sorted])
  const money = (centi: number | null) => (price && centi !== null ? ` · 今天约 ¥${fmtYuan(costCents(centi, price))}` : '')

  function savePrice(v: number | null) {
    try {
      if (v === null) localStorage.removeItem(PRICE_KEY)
      else localStorage.setItem(PRICE_KEY, String(v))
    } catch {
      /* 存储被禁用：这次打开里照样用 */
    }
    setPriceState(v)
  }

  return (
    <div className="px-4 pb-8">
      <div className="flex items-center justify-between pt-4 pb-1">
        <button type="button" className="text-brand-ink text-sm -ml-1 px-1 py-1 w-16 text-left" onClick={() => nav(-1)}>
          ‹ 设置
        </button>
        <span className="text-lg font-bold">用电记录</span>
        <span className="w-16 flex justify-end">
          <button type="button" className="chip on" style={{ padding: '6px 12px', fontSize: 13 }} onClick={() => setEntryOpen(true)}>
            记一次
          </button>
        </span>
      </div>
      <div className="text-center text-xs text-muted mb-3 num">{last ? `电表上次读数 ${fmtReading(last.centi_kwh)} · ${fmtIsoZh(last.read_at)}` : ' '}</div>

      {sorted.length === 0 ? (
        <div className="text-center text-muted text-sm py-16 leading-relaxed">
          还没有记录。
          <br />
          点右上角「记一次」，输入电表上的读数。
          <br />
          记两次以上就能看出用了多少电。
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div className="card px-4 py-3 col-span-2">
              <div className="text-xs text-muted">今天到现在</div>
              <div className="num text-[34px] font-semibold leading-tight">
                {fmtKwh(sum.today)}
                <span className="text-sm font-normal text-muted"> 度</span>
              </div>
              <div className="text-xs text-muted">
                {sum.avg7 === null ? '记满一整天之后，这里会写日均' : `近 7 天日均 ${fmtKwh(sum.avg7)} 度`}
                {money(sum.today)}
              </div>
            </div>
            <div className="card px-4 py-3">
              <div className="text-xs text-muted">{Number(todayYmd.slice(5, 7))} 月已用</div>
              <div className="num text-[22px] font-semibold">
                {fmtKwh(sum.month)}
                <span className="text-xs font-normal text-muted"> 度</span>
              </div>
              <div className="text-xs text-muted num">{price ? `≈ ¥${fmtYuan(costCents(sum.month, price))}` : ' '}</div>
            </div>
            <div className="card px-4 py-3">
              <div className="text-xs text-muted">本月预计</div>
              <div className="num text-[22px] font-semibold">
                {sum.projected === null ? '—' : fmtKwh(sum.projected)}
                {sum.projected === null ? null : <span className="text-xs font-normal text-muted"> 度</span>}
              </div>
              <div className="text-xs text-muted num">{sum.projected !== null && price ? `≈ ¥${fmtYuan(costCents(sum.projected, price))}` : sum.projected === null ? '要先有日均' : ' '}</div>
            </div>
          </div>

          <div className="card p-4 mt-3">
            <div className="flex items-baseline justify-between mb-1">
              <span className="font-semibold">每天用了多少度</span>
              <span className="text-[11px] text-muted">最近 30 天</span>
            </div>
            <Suspense fallback={<div style={{ height: 180 }} />}>
              <Chart option={dailyOption(days, sum.avg7)} height={180} />
            </Suspense>
            <div className="text-[11px] text-muted leading-relaxed mt-1">读数不用在零点记：两次读数之间用的电，按时间平均分到每一天。浅色的柱子是那天还没算全（比如今天）。</div>
          </div>

          <div className="card p-4 mt-3">
            <div className="flex items-baseline justify-between mb-1">
              <span className="font-semibold">一天里几点最费电</span>
              <span className="text-[11px] text-muted">最近 30 天 · 平均每小时几度</span>
            </div>
            {ivs.length ? (
              <Suspense fallback={<div style={{ height: 170 }} />}>
                <Chart option={hourOption(slots)} height={170} />
              </Suspense>
            ) : (
              <div className="text-sm text-muted py-8 text-center">记两次以上才画得出来</div>
            )}
            <div className="text-[11px] text-muted leading-relaxed mt-1">
              {topHours.length ? `最费电的钟点：${topHours.map((h) => `${h} 点`).join('、')}（深色那几根）。` : hasSlots ? '各钟点差不多高（两次读数隔得久就会这样），一天多记几次才看得出。' : ''}
              两次读数之间用的电按时间平均分到每个钟点，再把 30 天里同一个钟点合起来平均。一天记得越勤越准。
            </div>
          </div>

          <div className="card px-4 pt-3 pb-1 mt-3">
            <div className="flex items-baseline justify-between mb-1">
              <span className="font-semibold">最近的读数</span>
              <span className="text-[11px] text-muted">一行 = 上一次到这一次</span>
            </div>
            {(showAll ? newestFirst : newestFirst.slice(0, LIST_FIRST)).map((r) => {
              const iv = ivTo.get(r.id)
              return (
                <button key={r.id} type="button" className="w-full flex justify-between items-center gap-2 py-2.5 border-t border-line first-of-type:border-0 text-left" onClick={() => setPicked(r)}>
                  {iv ? (
                    <>
                      <span className="min-w-0">
                        <span className="block num text-[14px] whitespace-nowrap">{fmtSpan(iv.from.read_at, iv.to.read_at)}</span>
                        <span className="block text-[11.5px] text-muted num">
                          读数 {fmtReading(iv.from.centi_kwh)} → {fmtReading(iv.to.centi_kwh)} · {fmtDuration(iv.hours)}
                        </span>
                      </span>
                      <span className="text-right shrink-0">
                        <span className="block num text-[15px]" style={{ color: 'var(--color-balance)' }}>+{fmtKwh(iv.used)} 度</span>
                        <span className="block text-[11.5px] text-muted num">每小时 {(iv.perHour / 100).toFixed(2)} 度</span>
                      </span>
                    </>
                  ) : (
                    <>
                      <span>
                        <span className="block num text-[14px]">{fmtIsoZh(r.read_at)}</span>
                        <span className="block text-[11.5px] text-muted num">读数 {fmtReading(r.centi_kwh)}</span>
                      </span>
                      <span className="text-[11.5px] text-muted">{r === sorted[0] ? '第一次记录' : '比上一次还小，没算'}</span>
                    </>
                  )}
                </button>
              )
            })}
            {newestFirst.length > LIST_FIRST ? (
              <button type="button" className="w-full text-center text-xs text-brand-ink py-2.5 border-t border-line" onClick={() => setShowAll(!showAll)}>
                {showAll ? '收起' : `看全部 ${newestFirst.length} 条`}
              </button>
            ) : null}
          </div>
        </>
      )}

      <button type="button" className="card w-full mt-3 px-4 py-3 flex justify-between items-center text-left" onClick={() => setPriceOpen(true)}>
        <span>
          <span className="block text-[15px]">电价</span>
          <span className="block text-xs text-muted">填了就按它估电费；存在这台手机上</span>
        </span>
        <span className="text-sm text-brand-ink num">{price ? `${price} 元/度` : '没填 ›'}</span>
      </button>

      {entryOpen ? (
        <EntrySheet
          readings={readings}
          onClose={() => setEntryOpen(false)}
          onSave={async (centi, at) => {
            const ok = await addMeterReading({ id: newId(), read_at: new Date(at).toISOString(), centi_kwh: centi, created_at: nowIso() })
            if (ok) setEntryOpen(false)
          }}
        />
      ) : null}

      <PriceSheet open={priceOpen} price={price} onClose={() => setPriceOpen(false)} onSave={(v) => (savePrice(v), setPriceOpen(false))} />

      <Sheet open={picked !== null} onClose={() => setPicked(null)} title="这条读数">
        {picked ? (
          <>
            <div className="num text-2xl font-semibold text-center mt-2">{fmtReading(picked.centi_kwh)} 度</div>
            <div className="text-center text-sm text-muted mb-4 num">{fmtIsoZh(picked.read_at)}</div>
            <div className="text-xs text-muted mb-3 leading-relaxed">记错了就删掉再记一次。删掉之后，前后两次读数会直接连起来算。</div>
            <div className="flex gap-2">
              <button type="button" className="flex-1 chip text-center" onClick={() => setPicked(null)}>
                取消
              </button>
              <button
                type="button"
                className="flex-1 chip text-center text-expense"
                onClick={async () => {
                  const ok = await removeMeterReading(picked.id)
                  if (ok) setPicked(null)
                }}
              >
                删除这条读数
              </button>
            </div>
          </>
        ) : null}
      </Sheet>
    </div>
  )
}

function EntrySheet({ readings, onClose, onSave }: { readings: MeterReading[]; onClose: () => void; onSave: (centi: number, at: number) => Promise<void> }) {
  const [text, setText] = useState('')
  const [at, setAt] = useState(() => Date.now())
  const [editTime, setEditTime] = useState(false)
  const [busy, setBusy] = useState(false)
  const centi = parseReading(text)
  const p = centi === null ? null : preview(readings, centi, new Date(at))
  const future = at > Date.now() + 60_000
  const ok = centi !== null && !future && !busy

  return (
    <Sheet open onClose={onClose} title="记一次电表读数">
      <div className="flex items-baseline justify-center gap-1.5 mt-3">
        <input
          autoFocus
          inputMode="decimal"
          className="num text-[34px] font-semibold text-center bg-transparent outline-none w-48 border-b border-line"
          placeholder="电表上的数"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <span className="text-sm text-muted">度</span>
      </div>
      <div className="text-center text-sm text-muted mt-2">
        {editTime ? (
          <input type="datetime-local" className="bg-bg rounded-lg px-2 py-1 text-ink" value={toLocalInput(at)} max={toLocalInput(Date.now())} onChange={(e) => e.target.value && setAt(fromLocalInput(e.target.value))} />
        ) : (
          <>
            时间 <span className="text-ink">现在 {fmtIsoZh(new Date(at).toISOString())}</span>
            <button type="button" className="text-brand-ink ml-2" onClick={() => setEditTime(true)}>
              补记改时间
            </button>
          </>
        )}
      </div>
      <div className="mt-3 rounded-xl px-3 py-2.5 text-[12.5px] leading-relaxed min-h-[58px] bg-bg">
        {centi === null ? (
          <span className="text-muted">{text.trim() ? '读数只能是数字，最多两位小数' : readings.length ? '输入后马上算出比上次多了几度' : '这是第一次记录，记第二次就能算出用了多少'}</span>
        ) : future ? (
          <span className="text-expense">时间不能填在以后</span>
        ) : !p ? (
          <span className="text-muted">{readings.length ? '这个时间之前没有读数，它会是最早的一条' : '这是第一次记录，记第二次就能算出用了多少'}</span>
        ) : p.lower ? (
          <span className="text-expense">
            比上次（{fmtReading(p.prev.centi_kwh)}，{fmtIsoZh(p.prev.read_at)}）还小 {fmtKwh(-p.used)} 度。是输错了，还是换了电表？
            <br />
            换表的话照样保存，这一段不算用电。
          </span>
        ) : (
          <>
            <b className="text-[14px]" style={{ color: "var(--color-balance)" }}>比上次多 {fmtKwh(p.used)} 度</b>
            <br />
            <span className="text-muted">
              上次 {fmtReading(p.prev.centi_kwh)}（{fmtIsoZh(p.prev.read_at)}），过了 {fmtDuration(p.hours)}
              {p.perHour !== null ? `，每小时 ${(p.perHour / 100).toFixed(2)} 度` : ''}
            </span>
          </>
        )}
      </div>
      <button
        type="button"
        disabled={!ok}
        className={`w-full mt-4 py-3 rounded-xl font-semibold ${ok ? 'bg-brand text-on-brand' : 'bg-bg text-muted'}`}
        onClick={async () => {
          if (centi === null) return
          setBusy(true)
          try {
            await onSave(centi, at)
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? '保存中…' : '保存'}
      </button>
    </Sheet>
  )
}

function PriceSheet({ open, price, onClose, onSave }: { open: boolean; price: number | null; onClose: () => void; onSave: (v: number | null) => void }) {
  const [text, setText] = useState(price ? String(price) : '')
  const v = parsePrice(text)
  return (
    <Sheet open={open} onClose={onClose} title="电价">
      <div className="flex items-baseline justify-center gap-1.5 mt-3">
        <input inputMode="decimal" className="num text-[28px] font-semibold text-center bg-transparent outline-none w-36 border-b border-line" placeholder="比如 1.2" value={text} onChange={(e) => setText(e.target.value)} />
        <span className="text-sm text-muted">元/度</span>
      </div>
      <div className="text-xs text-muted text-center mt-2 mb-4">{v === undefined ? '只能填正数，最多四位小数' : '问房东每度电多少钱。清空就只显示度数'}</div>
      <button type="button" disabled={v === undefined} className={`w-full py-3 rounded-xl font-semibold ${v === undefined ? 'bg-bg text-muted' : 'bg-brand text-on-brand'}`} onClick={() => v !== undefined && onSave(v)}>
        保存
      </button>
    </Sheet>
  )
}
