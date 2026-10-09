// 进阶统计 ·「备注里常写的」：支出备注里出现最多的词（「星巴克」「全家」「KFC」），横着的条形图，条长 = 几次（几笔支出）。
// 原来叫「最常去的地方」，可切出来的词不全是地方（「拿铁」「打车」「话费」），审阅 #15 改成照实说。
//
// 只吃 MoreInput.txs（当前模式那本账），不看 hidden、不碰 store。
// 只看 type === 'expense'：收入的备注（「9 月工资」）不是去过的地方；转账、校准没有「去哪儿」。
//
// 不做中文分词（没词典、也不值得为一张卡带一个几 MB 的包）：备注按「一串汉字 / 一串字母 / 一串数字」切开，
// 「星巴克 拿铁」切成「星巴克」「拿铁」，「在星巴克买咖啡」整串是一个词。用户的备注多半是短词，够用。
// 切之前先 NFKC 归一化（审阅 #25）：全角「ＫＦＣ」和半角「KFC」、全角数字「１５」和「15」算同一个写法。
// 汉字用 \p{Script=Han}，不用 [一-龥]：那个范围只到基本区，「𠮷野家」的「𠮷」（扩展 B 区）会被切掉。
import { fmtYuan } from '../money'
import { CHART } from '../palette'
import type { Transaction } from '../../types'
import { esc } from './html'
import { rangeSpan } from './span'
import type { MoreChart, MoreInput } from './types'

export const PLACES_TITLE = '备注里常写的'
/** 取前几个词 */
export const TOP_WORDS = 10
/** 一个词至少几个字（「饭」「面」这种单字太泛） */
export const MIN_LEN = 2
const WORD = /\p{Script=Han}+|[A-Za-z]+|\d+/gu

const RIGHT = 'float:right;margin-left:16px;font-weight:600'

/**
 * 一条备注切出来的词：两个字以上、不是纯数字（「2」「15」是份数和金额，不是地方）。
 * 英文不分大小写（「KFC」「kfc」是同一家），key 是小写。一条备注里同一个词出现两次只算一次。
 */
export function wordsOf(note: string | null): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = []
  const seen = new Set<string>()
  for (const w of note?.normalize('NFKC').match(WORD) ?? []) {
    // 按字数不按 UTF-16 长度：「𠮷」一个字占两个 UTF-16 单元，单独一个不能算成「两个字」
    if ([...w].length < MIN_LEN || /^\d+$/.test(w)) continue
    const key = w.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ key, text: w })
  }
  return out
}

export interface PlaceWord {
  /** 显示的写法：这个词最常见的那种大小写（一样多取先出现的） */
  word: string
  /** 备注里带这个词的支出笔数 */
  count: number
  /** 这些笔的支出合计（分） */
  cents: number
}

/** 范围内（含两端）支出备注里的词，笔数多的在前；一样多按合计大的在前，再一样按词排，顺序是定的 */
export function placeWords(txs: Transaction[], start: string, end: string): PlaceWord[] {
  const acc = new Map<string, { count: number; cents: number; forms: Map<string, number> }>()
  for (const t of txs) {
    // 「抵消」换过来的那笔是负的（compute.netFlow）：退款的备注不是又去了一次
    if (t.type !== 'expense' || t.amount <= 0 || t.date < start || t.date > end) continue
    for (const { key, text } of wordsOf(t.note)) {
      let e = acc.get(key)
      if (!e) {
        e = { count: 0, cents: 0, forms: new Map() }
        acc.set(key, e)
      }
      e.count += 1
      e.cents += t.amount
      e.forms.set(text, (e.forms.get(text) ?? 0) + 1)
    }
  }
  return [...acc.values()]
    .map((e) => {
      // Map 按插入顺序走：一样多时留先出现的那种写法
      let word = ''
      let best = 0
      for (const [f, n] of e.forms) if (n > best) [word, best] = [f, n]
      return { word, count: e.count, cents: e.cents }
    })
    .sort((a, b) => b.count - a.count || b.cents - a.cents || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0))
}

export function places(inp: MoreInput): MoreChart {
  const all = placeWords(inp.txs, inp.start, inp.end)
  const base = {
    key: 'places',
    title: PLACES_TITLE,
    span: rangeSpan(inp.start, inp.end, inp.today),
    note: `这段时间支出的备注按汉字、字母、数字拆成词，两个字以上的词，出现在几笔支出里就算几次（一笔里重复只算一次，英文不分大小写、不分全角半角，纯数字不算），取前 ${TOP_WORDS} 个；提示框里是这几笔的支出合计。`,
  }
  if (!all.length) return { ...base, option: null, empty: '备注写得少，还统计不出来' }

  const rows = all.slice(0, TOP_WORDS)
  return {
    ...base,
    // 一行 26 px，加上下留白
    height: Math.max(120, rows.length * 26 + 16),
    option: {
      tooltip: {
        trigger: 'axis',
        confine: true,
        axisPointer: { type: 'shadow' },
        formatter: (ps: { dataIndex: number }[]) => {
          const r = rows[ps[0]?.dataIndex ?? -1]
          if (!r) return ''
          return `${esc(r.word)}<br/>${r.count} 次<span style="${RIGHT}">合计 ¥${fmtYuan(r.cents)}</span>`
        },
      },
      grid: { left: 4, right: 40, top: 4, bottom: 4, containLabel: true },
      // 数字直接标在条的右端，横轴刻度就不要了
      xAxis: { type: 'value', show: false, minInterval: 1 },
      yAxis: {
        type: 'category',
        // 第一名在最上面
        inverse: true,
        data: rows.map((r) => r.word),
        axisTick: { show: false },
        axisLine: { lineStyle: { color: CHART.axis } },
        // 一整串汉字的长备注（「在星巴克买咖啡」）截断，全文在提示框里
        axisLabel: { fontSize: 11, color: CHART.label, width: 84, overflow: 'truncate', ellipsis: '…' },
      },
      series: [
        {
          name: '次数',
          type: 'bar',
          barMaxWidth: 16,
          itemStyle: { color: CHART.expense, borderRadius: [0, 4, 4, 0] },
          label: { show: true, position: 'right', fontSize: 10, color: CHART.label, formatter: (p: { value: number }) => `${p.value} 次` },
          data: rows.map((r) => r.count),
        },
      ],
    },
  }
}
