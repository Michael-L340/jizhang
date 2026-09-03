-- 允许 expense / income 不指定账户（用于历史数据导入或记不清用哪个账户付的场景）。
-- transfer 和 adjust 仍然必须有账户，否则余额无从计算。

alter table public.transactions alter column account_id drop not null;

alter table public.transactions drop constraint if exists tx_shape;
alter table public.transactions add constraint tx_shape check (
     (type in ('expense','income')
        and category_id is not null and to_account_id is null and amount > 0)
  or (type = 'transfer'
        and category_id is null and account_id is not null and to_account_id is not null
        and to_account_id <> account_id and amount > 0)
  or (type = 'adjust'
        and category_id is null and to_account_id is null and account_id is not null)
);

-- 余额视图同步：account_id 为空的流水不影响任何账户
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
