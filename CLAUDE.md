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

## 改动流程
1. `npm run dev` 本地看效果（手机同 WiFi 访问终端打印的地址）。
2. `npm run check`（类型检查）和 `npm test`（单测）必须全绿。**测试红了就是改坏了**，不要用「发到手机上看看」代替它。
3. 一个功能一个 commit。
4. `npm run deploy` 发布。它按顺序做：check → test → **版本号第三位自动 +1 并打 tag**（v1.0.1、v1.0.2……可到两位数如 v1.0.12）→ 构建 → 发到 gh-pages → 推 main 和 tag。所以**先 commit 再 deploy**（工作区不干净会被拒），**不要手改 `package.json` 的 version**。改坏了 `git revert` 回退再 deploy，版本号照常 +1。

## 测试纪律
- 动了 `lib/store.ts` / `lib/compute.ts` / `lib/pending.ts` 就要补测试。这三个文件的 bug 大多是时序或边界问题，肉眼和手动操作都很难稳定复现。
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

## 备份脚本在另一个仓库，改这几处要同步改它
`api.ts` 的列常量（`ACC_COLS` / `CAT_COLS` / `TX_COLS`）、或备份文件的格式（`csv.ts` 的 `ExportFile`、`validate.ts` 的校验规则）改了，**私有仓库 `Michael-L340/jizhang-backup` 里的 `backup.mjs` 必须同步改**。不改的现象不是「备份失败」而是更坏的「备份天天在跑，等真要用的时候导不回来」——文件少一列或多一列，`parseImport` 直接整份拒绝。改完顺手在设置页用最新的 `latest.json` 走一次「合并导入」验一下。

## 密钥
- `.env.local` 存 Supabase URL 和 anon key（模板见 `env.example`），不入库。anon key 是公开级别的；service_role key 永远不写进任何文件。
