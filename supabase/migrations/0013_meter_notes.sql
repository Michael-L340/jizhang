-- 0013：用电记录「每天用了多少度」的每日备注（2026-10-16，用户：「点一下最好可以备注，比如没开空调」）。
--
-- 一天最多一条。id 由日期推出（App 的 meter.noteIdFor：6d6e6f74-0000-4000-8000-0000YYYYMMDD），
-- 不加 unique(user_id, day)：两台手机给同一天写备注是同一个 id，按 id 覆盖自然只有一条；
-- 加了 unique 反而会让「合并导入」（ignoreDuplicates 只认主键冲突）撞上第二个约束整批失败。
-- 单独一张表，不引用任何表：删账户、删分类都碰不到它。回退旧版本时旧代码看不见它，备注只是暂时不显示。
create table if not exists public.meter_notes (
  id         uuid primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day        date not null,
  note       text not null check (char_length(note) between 1 and 100),
  created_at timestamptz not null default now()
);
create index if not exists mn_user_day_idx on public.meter_notes (user_id, day);

alter table public.meter_notes enable row level security;
drop policy if exists own_rows on public.meter_notes;
create policy own_rows on public.meter_notes for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
