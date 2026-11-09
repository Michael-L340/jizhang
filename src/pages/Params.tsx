import { useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { nowIso } from '../lib/date'
import { numHint, numRowView, numToSave, PRICE_HINT, priceHint, priceText, priceToSave } from '../lib/paramsView'
import { effectivePrice } from '../lib/powerPrice'
import { changedCount, NUM_PREFS, numPref, PRICE_PREF, prefRow, valueLabel, type NumPrefSpec } from '../lib/prefs'
import { useStore } from '../lib/store'

/**
 * 设置 → 参数（2026-11-09，用户：「之后可能有很多需要更改的，可以统一管理。还是放在云上保存吧」）。
 * 现在只有「用电」一组：往回看几天的五个数 + 电价。存云端 prefs 表（lib/prefs.ts 登记表），和用电备注同一套待传队列。
 * 样子是用户看效果图选的「甲」：三个常用值的胶囊 + 一格「自定义」，点了出输入框；只收范围内的整数，填坏了不改值。
 * 敲字时不存，失焦或回车才存。和里外页面无关，两边一样。
 */
export function Params() {
  const nav = useNavigate()
  const prefs = useStore((s) => s.prefs)
  const savePref = useStore((s) => s.savePref)
  const removePref = useStore((s) => s.removePref)
  const [resetting, setResetting] = useState(false)
  const changed = changedCount(prefs)

  // 恢复默认 = 把五个数那几行删掉（没有那一行就是默认）；电价不动
  async function reset() {
    if (resetting || !changed) return
    setResetting(true)
    try {
      for (const s of NUM_PREFS) if (prefs.some((p) => p.id === s.id)) await removePref(s.id)
    } finally {
      setResetting(false)
    }
  }

  return (
    <div className="px-4 pb-8">
      <div className="flex items-center justify-between pt-4 pb-3">
        <button type="button" className="text-brand-ink text-sm -ml-1 px-1 py-1 w-16 text-left" onClick={() => nav(-1)}>
          ‹ 设置
        </button>
        <span className="text-lg font-bold">参数</span>
        <span className="w-16" />
      </div>

      <div className="mb-3">
        <div className="text-[11px] text-muted px-1 mb-1.5 tracking-wide">用电</div>
        <div className="card px-4">
          {NUM_PREFS.map((s) => (
            <NumRow key={s.key} spec={s} value={numPref(prefs, s.key)} onSave={(n) => savePref(prefRow(s.id, s.key, String(n), nowIso()))} />
          ))}
          <PriceRow price={effectivePrice(prefs)} onSave={(v) => savePref(prefRow(PRICE_PREF.id, PRICE_PREF.key, v, nowIso()))} />
        </div>
      </div>

      <button type="button" disabled={!changed || resetting} className="block mx-auto mt-4 px-3 py-1.5 text-[13px] text-muted disabled:opacity-40" onClick={() => void reset()}>
        恢复默认
      </button>
    </div>
  )
}

/** 一项「往回看几天」：名字 + 默认、一行小字、胶囊（三个常用值 + 自定义）、要的时候出输入框 */
function NumRow({ spec, value, onSave }: { spec: NumPrefSpec; value: number; onSave: (n: number) => Promise<boolean> }) {
  // 保存期间先亮在新值上，回来就撤掉、以 store 为准（失败了自然回到原来的值）
  const [override, setOverride] = useState<number | null>(null)
  const [customOpen, setCustomOpen] = useState(false)
  // null = 没在改，框里显示现在生效的值
  const [text, setText] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const shown = override ?? value
  const view = numRowView(spec, shown, customOpen)
  const hint = numHint(spec, text ?? '')

  async function save(n: number) {
    setOverride(n)
    try {
      await onSave(n)
    } finally {
      setOverride(null)
    }
  }
  // 失焦 / 回车：范围内、和现在不一样才存。框子不收起来——失焦往往是手指正点在下面别的东西上，这时候挪版面会点错
  function commit() {
    if (text === null) return
    const n = numToSave(spec, text, shown)
    setText(null)
    if (n !== null) void save(n)
  }

  const cell = (on: boolean) => `py-1.5 rounded-full text-[13px] whitespace-nowrap ${on ? 'bg-ink text-white' : 'text-muted'}`
  return (
    <div className="py-3.5 border-b border-line last:border-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[15px]">{spec.name}</span>
        <span className="text-[11px] text-muted whitespace-nowrap">默认 {valueLabel(spec, spec.def)}</span>
      </div>
      <div className="text-xs text-muted mt-0.5 mb-2.5">{spec.sub}</div>
      <div className="grid grid-flow-col auto-cols-fr bg-bg rounded-full p-0.5" role="group" aria-label={spec.name}>
        {spec.presets.map(([n, label]) => (
          <button
            key={n}
            type="button"
            aria-pressed={view.lit === n}
            className={cell(view.lit === n)}
            onClick={() => {
              setCustomOpen(false)
              setText(null)
              if (n !== shown) void save(n)
            }}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={view.lit === 'custom'}
          className={cell(view.lit === 'custom')}
          onClick={() => {
            // 同步渲染出输入框再聚焦：放到 effect 里聚焦，iPhone 不认它是这次点击弹的，键盘不出来
            flushSync(() => setCustomOpen(true))
            inputRef.current?.focus()
          }}
        >
          {view.customText}
        </button>
      </div>
      {view.showInput ? (
        <div className="flex items-center gap-2.5 mt-2.5">
          <label className="inline-flex items-center gap-1 bg-bg rounded-lg px-2.5 py-1.5 text-sm focus-within:ring-2 focus-within:ring-brand">
            <span className="text-muted">{spec.pre}</span>
            <input
              ref={inputRef}
              inputMode="numeric"
              enterKeyHint="done"
              autoComplete="off"
              aria-label={`${spec.name}（${spec.unit}）`}
              className="w-12 bg-transparent text-center outline-none num"
              value={text ?? String(shown)}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setText(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
            />
            <span className="text-muted">{spec.unit}</span>
          </label>
          <span className={`text-[11px] ${hint.bad ? 'text-expense' : 'text-muted'}`}>{hint.text}</span>
        </div>
      ) : null}
    </div>
  )
}

/** 电价：一个输入框，可以不填（清空 = 只显示度数）。失焦 / 回车才存 */
function PriceRow({ price, onSave }: { price: number | null; onSave: (v: string) => Promise<boolean> }) {
  const [text, setText] = useState<string | null>(null)
  // 保存期间框里先写着新值
  const [override, setOverride] = useState<string | null>(null)
  const hint = text === null ? { bad: false, text: PRICE_HINT } : priceHint(text)

  function commit() {
    if (text === null) return
    const v = priceToSave(text, price)
    setText(null)
    if (v === null) return
    setOverride(v)
    void onSave(v).finally(() => setOverride(null))
  }

  return (
    <div className="py-3.5 border-b border-line last:border-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[15px]">电价</span>
        <span className="text-[11px] text-muted whitespace-nowrap">可以不填</span>
      </div>
      <div className="text-xs text-muted mt-0.5 mb-2.5">填了就按它估电费，清空就只显示度数</div>
      <div className="flex items-center gap-2.5">
        <label className="inline-flex items-center gap-1 bg-bg rounded-lg px-2.5 py-1.5 text-sm focus-within:ring-2 focus-within:ring-brand">
          <input
            inputMode="decimal"
            enterKeyHint="done"
            autoComplete="off"
            aria-label="电价（元/度）"
            placeholder="比如 1.2"
            className="w-16 bg-transparent text-center outline-none num placeholder:text-muted"
            value={text ?? override ?? priceText(price)}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
          />
          <span className="text-muted">元/度</span>
        </label>
        <span className={`text-[11px] ${hint.bad ? 'text-expense' : 'text-muted'}`}>{hint.text}</span>
      </div>
    </div>
  )
}
