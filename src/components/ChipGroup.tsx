import type { ReactNode } from 'react'

export interface ChipOption {
  id: string
  label: string
  icon?: string | null
  /** 自定义前缀元素，优先于 icon */
  node?: ReactNode
  /** 追加的样式，比如「半选」：范围落在它里面，但当前值是它的某个下级 */
  className?: string
}

interface Props {
  options: ChipOption[]
  value: string | null
  onChange: (id: string) => void
  /** 追加在末尾的元素，比如「＋新增」 */
  extra?: ReactNode
  className?: string
}

export function ChipGroup({ options, value, onChange, extra, className = '' }: Props) {
  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      {options.map((o) => (
        <button key={o.id} type="button" className={`chip inline-flex items-center ${o.id === value ? 'on' : ''} ${o.className ?? ''}`} onClick={() => onChange(o.id)}>
          {o.node ? <span className="mr-1.5 inline-flex align-middle">{o.node}</span> : o.icon ? <span className="mr-1">{o.icon}</span> : null}
          {o.label}
        </button>
      ))}
      {extra}
    </div>
  )
}
