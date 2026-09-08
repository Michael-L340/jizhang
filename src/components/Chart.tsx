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
  /**
   * 点击绘图区任意位置，回调最接近的 X 轴下标；折线图上比要求点中圆点友好得多。
   *
   * **要点两下**：第一下只弹提示框（并高亮那一列），同一个位置再点一下才回调。
   * 原来点一下就跳走，手机上根本来不及看提示框里的数字——柱状图不标数字之后
   * 那些金额只在提示框里，这条就成了硬伤（用户 2026-09-08 定，四张图统一）。
   *
   * 用「同一根连点两次」而不是 dblclick：手机浏览器会把双击拿去做缩放，
   * 而且用户很可能是慢慢点两下，不该有时间限制。点到别的下标就重新开始。
   */
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
  // 上一次点中的下标；-1 = 还没点过。option 一换（切档、换区间）就清掉
  const armedRef = useRef(-1)

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
    const o = option as { xAxis?: { data?: unknown[] } | { data?: unknown[] }[] }
    const axis = Array.isArray(o.xAxis) ? o.xAxis[0] : o.xAxis
    countRef.current = axis?.data?.length ?? 0
    armedRef.current = -1
    inst.current?.setOption(option, true)
  }, [option])

  return <div ref={ref} style={{ height, width: '100%' }} />
}
