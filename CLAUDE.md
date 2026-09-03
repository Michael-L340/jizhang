# 记账 PWA — 项目规则

单用户个人记账。Vite + React 19 + TypeScript + Tailwind v4 + zustand + supabase-js + ECharts + vite-plugin-pwa。
完整设计见 `架构方案-v2.md`；数据库脚本在 `supabase/migrations/`。

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
2. `npm run check`（类型检查）和 `npm test`（单测）必须全绿。
3. 一个功能一个 commit。
4. `npm run deploy` 发布（内含 check + test）。改坏了 `git revert` 回退再 deploy。

## 密钥
- `.env.local` 存 Supabase URL 和 anon key（模板见 `env.example`），不入库。anon key 是公开级别的；service_role key 永远不写进任何文件。
