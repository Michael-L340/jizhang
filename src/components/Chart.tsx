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
  onClick?: (p: ChartClick) => void
}

export default function Chart({ option, height = 240, onClick }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const inst = useRef<echarts.ECharts | null>(null)
  const clickRef = useRef(onClick)
  clickRef.current = onClick

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const chart = echarts.init(el)
    inst.current = chart
    chart.on('click', (p) => clickRef.current?.(p as unknown as ChartClick))
    const ro = new ResizeObserver(() => chart.resize())
    ro.observe(el)
    return () => {
      ro.disconnect()
      chart.dispose()
      inst.current = null
    }
  }, [])

  useEffect(() => {
    inst.current?.setOption(option, true)
  }, [option])

  return <div ref={ref} style={{ height, width: '100%' }} />
}
