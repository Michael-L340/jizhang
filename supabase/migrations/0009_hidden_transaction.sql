-- 「外面不显示」：里页面给某一笔记录打上记号，外页面的最近流水、流水页、搜索里就看不到它。
--
-- 用户 2026-09-16 要的是「只是记录被隐藏了」：余额、余额曲线、收入支出统计一律不变，
-- 变的只有列表里少一行。所以它不参与任何计算，facade.ts 的 listableTxs 只在外模式过滤列表。
-- 一般用来藏一笔不想让人看见的收入。
--
-- null / false = 正常显示。老数据一点不受影响。
alter table public.transactions
  add column if not exists hidden boolean;
