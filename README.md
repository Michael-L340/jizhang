# 记账

个人记账 PWA。单用户（michael），手机当 App 用，电脑开网页，同一份云端数据。

- 线上地址：https://michael-l340.github.io/jizhang/
- 仓库：https://github.com/Michael-L340/jizhang （**public**，所以任何账本数据、密钥、备份文件都不许进这个目录）
- 数据库：Supabase（PostgreSQL，新加坡区），项目 ref 和 anon key 在本地 `.env.local`（已 gitignore，模板见 `env.example`）

> 给接手的人（包括未来的我）：**先读 `CLAUDE.md`**，那是改代码必须遵守的分层与流程约定。本文件负责讲清楚"为什么长这样"和"踩过哪些坑"。

---

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
│   ├── palette.ts            分类固定配色
│   ├── csv.ts                CSV / JSON 导出与导入
│   ├── sw.ts                 检查更新 / 强制刷新
│   ├── hooks.ts / id.ts      小工具
│   └── compute.test.ts       16 项单测，`npm test`
├── pages/                    Login / Home / Ledger / Entry / Stats / Accounts / Settings
└── components/               TabBar / Keypad / ChipGroup / TxRow / Sheet / Chart /
                              MonthPicker / DatePicker / RangeSheet / AccountIcon /
                              ErrorBoundary / Toast
supabase/migrations/          000N_*.sql，只新增不改旧文件
docs/logo-sources.md          四个品牌标志的来源与授权
```

## 三、数据模型

三张表，全部带 `user_id`，RLS `for all to authenticated using/with check (user_id = auth.uid())`。

**accounts** — 4 行固定：中国银行、招商银行、支付宝、微信。没有初始余额字段。

**categories** — `parent_id` 为空是一级。触发器限制最多两级、父子 `kind` 必须一致。`note` 存含义说明。支出 5 大类 + 若干二级，收入 6 个单级。

**transactions** — `type` 四种：
- `expense` / `income`：必须有 `category_id`，`account_id` **可为空**（不指定账户，计入收支统计但不影响任何余额）
- `transfer`：必须有 `account_id` 和 `to_account_id` 且不相同
- `adjust`：余额校准，金额可正可负可为 0，必须有 `account_id`

### 余额公式（`compute.ts`）

```
账户余额 = Σ收入 − Σ支出 + Σ转入 − Σ转出 + Σ校准
总余额   = 四个账户之和
```

两条铁律，所有统计函数的第一行 filter：**`transfer` 和 `adjust` 永远不进收入/支出统计**。转账只是钱在自己账户间挪；校准只修正余额，不制造收支。

### 校准怎么工作

用户在账户页输入"实际余额"，系统算 `差额 = 实际 − 推算`，写一条 `adjust`。差额为 0 也写（金额 0，备注"余额核对"），这样"上次核对时间"能跨设备同步；流水页里 0 元记录显示为灰色。

统计页底部的"未记录差额"= Σadjust，负数说明有支出没记，正数说明有收入没记。这是"一行带符号"写法独有的好处，双边记账给不了。

## 四、开发与部署

```bash
npm run dev      # 本地开发，--host 已开，手机同 WiFi 可直接访问
npm run check    # tsc -b 类型检查
npm test         # vitest
npm run deploy   # check + test + 构建 + 发布到 gh-pages 分支
```

`npm run deploy` 用 `VITE_BASE=/jizhang/` 构建（Pages 子路径），发布后 GitHub CDN 可能缓存几分钟。验证是否上线：比对本地 `dist/assets/index-*.js` 的文件名和线上 `index.html` 引用的是否一致。

数据库改动：新增 `supabase/migrations/000N_*.sql`，**不改旧文件**。执行方式二选一：Supabase 控制台 SQL Editor 粘贴，或用 Management API（需要用户临时生成 `sbp_` 令牌，用完删）。

## 五、踩过的坑（按会咬人的概率排序）

1. **PostgREST 默认 max_rows = 1000**，全量拉取会被静默截断。后台已改 20000，`fetchAll()` 另有 `.range()` 分页循环兜底，两道都要留。
2. **时区差一天**。`new Date().toISOString().slice(0,10)` 拿到的是 UTC 日期，凌晨 0–8 点记的账会记到昨天。统一用 `date.ts` 的 `today()`（`Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai'})`）。数据库的 `date` 列不设 `default current_date`（服务器在 UTC）。
3. **浮点钱**。DB 用 `numeric(12,2)`，JS 全程整数分，只在 `money.ts` 两端转换。
4. **iOS `-webkit-overflow-scrolling: touch` 会把内部 `position:fixed` 困在滚动容器内**，底部弹层被导航条截断。已删掉该属性（iOS 13+ 默认惯性滚动），并把 `Sheet` 改成 `createPortal` 到 `document.body`。
5. **`#root` 设成 flex 居中后，与 app-shell 平级的元素会被挤成一条**。更新横幅曾因此在 iPhone 上点不到。现在 Root 统一渲染单列 `app-shell`，Shell/Login/Entry 都是 `flex-1` 子项。
6. **iOS 的原生 `<input type="date">` 不遵守 `max`**，能选到未来。已换成自绘 `DatePicker`。
7. **iOS 主屏 App 长期挂起，SW 不主动检查更新**。已加每小时 + 切回前台各查一次，设置页另有"检查更新"和"强制刷新（清程序缓存重载）"兜底。
8. **iOS 主屏 App 与 Safari 存储隔离**，同一网址要各登录一次。也因此不用 magic link，只用邮箱密码。
9. **下钻漏钱**：直接记在一级分类上（没选二级）的记录，下钻时会整个消失。已在 `byCategory` 里把这类归入「未细分」子项，并加单测守住"二级合计 = 一级合计"。
10. **WSL 下项目在 `/mnt/c`**，inotify 不工作，`vite.config.ts` 里开了 `watch.usePolling`。
11. **iOS 输入框 font-size < 16px 会自动放大页面**，全局已设 16px。
12. **Supabase 免费版无自动备份**，误删无还原点。靠设置页导出 JSON，建议每月一次。
13. **免费项目 7 天无访问会休眠**，数据不丢，需去控制台唤醒。

## 六、开发历史

均为 2026 年，一个功能一个 commit。

| 日期 | 内容 |
|---|---|
| 09-03 | 脚手架、数据层、7 个页面、建表脚本；GitHub Pages 部署跑通 |
| 09-03 | 账户改为可不指定（迁移 0002）；导入用户 Excel 里 9/1–9/3 的 7 笔支出；账户图标换成真实品牌标志 |
| 09-03 | 统计页改版：饼图去掉图外标签改为圆环中心显示总额、分类固定配色、二级同色系深浅；新增分类含义（迁移 0003）与月份选择器 |
| 09-03 | 趋势图从"月内每日累计"改为"每月总额"；月份选择器格子显示当月金额；宽屏限宽 430px 居中 |
| 09-03 | 修 TabBar 加号突出；弃用原生日期控件改自绘日历 |
| 09-03 | 修 iPhone 更新横幅点不到；修底部弹层被导航条截断；设置页加修改密码 |
| 09-04 | 修下钻漏钱（未细分）；支出趋势支持按日/按月 + 时间范围（近三月/半年/一年/全部/自定义） |
| 09-04 | 设置页支持移动二级分类到其他大类；用户把「通勤交通」移到「日常餐饮」下并改名为「日常开支」 |

## 七、用户的偏好（沟通时注意）

- 编程小白。要大白话解释每个技术决定会带来什么可感知的后果，术语后面跟一句人话。
- 配置类工作全部由助手完成，用户只注册账号、临时生成令牌。令牌用完提醒删除。
- 强调模块化，"改一部分不影响其他部分"。除了分层，还靠类型检查、每页 ErrorBoundary、一功能一 commit 三道保险。
- 密码和账本数据绝不能进这个公开仓库；备份文件写到仓库目录之外（桌面）。

## 八、还没做的

预算、微信/支付宝账单导入、自然语言记账、周期账单、搜索、标签、离线记账（IndexedDB 补录队列）、邮件找回密码。

数据量长到几万行后，`localStorage` 全量缓存可能超 iOS 限制，届时换 IndexedDB 并只加载近两年，改动集中在 `store.ts` / `api.ts`。
