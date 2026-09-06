-- 白条账户：kind = 'credit'。余额为负表示欠平台的钱。
-- 记法：下单记支出（账户选白条，支出算在下单那个月）；平台扣款记转账（银行 → 白条）；
-- 利息单独记一笔支出。总资产 = 资产账户 − 白条欠款。
alter table public.accounts drop constraint if exists accounts_kind_check;
alter table public.accounts add constraint accounts_kind_check check (kind in ('bank','wallet','credit'));

do $$
declare uid uuid;
begin
  select id into uid from auth.users order by created_at limit 1;
  if uid is null then
    raise exception '请先到 Authentication → Users → Add user 创建你的账号，再运行本脚本';
  end if;
  insert into public.accounts (user_id, name, kind, sort) values
    (uid,'京东白条','credit',5),(uid,'花呗','credit',6),
    (uid,'拼多多','credit',7),(uid,'美团月付','credit',8)
  on conflict (user_id, name) do nothing;
end $$;
