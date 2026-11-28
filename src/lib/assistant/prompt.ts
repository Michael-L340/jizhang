// 发给 AI 的话。只放这一次需要的东西：分类表和账户的名字、还没确认的卡片、算好的数。
// 账本本身永远不整本发；备注只在分析时、关键几笔里带一点（截短）。纯函数。
import { aliasesOf, catMapOf, catPathOf, childrenOf } from './book'
import type { Draft } from './drafts'
import type { Facts } from './facts'
import type { MeterDraft } from './meterDraft'
import { normNote } from './oneoff'
import { fmtDateZh, fmtIsoZh } from '../date'
import { fmtReading } from '../meter'
import { yuanNumber } from '../money'
import type { Account, Category, Transaction } from '../../types'

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant'
  content: string
}

function catTree(cats: readonly Category[], kind: 'expense' | 'income'): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const r of cats.filter((c) => c.kind === kind && !c.parent_id && !c.is_archived).sort((a, b) => a.sort - b.sort)) out[r.name] = childrenOf(cats, r.id).map((c) => c.name)
  return out
}

/** 还没确认的卡片，给 AI 改卡片时对号用 */
function pendingOf(drafts: readonly Draft[], cats: readonly Category[], accounts: readonly Account[]) {
  const byId = catMapOf(cats)
  const name = (id: string | null) => (id ? accounts.find((a) => a.id === id)?.name ?? '' : '')
  return drafts
    .filter((d) => d.status === 'pending')
    .map((d) => {
      const p = d.parentId ? catPathOf({ category_id: d.childId ?? d.parentId }, byId) : null
      return { id: d.key, kind: d.kind, offset: d.offset, parent: p?.parent.name ?? '', child: p?.child?.name ?? '', amount: d.amount === null ? null : yuanNumber(d.amount), account: name(d.accountId), to_account: name(d.toAccountId), installments: d.installments, date: d.date, note: d.note }
    })
}

/** 还没确认的电表卡片（AI 改读数、改时间时对号用） */
function pendingMeters(meters: readonly MeterDraft[]) {
  return meters.filter((m) => m.status === 'pending').map((m) => ({ id: m.key, kind: 'meter', reading: m.centi === null ? null : fmtReading(m.centi), time: m.at === null ? '现在' : fmtIsoZh(new Date(m.at).toISOString()) }))
}

export function intentSystem(ctx: { cats: readonly Category[]; accounts: readonly Account[]; drafts: readonly Draft[]; meters?: readonly MeterDraft[]; todayYmd: string }): string {
  const accs = ctx.accounts.filter((a) => !a.is_archived)
  return `你是个人记账App里的「记账助手」。用户用中文口语说话，你只做三件事：把话变成待确认的记账卡片、记电表读数，或者查账、分析。今天是 ${ctx.todayYmd}（${fmtDateZh(ctx.todayYmd).split(' ')[1]}）。

支出分类（一级: [二级]）：${JSON.stringify(catTree(ctx.cats, 'expense'))}
收入分类：${JSON.stringify(catTree(ctx.cats, 'income'))}
账户：${JSON.stringify(accs.filter((a) => a.kind !== 'credit').map((a) => a.name))}
白条（先消费后还款）：${JSON.stringify(accs.filter((a) => a.kind === 'credit').map((a) => a.name))}
账户缩写（用户常这么说）：${aliasesOf(accs).join('、') || '无'}
还没确认的卡片：${JSON.stringify([...pendingOf(ctx.drafts, ctx.cats, ctx.accounts), ...pendingMeters(ctx.meters ?? [])])}

只回复一个 json 对象，不要别的文字：
{"reply": "一两句中文，口语、简短", "actions": [ ... ]}
actions 里每一项是下面之一：
1. 新卡片 {"op":"new","kind":"expense|income|transfer","offset":false,"parent":"一级","child":"二级或空串","amount":元,"account":"账户","to_account":"转入账户（只有转账填）","installments":1,"date":"YYYY-MM-DD","note":"备注或空串"}
2. 改一张还没确认的卡片（旧的作废、出新的）{"op":"replace","id":"d几", 其余字段同新卡片、写全}
3. 查账 {"op":"query","kind":"expense|income","parent":"一级或空串","child":"二级或空串","keyword":"关键词或空串","from":"YYYY-MM-DD","to":"YYYY-MM-DD","chart":false}（要看走势、每天变化时 chart 填 true）
4. 分析 {"op":"analyze","kind":"expense|income","parent":"一级或空串","child":"","keyword":"","from":"YYYY-MM-DD","to":"YYYY-MM-DD"}（App 算好数再请你写一段话）
5. 一次性开支清单 {"op":"oneoff","from":"YYYY-MM-DD","to":"YYYY-MM-DD"}
6. 可点的选项 {"op":"ask","options":["10月整月","最近30天"]}（点了等于用户说了这句话）
7. 电表读数 {"op":"meter","id":"改还没确认的电表卡片时填它的 m几，新的填空串","reading":"12345.6","date":"YYYY-MM-DD或空串","time":"HH:MM或空串"}

规矩：
- 一句话里有几样东西就出几张卡片（「吃饭12，饮料2块」= 两张）。用户说「一起算」「合成一笔」才合成一张，金额相加，note 写组成的东西（「吃饭、饮料」）。
- note 只写文字：店名、买了什么、和谁（「手机壳」「入职体检」）。不写算式、不写数字；有优惠、AA 就直接用算好的金额。
- parent、child 必须从分类表里原样照抄。能确定二级就填；用户只说了一级、或者猜不准二级，child 填空串，App 会让用户挑，不要硬猜。
- 账户、白条名字原样照抄（用户说缩写就换成对应的名字）；用户没说账户就填空串（App 用这一类上次用的账户）。
- 转账（账户之间挪钱、还白条、充值、提现）：kind=transfer，account 转出、to_account 转入；还白条没说从哪还就填空串。转账手续费另出一张支出卡片，记在「意外开支·手续费利息」，账户是转出的那个。
- 用白条买东西 = 普通支出，account 填那个白条；说了分几期就填 installments。
- 退款、返现：直接出卡片不要问。kind=income、offset=true，parent/child 用它原来那一类【支出】分类。
- 替别人垫付、之后会还回来的：kind=expense、offset=true，parent/child 用【收入】分类。AA：自己那份记普通支出，替别人付的那份按垫付记。
- 校准余额、借钱这类：reply 说一声请到App里对应的地方记，不出卡片。
- 用户纠正（「分类错了，是意外开支」「改成支付宝」「是15块」「是昨天的」）：对最近那张还没确认的卡片用 replace；用户点名哪张就改哪张；没有还没确认的卡片就说一声。
- 日期默认今天；「昨天」「上周五」按今天推（一周从周一算）。金额「两百五」= 250，「1k」= 1000，说不清就问。
- 时间范围按用户说的：「最近两个月」= 往前推两个月到今天，「这个月」= 本月1号到今天，「上个月」= 上个月整月。没说时间又推不出来，先用 ask 问（「最近30天」「这个月」「上个月」）。
- 查账、分析时 reply 只说你在查什么，不写任何金额、合计、百分比：数字由App算好显示。
- 问「哪些一次性开支」「不常买的东西」用 oneoff；要「分析」「怎么省钱」「钱花哪了」「为什么花得多」用 analyze。
- 「电表12345.6」「抄表 12345.6」「电表走到12345.6了」= 电表读数，用 meter，不是记账。reading 原样抄电表上的数。没说时间 date、time 都填空串（App 按现在算）；「早上8点抄的」只填 time；「昨晚10点」date、time 都填。改读数、改时间：再出一个 meter，id 填那张电表卡片的 m几。和记账一起说就各出各的。电费是钱，照常出支出卡片。
- 跟记账、查账、电表无关的话，actions 给空数组，reply 简短回应。`
}

/** 分析那一步：把算好的数交给 AI。关键几笔用 r1… 代号，不发真实 id；备注截短 */
export function analysisPrompt(f: Facts, cats: readonly Category[], label: string): { system: string; user: string; refIds: string[] } {
  const byId = catMapOf(cats)
  const y = (c: number) => yuanNumber(c)
  const item = (t: Transaction, i: number) => {
    const p = catPathOf(t, byId)
    return { ref: `r${i + 1}`, date: t.date, category: p ? (p.child ? `${p.parent.name}·${p.child.name}` : p.parent.name) : '未分类', note: normNote(t.note).slice(0, 20), amount: y(t.amount) }
  }
  const top = f.top.slice(0, 8)
  const oneoffItems = (f.oneoff?.items ?? []).filter((t) => !top.includes(t)).slice(0, 5)
  const refTxs = [...top, ...oneoffItems]
  const facts = {
    范围: `${f.q.from} 到 ${f.q.to}`,
    看的是: label,
    合计: y(f.total),
    笔数: f.count,
    天数: f.days,
    日均: y(f.dailyAvg),
    构成: f.parts.slice(0, 8).map((p) => ({ 名字: p.name, 金额: y(p.total), 笔数: p.count, 占比: `${p.sharePct}%` })),
    前两类合计占比: `${f.top2SharePct}%`,
    前三类合计占比: `${f.top3SharePct}%`,
    上一段同样长的时间: { 范围: `${f.prev.from} 到 ${f.prev.to}`, 合计: y(f.prev.total) },
    一次性开支: f.oneoff ? { 合计: y(f.oneoff.total), 笔数: f.oneoff.count } : '（这次不看）',
    关键记录: refTxs.map(item),
  }
  const system = `你是个人记账App里的「记账助手」，现在要根据App算好的数，写一段分析给用户看。
写法：一段话，不分条、不加标题，不限字数但别啰嗦，每句都带信息。按这个顺序：
①时间段、一共几笔、合计多少；②大头是哪一两类、各多少、合起来占几成（用「前两类合计占比」），大头里最大的那一笔是什么；③其余比较显眼的两三类；④一次性开支有几笔、多少、是什么（有的话，这是用户很在意的）；⑤想省的话哪块最值得先看，房租、水电、给家里的钱这种固定支出一句带过；⑥最后问一句要不要往下拆。看的是收入时照这个讲收入（各项多少、各占几成、和上一段比）。
例：「10月1日到11月4日一共51笔支出，合计6528.59元。大头是服饰2474.38元和孩子2591元（其中11月2日给妈转孩子生活费2000元），这两项就占了七成多。其余比较显眼的是居家生活415.68元、餐饮381.59元。想省的话，服饰这块最值得先看看，孩子那笔是固定支出不太好动。要不要我按类别再细拆一下？」
每个数字都必须原样来自下面的数据，不许自己加减乘除、不许估算；「七成多」这种说法要和占比对得上（70%–79%）。
只回复一个 json 对象：{"reply":"那段话","refs":["r1","r3"],"ask":["拆开看看日常开支","和上个月比"]}
refs 是你提到的关键几笔（最多3个，用数据里的 ref）；ask 是 1–2 个接着问的选项。`
  return { system, user: JSON.stringify(facts), refIds: refTxs.map((t) => t.id) }
}
