-- 0010：外页面自己的校准记录（里外校准分家，2026-09-27）。
--
-- 老模型把「对外显示」存成 accounts.facade_offset 一个固定差值：外页面 = 真实 + 差值，
-- 一改整条曲线上下移，能藏多少还被历史最低点封顶。新模型：外页面的校准是一条有日期的记录，
-- 从那天起算、以前的点不动，和里页面的真实校准一个脾气。
--
-- 单独一张表而不是 transactions 加一列：回退旧版本时旧代码看不见这张表，
-- 不会把假校准当真校准算进里页面（那是静默算错，正是这个项目最怕的一种失败）。
-- facade_offset 留在库里不动、不再读；老偏移量由 scripts/migrate-facade.sql 一次性换算进这张表。
--
-- cents 是整数「分」（bigint），不是 numeric 元：不走元↔分换算，备份脚本少一处会算错 100 倍的地方。
-- account_id on delete restrict，和 transactions 一样：wipeAll 必须先删这张表再删账户。
create table if not exists public.facade_adjusts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete restrict,
  date       date not null,
  cents      bigint not null,
  created_at timestamptz not null default now()
);
create index if not exists fa_user_account_idx on public.facade_adjusts (user_id, account_id);

alter table public.facade_adjusts enable row level security;
drop policy if exists own_rows on public.facade_adjusts;
create policy own_rows on public.facade_adjusts for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
