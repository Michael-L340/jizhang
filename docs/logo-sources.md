# 账户品牌标志来源

`src/components/AccountIcon.tsx` 内联的路径数据来自：

| 品牌 | 来源 | 授权 | 用到的部分 |
|---|---|---|---|
| 微信 | simple-icons `icons/wechat.svg` | 图标路径 CC0 | 全部（单路径） |
| 支付宝 | simple-icons `icons/alipay.svg` | 图标路径 CC0 | 全部（单路径） |
| 中国银行 | icongo/bank-logos `logos/boc.svg` | 仓库 MIT | 仅第一条红色主标记，舍弃右侧中文字样 |
| 招商银行 | icongo/bank-logos `logos/cmbchina.svg` | 仓库 MIT | 仅圆形主标记；除中文字样外，2026-09-04 又裁掉了圆圈右侧那六条横杠（x 191~246），它们会把重心带偏 |

商标本身归各品牌所有。本项目为个人单用户记账，标志仅用于标识使用者自己的账户。
本目录保留了原始 SVG 备查。

## 形状与大小的统一（2026-09-04）

四个图标底板统一是**圆形、同一直径**，图形本身都填满各自的 viewBox，
所以同一个 `scale` 下渲染出来一样大。原来中国银行和招商银行用的是圆角方底板，
和微信/支付宝的圆形并排时明显不一致。

`src/components/AccountIcon.test.ts` 守住这几条：viewBox 接近正方形、
路径不超出 viewBox、scale 统一在 0.55~0.62、招行的横杠没被加回来。
以后加别的银行图标时照这个来。
