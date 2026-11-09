-- 0014：设置 → 参数（2026-11-09，用户：「放在设置里，之后可能有很多需要更改的，可以统一管理。还是放在云上保存吧」）。
--
-- 一项一行：用电日均看近几天、电价……以后再加参数只往登记表（App 的 lib/prefs.ts）里加一行，不用再动数据库。
-- value 一律是文字，每一项自己解析；解析不了按默认算。
-- id 由登记表写死（70726566-0000-4000-8000-00000000000N），两台手机改同一项是同一个 id，按 id 覆盖；
-- 不加 unique(user_id, key)：理由同 0013 的 meter_notes——「合并导入」（ignoreDuplicates 只认主键冲突）会撞上第二个约束整批失败。
-- 单独一张表，不引用任何表。回退旧版本时旧代码看不见它，各项照旧版本写死的数算，电价照旧读手机本机那份。
create table if not exists public.prefs (
  id         uuid primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  key        text not null check (char_length(key) between 1 and 64),
  value      text not null check (char_length(value) <= 200),
  updated_at timestamptz not null default now()
);

alter table public.prefs enable row level security;
drop policy if exists own_rows on public.prefs;
create policy own_rows on public.prefs for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
