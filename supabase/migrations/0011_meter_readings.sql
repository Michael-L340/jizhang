-- 0011：租房电表读数（用电记录，2026-10-03）。
--
-- 用户每次看一眼电表、输入上面的累计读数（越走越大），一天可以记好几次。
-- App 拿相邻两次读数算「用了几度、每小时几度」，再按时间分摊到每一天。
--
-- 单独一张表，和记账的四张表没有外键关系：删账户、删分类都碰不到它。
-- centi_kwh 是整数「0.01 度」（bigint），不是 numeric 度：和 facade_adjusts 的 cents 一个道理，
-- 不走小数换算，相减不出 0.0999999 这种尾巴，备份脚本也少一处会算错 100 倍的地方。
-- read_at 是读数那一刻（带时区的时间点），补记时可以填过去的时间，所以和 created_at 分开。
create table if not exists public.meter_readings (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  read_at    timestamptz not null,
  centi_kwh  bigint not null check (centi_kwh >= 0),
  created_at timestamptz not null default now()
);
create index if not exists mr_user_read_at_idx on public.meter_readings (user_id, read_at);

alter table public.meter_readings enable row level security;
drop policy if exists own_rows on public.meter_readings;
create policy own_rows on public.meter_readings for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
