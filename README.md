# 记账

个人记账 PWA。单用户（michael），手机当 App 用，电脑开网页，同一份云端数据。

- 线上地址：https://michael-l340.github.io/jizhang/
- 仓库：https://github.com/Michael-L340/jizhang （**public**，所以任何账本数据、密钥、备份文件都不许进这个目录）
- 数据库：Supabase（PostgreSQL，新加坡区），项目 ref 和 anon key 在本地 `.env.local`（已 gitignore，模板见 `env.example`）

> 给接手的人（包括未来的我）：**先读 `CLAUDE.md`**，那是改代码必须遵守的规矩。
> 本文件只讲「是什么、怎么跑、代码在哪」；「为什么」和「踩过哪些坑」按主题拆在 `docs/`，需要哪块读哪块。

---

---

## 文档导航

| 文件 | 什么时候读 | 大小 |
|---|---|---|
| `CLAUDE.md` | **每次改代码前**。只有规矩，没有故事 | ~5k |
| `docs/数据与迁移.md` | 动数据库、加字段、考虑版本回退时 | ~3.8k |
| `docs/备份与恢复.md` | 备份出问题、要恢复、换 Supabase 项目时 | ~7k |
| `docs/测试.md` | 想知道某个测试文件守什么、怎么写新测试 | ~2.1k |
| `docs/里外页面.md` | 动首页 / 账户页 / 统计页的余额显示时 | ~2.2k |
| `docs/决策记录.md` | 做产品决定前。踩过的坑、明确不做的、用户偏好、开发历史 | ~6.1k |
| `docs/logo-sources.md` | 换账户图标时 | ~1.1k |
| `docs/审查报告-2026-09-04.md` | **归档，别整本读**。71 条发现已全部处理完，结论并进了上面几份 | ~144.8k |

大小随手更新，不必精确。拆开是为了省 token：以前这些全在一个 19k 的 README 里，问一句细节就得整本读进来。

## 一、技术栈与为什么这么选

| 选择 | 理由 |
|---|---|
| Vite + React 19 + TypeScript | 纯前端 CRUD，不需要服务端渲染，构建 3 秒 |
| Tailwind v4（`@tailwindcss/vite`） | 无 config 文件，样式变量写在 `src/index.css` 的 `@theme` 里 |
| zustand | 单用户数据量小，全量装进内存即可；TanStack Query 的缓存/分页能力用不上 |
| react-router-dom **HashRouter** | GitHub Pages 子路径不需要任何 rewrite 配置，换托管零成本 |
| ECharts 6（按需引入） | 饼/柱/折线齐全，中文友好；统计页 `React.lazy` 拆包，首屏不背这个包 |
| supabase-js | 直接从浏览器读写 Postgres，靠 RLS 保证安全，不用自己写后端 |
| vite-plugin-pwa（`prompt` 模式） | 自动更新会在输金额时刷掉页面，改成横幅让用户点 |
| 不装 dayjs / date-fns | 日期全程是北京时间 `YYYY-MM-DD` 字符串，引入 Date 对象正是时区 bug 的源头 |

托管选 GitHub Pages 而不是 Vercel：`*.vercel.app` 在国内移动网络被阻断的报告更多；`github.io` 实测在用户手机上可达。仓库必须 public，因为 Pages 对私有仓库收费；代码里没有秘密，账本靠 RLS 保护。

## 二、目录结构

```
src/
├── main.tsx / App.tsx        路由表、登录门禁、更新横幅、每页 ErrorBoundary
├── index.css                 主题色变量、safe-area、宽屏限宽 430px
├── types.ts                  唯一的数据形状定义（金额单位 = 分）
├── lib/
│   ├── supabase.ts           客户端单例，只允许 api.ts import
│   ├── api.ts                ★唯一接触 Supabase 的文件，换后端只改这里
│   ├── store.ts              zustand，乐观更新 + localStorage 缓存
│   ├── compute.ts            余额与统计的纯函数（有单测）
│   ├── money.ts              元↔分 唯一转换点
│   ├── date.ts               北京时间日期工具
│   ├── backup.ts             自动备份状态 + 本机缓存占用的纯计算（有单测）
│   ├── palette.ts            分类固定配色
│   ├── csv.ts                CSV / JSON 导出与导入
│   ├── validate.ts           导入文件的落地前校验（动云端之前把数据库约束跑一遍）
│   ├── sw.ts                 检查更新 / 强制刷新
│   ├── pending.ts            在途写入补丁（refresh 不冲掉刚记的那笔）
│   ├── hooks.ts / id.ts      小工具
│   ├── facade.ts             里外页面的纯逻辑
│   ├── chart.ts              图表布局的纯计算（x 轴降密、图例换行与缩写）
│   ├── outbox.ts             断网时的待上传队列
│   └── *.test.ts             单测，`npm test`；`*.dbtest.ts` 走 `npm run test:db`
├── pages/                    Login / Home / Ledger / Entry / Stats / Accounts / Settings
└── components/               TabBar / Keypad / ChipGroup / TxRow / Sheet / Chart /
                              MonthPicker / DatePicker / RangeSheet / AccountIcon /
                              ErrorBoundary / Toast
supabase/migrations/          000N_*.sql，只新增不改旧文件
docs/                         数据与迁移 / 备份与恢复 / 测试 / 里外页面 / 决策记录 / logo-sources
```

## 四、开发与部署

```bash
npm run dev      # 本地开发，--host 已开，手机同 WiFi 可直接访问
npm run check    # tsc -b 类型检查
npm test         # vitest
npm run deploy   # check + test + 版本号第三位 +1 并打 tag + 构建 + 发布到 gh-pages + 推 main
```

`npm run deploy` 先跑 `npm version patch`：把 `package.json` 的第三位 +1、生成一条 `vX.Y.Z` 提交和同名 tag（要求工作区干净，所以先 commit 再 deploy），再用 `VITE_BASE=/jizhang/` 构建（Pages 子路径），最后把 main 和 tag 一起推到 GitHub。发布后 GitHub CDN 可能缓存几分钟。验证是否上线：比对本地 `dist/assets/index-*.js` 的文件名和线上 `index.html` 引用的是否一致。

数据库改动：新增 `supabase/migrations/000N_*.sql`，**不改旧文件**。执行方式二选一：Supabase 控制台 SQL Editor 粘贴，或用 Management API（需要用户临时生成 `sbp_` 令牌，用完删）。
