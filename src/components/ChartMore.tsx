// 进阶分析页用的 ECharts 容器：就是 Chart.tsx，只是多注册几张图要的模块。
//
// 单独一个文件、由进阶分析页 lazy 加载，统计页不用背桑基、日历、雷达这些它用不上的代码
//（Chart 那个包本来就有 550 KB）。echarts/core 全局只有一份，这里 use 过就对所有 Chart 实例生效。
// 按模块逐个 import，不 import 'echarts' 整包。
//
// 按各图实际用到的注册（lib/more/*.ts）：
//   桑基 sankey → SankeyChart；雷达 radar → RadarChart + RadarComponent（RadarChart 自己也会装上它，写出来是为了一眼看全）；
//   日历 calendar → HeatmapChart + CalendarComponent + 连续型 visualMap；
//   什么时候最爱花钱 weekhour → HeatmapChart（直角坐标）+ 连续型 visualMap；
//   本月累计 race → MarkPointComponent（「今天」那个点）；
//   支出版图 treemap → TreemapChart；
//   大额消费 bigticket → ScatterChart + SingleAxisComponent（一条横轴上的散点，没有 grid）。
// 其余第二批的图（环比涨跌榜、历史位置、固定开销、吃饭占多少、备注里常写的、资产结构、白条未来负担）
// 只用柱 / 折线 / grid / 图例 / 提示框，Chart.tsx 已经注册过。
// 漏注册的后果是那张图一片空白、生产环境连报错都没有——ChartMore.test.ts 用 SSR 把每张图真画一遍守着。
import * as echarts from 'echarts/core'
import { HeatmapChart, RadarChart, SankeyChart, ScatterChart, TreemapChart } from 'echarts/charts'
import { CalendarComponent, MarkPointComponent, RadarComponent, SingleAxisComponent, VisualMapContinuousComponent } from 'echarts/components'
import Chart from './Chart'

echarts.use([SankeyChart, HeatmapChart, RadarChart, TreemapChart, ScatterChart, CalendarComponent, VisualMapContinuousComponent, RadarComponent, MarkPointComponent, SingleAxisComponent])

// 提示框和统计页一样：点一下弹、按住滑动跟着看、点别处就收，二十张图没有例外（钱的流向只关掉了「高亮相连变暗」，见 sankey.ts）。
// v1.3.19 试过整页都「点一下才弹」，用户嫌不好用：不能滑着看、不好消失（2026-09-29）。
export default Chart
