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
│   ├── pending.ts            在途写入补丁（refresh 不冲掉刚记的那笔）
│   ├── hooks.ts / id.ts      小工具
│   └── *.test.ts             compute / pending / store 三组单测，`npm test`
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

## 五、测试是护栏，不是装饰

`npm test` 三组测试，全在 node 环境跑纯逻辑，一次约 2 秒。

| 文件 | 守住什么 |
|---|---|
| `src/lib/compute.test.ts` | 算钱的纯函数：余额、分类汇总、时间分桶、「二级合计 = 一级合计」 |
| `src/lib/pending.test.ts` | 在途补丁的叠加规则 |
| `src/lib/store.test.ts` | 数据层的并发时序与本机缓存（见下） |
| `src/lib/api.test.ts` | 发给数据库的请求长什么样：删除顺序、元↔分换算、分页键 |
| `src/lib/csv.test.ts` | 导入文件的校验（整库恢复会先删数据，文件必须先验过） |
| `src/lib/palette.test.ts` | 配色：相邻两级颜色必须看得出区别 |
| `src/lib/restore.dbtest.ts` | **不在 `npm test` 里**。真 Postgres 上跑完整备份恢复，`npm run test:db` |

### 为什么 `store.test.ts` 特别重要

`store.ts` 的 bug 有个共同特点：**只在特定的请求先后顺序下才出现**。
「记完账切走再切回，那笔消失了」——要落在「POST 还没落库、GET 已经返回」那个窗口里才会发生。
在手机上手动测，十次可能撞上一次，撞不上不等于没有。

做法是把 `api.ts`（唯一真正联网的那层）换成一个可以随意摆布的假实现：
想让某个请求一直卡着就卡着，想让它什么时候失败就什么时候失败。
靠运气才能撞上的时序，于是变成每次跑都必然复现。

它守住的行为，每一条都对应一个真实修过的 bug：

- 写请求还在飞时同步回来了，那笔不能消失、不能复活、不能被打回旧值
- 写请求完成后补丁必须撤销——服务端说没有就是没有，不能永远钉在界面上
- 某一笔保存失败只能撤销它自己，不能牵连同时进行的另一笔
- 缓存去抖只落一次盘、只写三张表、写满时降级并提示一次、退出登录取消在途写入
- 同步失败必须留痕，不能静默

### 怎么用

改完 `store.ts` 跑 `npm test`。**红了就是改坏了**，不用猜，也不用先发到手机上试。
`npm run deploy` 内含 check + test，测试不过发布不出去。

### 一条纪律：新测试要先证明它会红

写完一条测试，把对应的修复改回出 bug 前的写法，确认测试真的变红，再改回来。
不会红的测试是负资产——它让人以为有保护，其实没有。
2026-09-04 这批 22 项就是这样验的：12 处修复逐一改回旧写法，每一处都有用例变红。


## 六、备份与恢复

> 2026-09-04 审查发现：这条路以前是**断的**——按当时的步骤恢复到新建的库，
> 一条都导不进去，而且报错还指错了地方。之所以三个月没人发现，是因为
> **README 里从来没写过恢复步骤，也就从来没人走过一遍**。

### 备份

设置页「导出 JSON 完整备份」。文件里 `amount` 是**整数分**（12.50 元存成 `1250`），
和内存里的表示一致；只有 `api.ts` 的 `txToRow` 会在写库前转成 numeric 字符串。

**写任何备份脚本都必须守住这条**：直接把数据库里的「元」倒进 JSON，恢复那天金额会
变成百分之一，而且数据库不会报任何错。`parseImport` 现在逐条卡 `Number.isInteger`，
就是这类错误的唯一防线（`src/lib/csv.test.ts` 锁着）。

### 两种恢复，别选错

| | 做什么 | 什么时候用 |
|---|---|---|
| **合并导入** | 同 id 覆盖，不删任何东西 | 误删了几笔想找回来。备份之后新记的账不受影响 |
| **整库恢复** | 先清空云端，再按文件重建 | 换了数据库，或者要完整回到备份那一刻 |

「合并导入」是 upsert，**只增不改删**——它做不到「撤销备份之后新增的记录」。
要回到某个时点只能用「整库恢复」。

### 换到新 Supabase 项目的完整步骤

1. 新建项目，Authentication → Users 建好自己的账号
2. SQL Editor 依次跑 `supabase/migrations/0001` → `0002` → `0003`
3. `.env.local` 换成新项目的 URL 和 anon key，`npm run deploy`
4. 登录 → 设置页 →「**整库恢复**」→ 选备份文件

第 4 步必须用「整库恢复」不能用「合并导入」：第 2 步的 `0001` 会预置 4 个账户和
全套分类，用的是**新 id**，而备份里是**旧 id 但同名**。`accounts` 有
`unique(user_id, name)`、`categories` 有 `cat_root_uniq` / `cat_child_uniq`，
`upsert(onConflict: 'id')` 不认名字这个唯一索引，一撞就抛 23505，第一句就炸、
后面全不执行。「整库恢复」先清空正是为了绕开这个。

### 为什么清空要分四步

`wipeAll()` 的顺序是 **流水 → 二级分类 → 一级分类 → 账户**：

- `transactions.account_id / category_id` 都是 `on delete restrict`，先删账户或分类会被拒绝
- `categories.parent_id` 也是 `restrict`，只删一级、留着二级同样会被拒绝

二级和一级分两步，是因为 PostgREST 每次调用只发一条带过滤条件的 `DELETE`，顺序得由我们显式写出来。

> 一处更正：早先这里写的是「`restrict` 不能延迟到语句结束再查，一条 delete 同时删父子会当场报错」。
> `npm run test:db` 实测**推翻了这句**——不带过滤的 `delete from categories` 把父子一起删是能成功的，
> 因为 `restrict` 的检查发生在**语句结束时**。它和 `no action` 的真正区别是能否延迟到**事务**结束。
> 分两步仍然保留：更显式、也不依赖这个细节。

### 这条路真的验过了

`npm run test:db` 会在内存里启动一个**真的 Postgres**（PGlite，Postgres 编译成 WASM），
真的执行 `supabase/migrations/` 下的建表脚本，再走一遍完整的备份与恢复。不联网、不碰任何真实数据。

实测结论：

| 场景 | 结果 |
|---|---|
| 换新库后直接「合并导入」 | ✅ 如预期失败：`23505 duplicate key ... accounts_user_id_name_key` |
| 「整库恢复」（先清空再导入） | ✅ 账户/分类/流水逐行逐字段完全一致 |
| 金额往返（分 → numeric → 分） | ✅ 零误差，含 4846.42、0.05、-10.84 |
| 误删几笔后「合并导入」 | ✅ 找回来了，备份之后新记的账没动，无重复行 |
| 同一个文件重复导入三次 | ✅ 幂等，条数不变 |
| 先删账户 / 只删一级留二级 | ✅ 都被外键拒绝 |
| 支出记到收入分类、转账两边同账户、三级分类 | ✅ 都被数据库自己拦住 |

动了 `supabase/migrations/` 或 `api.ts` 的导入导出，就手动跑一次 `npm run test:db`（约 40 秒）。
它**不在** `npm test` 和 `npm run deploy` 里，免得每次改代码都等。

### 还没做，但要做

自动备份：GitHub Actions 每天把快照提交到一个**私有**仓库（绝不能是这个公开仓库）。
做之前先把上面的恢复步骤在真机上完整走一遍——**没验过的备份等于没有备份**。
另外建议每季度手动导出一次 JSON 存到本机或网盘，作为第二条腿：GitHub 账号本身丢了，
代码和备份会一起没。


## 七、踩过的坑（按会咬人的概率排序）

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
13. **`upsert(onConflict: 'id')` 不认唯一索引**。表上除主键外还有 `unique(user_id, name)` 之类的约束时，同名不同 id 的行会直接抛 23505 而不是转成 UPDATE。备份恢复到新库整条路都栽在这上面，见第六节。
14. **`on delete restrict` 的检查发生在语句结束时，不是逐行立刻检查**。所以自引用表一条 `delete from categories` 把父子一起删是能成功的；它和 `no action` 的区别是能否延迟到**事务**结束。真正会被拒绝的是「只删一级、留着二级」。这条是 `npm run test:db` 实测出来的，此前文档里写反了。
15. **免费项目 7 天无访问会休眠**，数据不丢，需去控制台唤醒。

## 八、开发历史

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
| 09-04 | 数据层三处并发/缓存问题：refresh 落地前叠加在途补丁（新增 `lib/pending.ts`）、写失败按 id 回滚、缓存去抖与写满降级提示；同步失败不再静默 |
| 09-04 | 补 `store.test.ts` 22 项测试并做变异验证（12 处修复逐一改回旧写法，全部有用例变红）；测试项 24 → 46 |

## 九、用户的偏好（沟通时注意）

- 编程小白。要大白话解释每个技术决定会带来什么可感知的后果，术语后面跟一句人话。
- 配置类工作全部由助手完成，用户只注册账号、临时生成令牌。令牌用完提醒删除。
- 强调模块化，"改一部分不影响其他部分"。除了分层，还靠类型检查、每页 ErrorBoundary、一功能一 commit 三道保险。
- 密码和账本数据绝不能进这个公开仓库；备份文件写到仓库目录之外（桌面）。

## 十、还没做的

预算、微信/支付宝账单导入、自然语言记账、周期账单、搜索、标签、离线记账（IndexedDB 补录队列）、邮件找回密码。

数据量长到几万行后，`localStorage` 全量缓存可能超 iOS 限制，届时换 IndexedDB 并只加载近两年，改动集中在 `store.ts` / `api.ts`。
