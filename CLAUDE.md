# 记账 PWA — 项目规则

单用户个人记账。Vite + React 19 + TypeScript + Tailwind v4 + zustand + supabase-js + ECharts + vite-plugin-pwa。

本文件只放**不许违反的规矩**。要「为什么」和「怎么验出来的」，按需读一份，别整本拖进来：
`README.md`（是什么 / 怎么跑 / 目录结构）、`docs/数据与迁移.md`、`docs/备份与恢复.md`、
`docs/测试.md`、`docs/里外页面.md`、`docs/决策记录.md`（踩过的坑 / 明确不做的 / 用户偏好 / 开发历史）。

## 分层与依赖方向（改代码前先看这条）
- `src/pages/*` → 只能 import `components/`、`lib/`、`types.ts`。页面之间禁止互相 import。
- `src/components/*` → 只能 import `lib/`、`types.ts`。
- `src/lib/store.ts` 是唯一调用 `lib/api.ts` 的地方；`lib/api.ts` 是唯一 import `lib/supabase.ts` 的地方。
- `lib/compute.ts`、`lib/money.ts`、`lib/date.ts`、`lib/csv.ts`、`lib/chart.ts` 是纯函数，不依赖 store / api。
- 加一个新页面 = 新建 `pages/X.tsx` + 在 `App.tsx` 路由表加一行 + 需要的话在 `components/TabBar.tsx` 加一项。别的文件不动。

## 数据约定
- 金额在程序里全程是整数「分」，只有 `lib/money.ts` 做 元↔分 转换。
- 日期全程是北京时间 `YYYY-MM-DD` 字符串，用 `lib/date.ts` 的 `today()`，不要 `new Date().toISOString().slice(0,10)`。
- `transfer` 和 `adjust` 永远不进收入/支出统计（`compute.ts` 里的 `isFlow`）。
- 账户余额 = Σ收入 − Σ支出 + Σ转入 − Σ转出 + Σ校准，没有初始余额字段。
- 分类只归档（`is_archived`）不删除。
- 写入失败分两类，别只写「失败就回滚」：`api.isPermanentError` 为真（`23xxx`/`42xxx` 错误码）才回滚，其余（没网、超时、登录过期）进 `lib/outbox.ts` 的待上传队列，联网后补传。默认可重传——误判成永久失败是当场丢账，误判成网络问题只是队列里卡一条、用户看得见。
- 白条账户 `kind = 'credit'`（京东白条、花呗、拼多多、美团月付），余额为负 = 欠款。**下单记支出**（账户选白条，支出算在下单那个月）、**平台扣款记转账**（银行 → 白条）、利息单独记支出。还款不预排流水。
- **到期日 = 下单日之后最近的那个还款日**（`accounts.repay_day`，京东 17、花呗和美团 1）。还款日当天下单算下一个月；填 31 时短月落到月末。`installments` 的第 k 期 = 第 1 期往后推 k−1 个月。`repay_day` 为空 = 没有固定还款日（拼多多先用后付逐笔扣），这种账户不排期，只要没被勾选结清就一直算欠着。
- **勾选结清**（`transactions.settles`）挂在**还款那一侧**，存被结清的支出 id。一次还款只写一条记录，删掉它结清关系跟着消失。只对「一次还清」的订单用，分期按账单整体还、不参与勾选。`dueInMonth` 减还款时只减「没指明结清哪几单」的那部分，否则同一笔钱会扣两次。
- 白条面板按**「一行 = 这个月该还的一笔」**画（`monthBill`）：分期只出本期那一份，各行之和正好等于「本月该还」。

## 数据库迁移
- 只新增 `supabase/migrations/000N_*.sql`，**不改旧文件**。
- **迁移只加可空列，永远不删列、不改名、不改类型**。改了类型不报错但静默算错（元→分那次实测差 100 倍）。真要废弃一列就让它留在库里不管，在 `types.ts` 里加注释（`Account.kind` 就是这么处理的）。
- **加一列要同时改四处**，其中一处在私有仓库 `Michael-L340/jizhang-backup`：`api.ts` 的列常量与映射、`csv.ts` + `validate.ts`、`restore.dbtest.ts`、`backup.mjs` 的 `SELECT_*` **和** `toAccount`/`toTransaction`。外加 `store.ts` 的 `readCache` 要把新列补成 `null`。漏改的后果全是静默的。**云端迁移和推 `backup.mjs` 要挨着做。**
- `api.ts` 必须用显式列名常量（`ACC_COLS` / `CAT_COLS` / `TX_COLS`），**谁改成 `select *`，「加可空列可以安全回退」这条保证就没了**。
- 详情（回退的五种后果、四处清单、实测记录）见 `docs/数据与迁移.md`。

## 里外页面
- 外页面显示的资产账户余额 = 真实余额 + `accounts.facade_offset`（整数「分」，null = 不修饰），里页面显示真实余额。白条不参与。
- **只有余额被修饰**，分类统计、月收支、储蓄率、白条、导入导出全是真的。唯一的例外：外页面下**被修饰过的账户**（`facade_offset !== null`）的 `adjust` 记录整条隐身——不进最近流水、不进流水页、不进账户页的「本月 ±」和「上次校准」、不进余额曲线（`facade.visibleTxs`）。
- 曲线要「摘校准」和「平移量加上校准合计」**两件一起做**（`shiftSeries` 的第四个参数），只做一件都是错的。
- **`mode` 绝不能写进缓存**——冷启动必须永远是外页面（`store.test.ts` 有守）。
- 切换 = 长按底部 ＋ 1.5 秒（`facade.HOLD_MS`）；切走 App 满 60 秒（`INNER_TTL_MS`）自动退回外页面。
- 记号是**屏幕最顶上一条 2px 深焦糖细线**（`App.tsx` 的 Root），每一页都在。别改成只在首页做记号，切换不弹提示。
- 外页面点非白条账户的「校准」改的是偏移量、不写流水；真校准要先进里页面。**别给外页面加任何提示文案。**
- 完整设计与理由见 `docs/里外页面.md`。

## 统计页
- `balanceSeries` 的**合计只加传进来的那几个账户**，别改回 `totalOf(running)`：`applyTx` 会给清单之外的账户也建键，统计页只传资产账户进来，白条的欠款就会悄悄混进「只算资产」的合计。
- 图表上**不属于分类**的颜色（趋势线 / 余额线 / 坐标轴）走 `palette.CHART`，页面里不许再出现写死的十六进制——`palette.test.ts` 对 `Home.tsx` 和 `Stats.tsx` 都有守卫，并从 `index.css` 的 `@theme` 现读来对账。余额线单独有个 `--color-balance`（蓝），别改成支出红或收入绿：余额不是一笔钱的方向。
- 余额那张卡的标题是**「总资产」**不是「账户余额」，底下小字写死口径「四个资产账户之和，不扣白条欠款」。用户明确说过「余额」会被读成净资产。
- x 轴标签**年份永远带着**（`25.10`），装不下就逐级降密度（`chart.axisLabels`）。别改回 `interval: keys.length <= 14 ? 0 : …`，那个只数个数不量宽度。图例用 `chart.shortLabels` 缩写，撞名整组回退原名。
- 图上**点一下看明细、再点一下才跳流水**（`Chart.tsx` 的 `armedRef`），四张图统一。不要用 dblclick：手机浏览器会把双击拿去缩放。
- 「趋势」三档：合计 / 分类 / 堆叠。堆叠柱上不标任何数字，金额和占比在提示框里。曾经叠过一条「日均消费」折线走右轴（2026-09-08 做了又撤，无论怎么调量程都在柱子上横切），要找回来看 `git log` 的 b7b540e。

## 改动流程
1. `npm run dev` 本地看效果（手机同 WiFi 访问终端打印的地址）。
2. `npm run check`（类型检查）和 `npm test`（单测）必须全绿。**测试红了就是改坏了**，不要用「发到手机上看看」代替它。
3. 一个功能一个 commit。
4. `npm run deploy` 发布。按顺序：check → test → **版本号第三位自动 +1 并打 tag** → 构建 → 发到 gh-pages → 推 main 和 tag。所以**先 commit 再 deploy**（工作区不干净会被拒），**不要手改 `package.json` 的 version**。大功能用 `npm run deploy:minor`。改坏了 `git revert` 回退再 deploy，版本号照常 +1。
5. **不经用户点头不跑 deploy。**

## 测试纪律
- 动了 `lib/store.ts` / `lib/compute.ts` / `lib/pending.ts` / `lib/outbox.ts` 就要补测试。这几个文件的 bug 大多是时序或边界问题，肉眼和手动操作都很难稳定复现。
- **新写的测试必须先证明它会红**：把对应的修复改回出 bug 前的写法，确认用例真的变红，再改回来。不会红的测试是负资产。
- 单测跑在 node 环境，没有 DOM。纯逻辑放 `lib/`，页面里只留渲染，这样才测得到。
- 动了 `supabase/migrations/` 或 `api.ts` 的导入导出，跑一次 `npm run test:db`（约 60 秒）。它在内存里启动真的 Postgres 走完整备份恢复流程，`npm test` 和 `npm run deploy` 都不含它。
- **数据库的实际行为不要凭记忆断言**，写进注释或文档前先用 `test:db` 跑一遍。
- `store.test.ts` 的隔离手段和每个测试文件守什么，见 `docs/测试.md`。

## Git 提交
bug 修复类固定四段，`git log` 扫一眼就知道该回退到哪一条：
```
<一句话结论>

现象：用户会看到什么
原因：根因是什么
改法：做了什么
影响：动了哪些文件 / 页面
```
功能类保持要点列表即可。

## 密钥
`.env.local` 存 Supabase URL 和 anon key（模板见 `env.example`），不入库。anon key 是公开级别的；service_role key 和 `sbp_` 管理令牌永远不写进任何文件，走剪贴板、用完让用户删。
