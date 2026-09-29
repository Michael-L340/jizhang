// ECharts 容器。按需注册饼/柱/折线，统计页通过 React.lazy 加载本文件，首页不背这个包。
import { useEffect, useRef } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { categoryAxisOf, itemTapStep, type ArmedTap, type TapItem } from '../lib/tap'

echarts.use([PieChart, BarChart, LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

export type ChartOption = echarts.EChartsCoreOption
export interface ChartClick {
  name: string
  dataIndex: number
  seriesIndex?: number
  value?: unknown
}

interface Props {
  option: ChartOption
  height?: number
  /** 点中某个图形（饼图扇区等） */
  onClick?: (p: ChartClick) => void
  /**
   * 点击绘图区任意位置，回调最接近的类目下标；折线图上比要求点中圆点友好得多。
   * 类目轴在哪边取哪边（lib/tap.ts 的 categoryAxisOf）：竖着的图取 x，横着的条形图取 y。
   *
   * **要点两下**：第一下只弹提示框（并高亮那一列），同一个位置再点一下才回调。
   * 原来点一下就跳走，手机上根本来不及看提示框里的数字——柱状图不标数字之后
   * 那些金额只在提示框里，这条就成了硬伤（用户 2026-09-08 定，四张图统一）。
   *
   * 用「同一根连点两次」而不是 dblclick：手机浏览器会把双击拿去做缩放，
   * 而且用户很可能是慢慢点两下，不该有时间限制。点到别的下标就重新开始。
   */
  onAxisClick?: (dataIndex: number) => void
  /**
   * 没有直角坐标的图（日历热力图）用这个：同样**要点两下**，第一下得点中某个图形——
   * onAxisClick 靠 containPixel({ gridIndex: 0 }) 判断点没点在绘图区，没有 grid 的图永远不触发。
   * 第一下弹提示框；第二下落在第一下周围几个像素之内（点中哪一格、空格、提示框都算）就按第一下那格回调，
   * 离得远、点中了别的图形就改看那一个（规则见 lib/tap.ts，和 onAxisClick 一样不限时）。
   */
  onItemTap?: (dataIndex: number, seriesIndex: number) => void
}

export default function Chart({ option, height = 240, onClick, onAxisClick, onItemTap }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const inst = useRef<echarts.ECharts | null>(null)
  const clickRef = useRef(onClick)
  clickRef.current = onClick
  const axisClickRef = useRef(onAxisClick)
  axisClickRef.current = onAxisClick
  const itemTapRef = useRef(onItemTap)
  itemTapRef.current = onItemTap
  // onItemTap 第一下选中的图形和点的位置；null = 还没点过
  const itemArmedRef = useRef<ArmedTap | null>(null)
  // 这一下点中的数据图形。ECharts 的 click 事件排在 zrender 的 click 之后才发（zrEventfulCallAtLast），
  // 所以 zrender 那边先记下事件、等微任务里再看这一下有没有点中图形
  const itemHitRef = useRef<{ ev: unknown; item: TapItem } | null>(null)
  const countRef = useRef(0)
  // 类目轴是 x（0）还是 y（1）：convertFromPixel 返回的 [x, y] 里取哪一个
  const dimRef = useRef<0 | 1>(0)
  // 上一次点中的下标；-1 = 还没点过。option 一换（切档、换区间）就清掉
  const armedRef = useRef(-1)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const chart = echarts.init(el)
    inst.current = chart
    chart.on('click', (p) => {
      clickRef.current?.(p as unknown as ChartClick)
      const q = p as unknown as { seriesIndex?: number; dataIndex?: number; event?: unknown }
      if (itemTapRef.current && typeof q.dataIndex === 'number') {
        itemHitRef.current = { ev: q.event, item: { seriesIndex: q.seriesIndex ?? 0, dataIndex: q.dataIndex } }
      }
    })
    chart.getZr().on('click', (e) => {
      if (itemTapRef.current) {
        const x = e.offsetX
        const y = e.offsetY
        queueMicrotask(() => {
          const tap = itemTapRef.current
          if (!tap) return
          const hit = itemHitRef.current?.ev === e ? itemHitRef.current.item : null
          itemHitRef.current = null
          const step = itemTapStep(itemArmedRef.current, hit, x, y)
          if (!step) return
          if ('go' in step) {
            itemArmedRef.current = null
            tap(step.go.dataIndex, step.go.seriesIndex)
            return
          }
          itemArmedRef.current = step.arm
          chart.dispatchAction({ type: 'showTip', seriesIndex: step.arm.seriesIndex, dataIndex: step.arm.dataIndex })
        })
      }
      const fn = axisClickRef.current
      if (!fn) return
      const pt: [number, number] = [e.offsetX, e.offsetY]
      if (!chart.containPixel({ gridIndex: 0 }, pt)) return
      const v = (chart.convertFromPixel({ seriesIndex: 0 }, pt) as number[])[dimRef.current]
      if (!Number.isFinite(v)) return
      const i = Math.max(0, Math.min(countRef.current - 1, Math.round(v)))
      if (armedRef.current === i) {
        armedRef.current = -1
        fn(i)
        return
      }
      armedRef.current = i
      // 触屏上 zrender 的 click 之后提示框未必留得住，显式喊一次最稳
      chart.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: i })
    })
    const ro = new ResizeObserver(() => chart.resize())
    ro.observe(el)
    return () => {
      ro.disconnect()
      chart.dispose()
      inst.current = null
    }
  }, [])

  useEffect(() => {
    const axis = categoryAxisOf(option)
    countRef.current = axis.count
    dimRef.current = axis.dim
    armedRef.current = -1
    itemArmedRef.current = null
    inst.current?.setOption(option, true)
  }, [option])

  return <div ref={ref} style={{ height, width: '100%' }} />
}
