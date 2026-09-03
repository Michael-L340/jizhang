-- 个人记账 v1 初始化脚本（幂等，可重复运行）
-- 运行前提：先在 Authentication → Users 创建自己的账号

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- accounts
create table if not exists public.accounts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null,
  kind        text not null default 'bank' check (kind in ('bank','wallet')),
  sort        smallint not null default 0,
  is_archived boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, name)
);

-- categories（parent_id 为空 = 一级）
create table if not exists public.categories (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind        text not null check (kind in ('expense','income')),
  parent_id   uuid references public.categories(id) on delete restrict,
  name        text not null,
  icon        text,
  sort        smallint not null default 0,
  is_archived boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists cat_child_uniq
  on public.categories (user_id, parent_id, name) where parent_id is not null;
create unique index if not exists cat_root_uniq
  on public.categories (user_id, kind, name) where parent_id is null;

create or replace function public.categories_depth_guard()
returns trigger language plpgsql as $$
declare p record;
begin
  if new.parent_id is not null then
    select kind, parent_id into p from public.categories where id = new.parent_id;
    if p is null then raise exception '父分类不存在'; end if;
    if p.parent_id is not null then raise exception '分类最多两级'; end if;
    if p.kind <> new.kind then raise exception '子分类的 kind 必须与父级一致'; end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_cat_depth on public.categories;
create trigger trg_cat_depth before insert or update on public.categories
  for each row execute function public.categories_depth_guard();

-- transactions
create table if not exists public.transactions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  date          date not null,
  type          text not null check (type in ('expense','income','transfer','adjust')),
  amount        numeric(12,2) not null,
  account_id    uuid not null references public.accounts(id) on delete restrict,
  to_account_id uuid          references public.accounts(id) on delete restrict,
  category_id   uuid          references public.categories(id) on delete restrict,
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint tx_shape check (
       (type in ('expense','income')
          and category_id is not null and to_account_id is null and amount > 0)
    or (type = 'transfer'
          and category_id is null and to_account_id is not null
          and to_account_id <> account_id and amount > 0)
    or (type = 'adjust'
          and category_id is null and to_account_id is null)
  )
);
create index if not exists tx_user_date_idx    on public.transactions (user_id, date desc, created_at desc);
create index if not exists tx_user_account_idx on public.transactions (user_id, account_id);
create index if not exists tx_user_cat_idx     on public.transactions (user_id, category_id);

create or replace function public.tx_category_kind_guard()
returns trigger language plpgsql as $$
declare k text;
begin
  if new.category_id is not null then
    select kind into k from public.categories where id = new.category_id;
    if k <> new.type then raise exception '分类类型(%)与流水类型(%)不匹配', k, new.type; end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_tx_cat_kind on public.transactions;
create trigger trg_tx_cat_kind before insert or update on public.transactions
  for each row execute function public.tx_category_kind_guard();

drop trigger if exists trg_acc_upd on public.accounts;
create trigger trg_acc_upd before update on public.accounts
  for each row execute function public.set_updated_at();
drop trigger if exists trg_cat_upd on public.categories;
create trigger trg_cat_upd before update on public.categories
  for each row execute function public.set_updated_at();
drop trigger if exists trg_tx_upd on public.transactions;
create trigger trg_tx_upd before update on public.transactions
  for each row execute function public.set_updated_at();

-- RLS
alter table public.accounts     enable row level security;
alter table public.categories   enable row level security;
alter table public.transactions enable row level security;
drop policy if exists own_rows on public.accounts;
create policy own_rows on public.accounts for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists own_rows on public.categories;
create policy own_rows on public.categories for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists own_rows on public.transactions;
create policy own_rows on public.transactions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- 预置数据
do $$
declare uid uuid;
begin
  select id into uid from auth.users order by created_at limit 1;
  if uid is null then
    raise exception '请先到 Authentication → Users → Add user 创建你的账号，再运行本脚本';
  end if;

  insert into public.accounts (user_id, name, kind, sort) values
    (uid,'中国银行','bank',1),(uid,'招商银行','bank',2),
    (uid,'支付宝','wallet',3),(uid,'微信','wallet',4)
  on conflict (user_id, name) do nothing;

  insert into public.categories (user_id, kind, name, sort, icon)
  select uid,'expense',x.name,x.ord,x.icon from (values
    ('日常餐饮',1,'🍚'),('娱乐消费',2,'🎮'),('经常生活开支',3,'🏠'),
    ('非经常生活消费',4,'🎁'),('意外开支',5,'⚡')
  ) as x(name,ord,icon)
  on conflict do nothing;

  insert into public.categories (user_id, kind, parent_id, name, sort)
  select uid, 'expense', p.id, x.child, x.ord
  from (values
    ('日常餐饮','早餐',1),('日常餐饮','午餐',2),('日常餐饮','晚餐',3),
    ('日常餐饮','夜宵',4),('日常餐饮','咖啡奶茶',5),('日常餐饮','零食水果',6),
    ('娱乐消费','聚餐下馆子',1),('娱乐消费','游戏充值',2),('娱乐消费','影音会员',3),
    ('娱乐消费','电影演出',4),('娱乐消费','旅行出游',5),('娱乐消费','运动健身',6),
    ('经常生活开支','房租',1),('经常生活开支','水电燃气',2),('经常生活开支','通勤交通',3),
    ('经常生活开支','话费网费',4),('经常生活开支','日用百货',5),('经常生活开支','洗衣理发',6),
    ('非经常生活消费','服饰鞋包',1),('非经常生活消费','数码电器',2),('非经常生活消费','礼物人情',3),
    ('非经常生活消费','学习充电',4),('非经常生活消费','医疗健康',5),('非经常生活消费','家居家装',6),
    ('意外开支','罚款赔偿',1),('意外开支','维修损坏',2),('意外开支','手续费利息',3),
    ('意外开支','代付垫付',4),('意外开支','其他',5)
  ) as x(parent, child, ord)
  join public.categories p
    on p.user_id = uid and p.kind = 'expense' and p.parent_id is null and p.name = x.parent
  on conflict do nothing;

  insert into public.categories (user_id, kind, name, sort)
  select uid,'income',x.name,x.ord from (values
    ('工资/实习',1),('生活费',2),('奖学金',3),('理财收益',4),('退款',5),('其他',6)
  ) as x(name,ord)
  on conflict do nothing;
end $$;

-- 对账视图（走 RLS）
create or replace view public.account_balances with (security_invoker = on) as
select a.id as account_id, a.name,
       coalesce(sum(case
         when t.account_id = a.id    and t.type = 'income'   then  t.amount
         when t.account_id = a.id    and t.type = 'expense'  then -t.amount
         when t.account_id = a.id    and t.type = 'adjust'   then  t.amount
         when t.account_id = a.id    and t.type = 'transfer' then -t.amount
         when t.to_account_id = a.id and t.type = 'transfer' then  t.amount
         else 0 end), 0) as balance
from public.accounts a
left join public.transactions t
  on t.user_id = a.user_id and (t.account_id = a.id or t.to_account_id = a.id)
group by a.id, a.name;
