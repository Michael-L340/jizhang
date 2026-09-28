// 进阶分析页用的 ECharts 容器：就是 Chart.tsx，只是多注册几张图要的模块。
//
// 单独一个文件、由进阶分析页 lazy 加载，统计页不用背桑基、日历、雷达这些它用不上的代码
//（Chart 那个包本来就有 550 KB）。echarts/core 全局只有一份，这里 use 过就对所有 Chart 实例生效。
//
// 按各图实际用到的注册（lib/more/*.ts）：
//   桑基 sankey → SankeyChart；雷达 radar → RadarChart + RadarComponent（RadarChart 自己也会装上它，写出来是为了一眼看全）；
//   日历 calendar → HeatmapChart + CalendarComponent + 连续型 visualMap；
//   什么时候最爱花钱 weekhour → HeatmapChart（直角坐标）+ 连续型 visualMap；
//   本月累计 race → MarkPointComponent（「今天」那个点）。
// 漏注册的后果是那张图一片空白、生产环境连报错都没有——ChartMore.test.ts 用 SSR 把十张图真画一遍守着。
import * as echarts from 'echarts/core'
import { HeatmapChart, RadarChart, SankeyChart } from 'echarts/charts'
import { CalendarComponent, MarkPointComponent, RadarComponent, VisualMapContinuousComponent } from 'echarts/components'
import Chart from './Chart'

echarts.use([SankeyChart, HeatmapChart, RadarChart, CalendarComponent, VisualMapContinuousComponent, RadarComponent, MarkPointComponent])

export default Chart
