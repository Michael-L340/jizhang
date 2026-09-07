# 记账 PWA — 项目规则

单用户个人记账。Vite + React 19 + TypeScript + Tailwind v4 + zustand + supabase-js + ECharts + vite-plugin-pwa。
选型理由、数据模型、踩过的坑见 `README.md`（`架构方案-v1.md` 是早期设计稿，已过期）；数据库脚本在 `supabase/migrations/`。

## 分层与依赖方向（改代码前先看这条）
- `src/pages/*` → 只能 import `components/`、`lib/`、`types.ts`。页面之间禁止互相 import。
- `src/components/*` → 只能 import `lib/`、`types.ts`。
- `src/lib/store.ts` 是唯一调用 `lib/api.ts` 的地方；`lib/api.ts` 是唯一 import `lib/supabase.ts` 的地方。
- `lib/compute.ts`、`lib/money.ts`、`lib/date.ts`、`lib/csv.ts` 是纯函数，不依赖 store / api。
- 加一个新页面 = 新建 `pages/X.tsx` + 在 `App.tsx` 路由表加一行 + 需要的话在 `components/TabBar.tsx` 加一项。别的文件不动。

## 数据约定
- 金额在程序里全程是整数「分」，只有 `lib/money.ts` 做 元↔分 转换。
- 日期全程是北京时间 `YYYY-MM-DD` 字符串，用 `lib/date.ts` 的 `today()`，不要 `new Date().toISOString().slice(0,10)`。
- `transfer` 和 `adjust` 永远不进收入/支出统计（`compute.ts` 里的 `isFlow`）。
- 账户余额 = Σ收入 − Σ支出 + Σ转入 − Σ转出 + Σ校准，没有初始余额字段。
- 分类只归档（`is_archived`）不删除；数据库改动只新增 `supabase/migrations/000N_*.sql`，不改旧文件。
- 写入失败分两类，别只写「失败就回滚」：`api.isPermanentError` 为真（`23xxx`/`42xxx` 错误码）才回滚，其余（没网、超时、登录过期）进 `lib/outbox.ts` 的待上传队列，联网后补传。默认可重传——误判成永久失败是当场丢账，误判成网络问题只是队列里卡一条、用户看得见。
- 白条账户 `kind = 'credit'`（京东白条、花呗、拼多多、美团月付），余额为负 = 欠款。**下单记支出**（账户选白条，支出算在下单那个月）、**平台扣款记转账**（银行 → 白条）、利息单独记支出。还款不预排流水。
- **到期日 = 下单日之后最近的那个还款日**（`accounts.repay_day`，京东 17、花呗和美团 1）。还款日当天下单算下一个月；填 31 时短月落到月末。`installments` 的第 k 期 = 第 1 期往后推 k−1 个月。`repay_day` 为空 = 没有固定还款日（拼多多先用后付逐笔扣），这种账户不排期，只要没被勾选结清就一直算欠着。
- **勾选结清**（`transactions.settles`）挂在**还款那一侧**，存被结清的支出 id。一次还款只写一条记录，删掉它结清关系跟着消失。只对「一次还清」的订单用，分期按账单整体还、不参与勾选。`dueInMonth` 减还款时只减「没指明结清哪几单」的那部分，否则同一笔钱会扣两次。
- **里外页面**：外页面（平时用的）显示的资产账户余额 = 真实余额 + `accounts.facade_offset`（整数「分」，null = 不修饰），里页面显示真实余额。
  **只有余额被修饰**——流水、分类统计、月收支、储蓄率、白条、导入导出全是真的，所以两边的"本月支出"一模一样。白条不参与。
  偏移量固定，因此里外同幅波动；界面上填的永远是「外面显示多少」，由 `facade.ts` 的 `offsetFor` 反推偏移量。
  切换 = 长按底部 ＋ 2.5 秒（`facade.HOLD_MS`）；切走 App 满 60 秒（`INNER_TTL_MS`）自动退回外页面。
  **`mode` 绝不能写进缓存**——冷启动必须永远是外页面，否则这个开关就白做了（`store.test.ts` 有守）。
  外页面点非白条账户的「校准」改的是偏移量、不写流水；真校准要先进里页面。里页面那屏有两个输入框，
  **有没有那些对账信息就是本人辨认自己在哪一边的记号**，所以别给外页面加任何提示文案。
- 面板按**「一行 = 这个月该还的一笔」**画（`monthBill`）：分期只出本期那一份，各行之和正好等于「本月该还」。一行一个订单的话，分期会显示整单金额，勾选加总就和本月应还对不上。

## 改动流程
1. `npm run dev` 本地看效果（手机同 WiFi 访问终端打印的地址）。
2. `npm run check`（类型检查）和 `npm test`（单测）必须全绿。**测试红了就是改坏了**，不要用「发到手机上看看」代替它。
3. 一个功能一个 commit。
4. `npm run deploy` 发布。它按顺序做：check → test → **版本号第三位自动 +1 并打 tag**（v1.0.1、v1.0.2……可到两位数如 v1.0.12）→ 构建 → 发到 gh-pages → 推 main 和 tag。所以**先 commit 再 deploy**（工作区不干净会被拒），**不要手改 `package.json` 的 version**。 大功能（比如 1.1.0 的白条）用 `npm run deploy:minor`，第二位 +1、第三位归零，其余步骤一样。改坏了 `git revert` 回退再 deploy，版本号照常 +1。

## 测试纪律
- 动了 `lib/store.ts` / `lib/compute.ts` / `lib/pending.ts` / `lib/outbox.ts` 就要补测试。这几个文件的 bug 大多是时序或边界问题，肉眼和手动操作都很难稳定复现。
- `store.test.ts` 的隔离手段：`vi.mock('./api')` 换掉唯一联网的那层，`vi.resetModules()` 每例重建 store 模块（避开 `pendingTx` / `persistTimer` 这些模块级单例串味），`vi.useFakeTimers()` 让 500ms 去抖和 10s 分类窗口变成确定性推进。照这个模式加新用例。
- **新写的测试必须先证明它会红**：把对应的修复改回出 bug 前的写法，确认用例真的变红，再改回来。不会红的测试是负资产，它让人以为有保护，其实没有。
- 单测跑在 node 环境（`vite.config.ts` 的 `test.environment`），没有 DOM。纯逻辑放 `lib/`，页面里只留渲染，这样才测得到。
- 动了 `supabase/migrations/` 或 `api.ts` 的导入导出，跑一次 `npm run test:db`（约 60 秒）。它在内存里启动真的 Postgres 走完整备份恢复流程，`npm test` 和 `npm run deploy` 都不含它。
- **数据库的实际行为不要凭记忆断言**，写进注释或文档前先用 `test:db` 跑一遍。曾经把「`on delete restrict` 一条语句同时删父子会报错」写进 README，实测是错的。

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

## 加数据库字段要同时改三处（备份脚本在另一个仓库）

「哪些列要备份」这个约定同时写在三个文件里，其中一个在私有仓库 `Michael-L340/jizhang-backup`：

| 文件 | 里面是什么 |
|---|---|
| `src/lib/api.ts` | `ACC_COLS` / `CAT_COLS` / `TX_COLS` 和 `rowToTx` / `txToRow` |
| `src/lib/csv.ts` + `src/lib/validate.ts` | 导出格式 `ExportFile`、校验规则 `readAccount` / `readCategory` / `readTransaction` |
| `src/lib/restore.dbtest.ts` | 它自己有一份 `select` / `insert` 列清单在模拟备份脚本（2026-09-07 加两列时靠它抓到的） |
| `jizhang-backup/backup.mjs` | `SELECT_ACC` / `SELECT_CAT` / `SELECT_TX`，**以及** `toAccount` / `toCategory` / `toTransaction`（逐字段构造，SELECT 拉到了这里没写照样丢；2026-09-06 加 `installments` 时真漏过） |

还有一处不是列清单但同样会静默出错：`store.ts` 的 `readCache` 要把新列补成 `null`。
冷启动先用旧版本写的缓存渲染，那份缓存里根本没有这个键，`undefined` 会一路走进算式
（2026-09-07 实测算出 `"2026-09-NaN"`）。

加一列（比如计划中的「微信/支付宝交易单号」）时几处一起改，顺序：先跑 migration → 改 `backup.mjs` → 改 `validate.ts`/`csv.ts`/`api.ts`。**云端迁移和推 `backup.mjs` 要挨着做**：只跑迁移不推脚本，当晚备份会因为「冒出不认识的列」失败；只推脚本不跑迁移，`SELECT` 会报 42703。

**漏改的后果都是静默的**（2026-09-05 在内存版真 Postgres 上逐条实测，不是推测）：

- 只改数据库，没改 `backup.mjs` → 备份文件里根本没有这一列，恢复后**整列是空的，零报错**。现在有第 5 道闸（`assertColumns`）挡着：数据库冒出脚本不认识的列，当晚备份直接失败并发邮件。**这是唯一一道自动防线，别把它删了。**
- 改了 `backup.mjs`，没改 `validate.ts` → 文件里有这一列，但校验器是显式构造对象的，多出来的键在发给数据库之前就被丢掉，同样静默。**这一步没有任何自动防护，只有这条规矩。**
- 曾经以为「列对不上 `parseImport` 会整份拒绝」——**实测不会**。只有「文件里有、数据库里没有」才会报 42703（少跑了一条 migration 才走这条路）。

改完验一遍：让备份跑一次（`gh workflow run backup.yml -R Michael-L340/jizhang-backup`），拿新的 `data/latest.json` 在设置页走一次「整库恢复」，确认新列的值真的回来了。

## 密钥
- `.env.local` 存 Supabase URL 和 anon key（模板见 `env.example`），不入库。anon key 是公开级别的；service_role key 永远不写进任何文件。
