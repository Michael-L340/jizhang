// ECharts 容器。按需注册饼/柱/折线，统计页通过 React.lazy 加载本文件，首页不背这个包。
import { useEffect, useRef } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

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
  /** 点击绘图区任意位置，回调最接近的 X 轴下标；折线图上比要求点中圆点友好得多 */
  onAxisClick?: (dataIndex: number) => void
}

export default function Chart({ option, height = 240, onClick, onAxisClick }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const inst = useRef<echarts.ECharts | null>(null)
  const clickRef = useRef(onClick)
  clickRef.current = onClick
  const axisClickRef = useRef(onAxisClick)
  axisClickRef.current = onAxisClick
  const countRef = useRef(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const chart = echarts.init(el)
    inst.current = chart
    chart.on('click', (p) => clickRef.current?.(p as unknown as ChartClick))
    chart.getZr().on('click', (e) => {
      const fn = axisClickRef.current
      if (!fn) return
      const pt: [number, number] = [e.offsetX, e.offsetY]
      if (!chart.containPixel({ gridIndex: 0 }, pt)) return
      const [x] = chart.convertFromPixel({ seriesIndex: 0 }, pt) as number[]
      if (!Number.isFinite(x)) return
      const i = Math.max(0, Math.min(countRef.current - 1, Math.round(x)))
      fn(i)
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
    const o = option as { xAxis?: { data?: unknown[] } | { data?: unknown[] }[] }
    const axis = Array.isArray(o.xAxis) ? o.xAxis[0] : o.xAxis
    countRef.current = axis?.data?.length ?? 0
    inst.current?.setOption(option, true)
  }, [option])

  return <div ref={ref} style={{ height, width: '100%' }} />
}
