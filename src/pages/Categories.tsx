// 分类管理。从设置页进入，默认全部折叠，点一级分类展开它的二级。
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sheet } from '../components/Sheet'
import { categoryColor } from '../lib/palette'
import { useStore } from '../lib/store'
import type { CatKind, Category } from '../types'

const ICONS = [
  // 吃喝
  '🧾', '🍚', '🍜', '🍽️', '☕', '🥤', '🍎', '🛒',
  // 娱乐
  '🎮', '🎬', '🎧', '🎤', '🎯', '🏀', '✈️', '🎫',
  // 居住出行
  '🏠', '💡', '💧', '🚇', '🚌', '🚗', '📶', '🧺',
  // 购买
  '🛍️', '👕', '👟', '👜', '📱', '💻', '🎁', '📦',
  // 其他
  '💊', '📚', '✂️', '🐾', '⚡', '🔧', '💰', '🏷️',
]

export function Categories() {
  const nav = useNavigate()
  const categories = useStore((st) => st.categories)
  const transactions = useStore((st) => st.transactions)
  const addCategory = useStore((st) => st.addCategory)
  const updateCategory = useStore((st) => st.updateCategory)
  const showToast = useStore((st) => st.showToast)

  const [kind, setKind] = useState<CatKind>('expense')
  const [showArchived, setShowArchived] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [editCat, setEditCat] = useState<Category | null>(null)
  const [moving, setMoving] = useState(false)
  const [iconFor, setIconFor] = useState<Category | null>(null)

  const roots = useMemo(
    () => categories.filter((c) => !c.parent_id && c.kind === kind && (showArchived || !c.is_archived)).sort((a, b) => a.sort - b.sort),
    [categories, kind, showArchived],
  )
  const childrenOf = (id: string) =>
    categories.filter((c) => c.parent_id === id && (showArchived || !c.is_archived)).sort((a, b) => a.sort - b.sort)

  // 每个分类各有多少笔记录。原来是在 render 里对每个一级分类都全量扫一遍流水，
  // 展开/收起分类时会重跑 O(分类数 × 流水数)。改成一次扫描建表。
  const countById = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of transactions) {
      if (!t.category_id) continue
      m.set(t.category_id, (m.get(t.category_id) ?? 0) + 1)
    }
    return m
  }, [transactions])

  /** 这个分类自身及其二级下共有多少笔记录 */
  const countOf = (c: Category) => {
    let n = countById.get(c.id) ?? 0
    for (const x of categories) if (x.parent_id === c.id) n += countById.get(x.id) ?? 0
    return n
  }

  async function rename(c: Category) {
    const name = window.prompt('新名称', c.name)?.trim()
    if (name && name !== c.name) await updateCategory(c.id, { name })
  }

  async function editNote(c: Category) {
    const note = window.prompt(`「${c.name}」的含义说明`, c.note ?? '')
    if (note !== null && note.trim() !== (c.note ?? '')) await updateCategory(c.id, { note: note.trim() || null })
  }

  async function addChild(parentId: string | null) {
    const name = window.prompt(parentId ? '新二级分类名' : '新收入分类名')?.trim()
    if (!name) return
    const created = await addCategory(kind, parentId, name)
    if (created && parentId) setOpenId(parentId)
  }

  return (
    <div className="px-4 pb-8">
      <div className="flex items-center justify-between pt-4 pb-3">
        <button type="button" className="text-brand text-sm -ml-1 px-1 py-1" onClick={() => nav(-1)}>
          ‹ 设置
        </button>
        <span className="text-lg font-bold">分类管理</span>
        <button type="button" className="text-xs text-muted px-1 py-1" onClick={() => setShowArchived(!showArchived)}>
          {showArchived ? '隐藏归档' : '显示归档'}
        </button>
      </div>

      <div className="flex justify-center mb-3">
        <div className="inline-flex rounded-full bg-card border border-line p-0.5">
          {(['expense', 'income'] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={`px-5 py-1.5 rounded-full text-sm ${kind === k ? 'bg-ink text-white' : 'text-muted'}`}
              onClick={() => {
                setKind(k)
                setOpenId(null)
              }}
            >
              {k === 'expense' ? '支出用途' : '收入分类'}
            </button>
          ))}
        </div>
      </div>

      <div className="card overflow-hidden mb-3">
        {roots.map((p, i) => {
          const kids = childrenOf(p.id)
          const expanded = openId === p.id
          const hasChildren = kind === 'expense'
          return (
            <div key={p.id} className={i ? 'border-t border-line' : ''}>
              <div className="flex items-center gap-3 px-4 py-3">
                <button
                  type="button"
                  className="w-9 h-9 rounded-xl flex items-center justify-center text-lg shrink-0"
                  style={{ background: `${categoryColor(p.name, i)}1a` }}
                  onClick={() => setIconFor(p)}
                  title="换图标"
                >
                  {p.icon || '🏷️'}
                </button>
                <button
                  type="button"
                  className="flex-1 min-w-0 text-left"
                  onClick={() => (hasChildren ? setOpenId(expanded ? null : p.id) : setEditCat(p))}
                >
                  <span className={`block font-medium truncate ${p.is_archived ? 'line-through opacity-50' : ''}`}>{p.name}</span>
                  <span className="block text-xs text-muted truncate">
                    {hasChildren ? `${kids.length} 个二级 · ` : ''}
                    {countOf(p)} 笔
                    {p.note ? ` · ${p.note}` : ''}
                  </span>
                </button>
                {hasChildren ? (
                  <button type="button" className="p-1 text-muted shrink-0" onClick={() => setOpenId(expanded ? null : p.id)} aria-label="展开">
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}
                    >
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </button>
                ) : (
                  <span className="text-muted shrink-0">›</span>
                )}
              </div>

              {hasChildren ? (
                <div className={`expand ${expanded ? 'open' : ''}`}>
                  <div>
                    <div className="px-4 pb-3">
                      <div className="flex flex-wrap gap-1.5">
                        {kids.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            className={`chip ${c.is_archived ? 'opacity-40 line-through' : ''}`}
                            style={{ padding: '5px 12px' }}
                            onClick={() => setEditCat(c)}
                          >
                            {c.name}
                          </button>
                        ))}
                        <button type="button" className="chip border-dashed text-muted" style={{ padding: '5px 12px' }} onClick={() => addChild(p.id)}>
                          ＋ 新增
                        </button>
                      </div>
                      <div className="flex gap-4 mt-3 text-xs text-brand">
                        <button type="button" onClick={() => rename(p)}>
                          改名
                        </button>
                        <button type="button" onClick={() => editNote(p)}>
                          {p.note ? '改说明' : '加说明'}
                        </button>
                        <button type="button" className="text-muted" onClick={() => setEditCat(p)}>
                          更多
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          )
        })}

        {kind === 'income' ? (
          <button type="button" className="w-full px-4 py-3 border-t border-line text-left text-sm text-brand" onClick={() => addChild(null)}>
            ＋ 新增收入分类
          </button>
        ) : null}
      </div>

      <div className="text-xs text-muted leading-relaxed px-1">
        点图标可以换 emoji，点分类名展开二级。分类只能归档不能删除，历史记录永远不会变成孤儿。改名和移动都会追溯影响已有记录的统计归属。
      </div>

      {/* 单个分类的操作 */}
      <Sheet
        open={Boolean(editCat)}
        onClose={() => {
          setEditCat(null)
          setMoving(false)
        }}
        title={editCat ? editCat.name : ''}
      >
        {editCat && moving ? (
          <>
            <div className="text-sm text-muted mb-2">移动到哪个大类？该分类下所有历史记录都会跟着变。</div>
            <div className="flex flex-col">
              {categories
                .filter((r) => !r.parent_id && r.kind === editCat.kind && r.id !== editCat.parent_id && !r.is_archived)
                .sort((a, b) => a.sort - b.sort)
                .map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="flex items-center gap-2 py-3 border-b border-line text-left"
                    onClick={async () => {
                      const n = countById.get(editCat.id) ?? 0
                      if (!window.confirm(`把「${editCat.name}」移到「${r.name}」下？受影响的历史记录 ${n} 笔。`)) return
                      const ok = await updateCategory(editCat.id, { parent_id: r.id })
                      if (ok) {
                        showToast(`已移到「${r.name}」`)
                        setOpenId(r.id)
                        setEditCat(null)
                        setMoving(false)
                      }
                    }}
                  >
                    <span>{r.icon}</span>
                    <span className="flex-1">{r.name}</span>
                    <span className="text-muted">›</span>
                  </button>
                ))}
            </div>
            <button type="button" className="w-full mt-4 py-2.5 rounded-xl bg-bg text-sm" onClick={() => setMoving(false)}>
              返回
            </button>
          </>
        ) : editCat ? (
          <div className="flex flex-col">
            <Action
              label="改名"
              onClick={async () => {
                await rename(editCat)
                setEditCat(null)
              }}
            />
            <Action
              label={editCat.note ? '改含义说明' : '加含义说明'}
              onClick={async () => {
                await editNote(editCat)
                setEditCat(null)
              }}
            />
            {editCat.parent_id ? <Action label="移动到其他大类" onClick={() => setMoving(true)} /> : null}
            <Action
              label={editCat.is_archived ? '取消归档' : '归档（不再出现在记账页）'}
              danger={!editCat.is_archived}
              onClick={async () => {
                await updateCategory(editCat.id, { is_archived: !editCat.is_archived })
                setEditCat(null)
              }}
            />
            <div className="text-xs text-muted mt-3">
              {/* countById 是按分类 ID 精确计数的，对一级分类来说只数到「直接记在这一级、
                  没选二级」的那些，而收起来的列表里显示的是含二级的合计——同一个分类
                  在同一个页面出现两个数字。这里改成和列表一致，并把差额说清楚。 */}
              这个分类下现有 {countOf(editCat)} 笔记录
              {!editCat.parent_id && countOf(editCat) !== (countById.get(editCat.id) ?? 0)
                ? `，其中 ${countById.get(editCat.id) ?? 0} 笔直接记在这一级、没选二级`
                : ''}
              。
            </div>
          </div>
        ) : null}
      </Sheet>

      {/* 换图标 */}
      <Sheet open={Boolean(iconFor)} onClose={() => setIconFor(null)} title={iconFor ? `${iconFor.name} 的图标` : ''}>
        <div className="grid grid-cols-8 gap-1.5">
          {ICONS.map((e) => (
            <button
              key={e}
              type="button"
              className={`h-11 rounded-xl text-xl ${iconFor?.icon === e ? 'bg-brand-soft ring-2 ring-brand' : 'bg-bg'}`}
              onClick={async () => {
                if (iconFor) await updateCategory(iconFor.id, { icon: e })
                setIconFor(null)
              }}
            >
              {e}
            </button>
          ))}
        </div>
      </Sheet>
    </div>
  )
}

function Action({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" className={`py-3.5 border-b border-line last:border-0 text-left text-[15px] ${danger ? 'text-expense' : ''}`} onClick={onClick}>
      {label}
    </button>
  )
}
