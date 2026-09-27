-- 一次性：老模型的偏移量 → facade_adjusts（0010）。在云端跑一次；restore.dbtest.ts 在真 Postgres 上
-- 拿它和 src/lib/facade.ts 的 migrateFacade 逐行对过，两边规则必须一致，改一处要改另一处。
--
-- 只 insert，不改任何现有行；id 由来源 id 推出（前四位换成标记，其余照抄，和 facadeIdFor 一样），
-- 所以重复跑、或者以后把老备份「合并导入」进来，都是同一批 id 的 upsert，不会翻倍。
--
-- 规则（和 migrateFacade 逐条对应）：
--   修饰过的账户（facade_offset 不为 null，非白条）：一条记在 2000-01-01 的记录，
--     cents = 偏移量 + 该账户没藏掉的真实校准合计（元 → 分：round(amount * 100)）；合计为 0 不写。
--   没修饰的账户（非白条）：每条没藏掉、不为 0 的真实校准配一条同日期同金额同记录时间的孪生记录。
--   白条不参与。

insert into public.facade_adjusts (id, user_id, account_id, date, cents, created_at)
select ('fa01' || substr(a.id::text, 5))::uuid,
       a.user_id,
       a.id,
       date '2000-01-01',
       a.facade_offset + coalesce(s.sum_cents, 0),
       timestamptz '2000-01-01T00:00:00Z'
from public.accounts a
left join (
  select t.account_id, sum(round(t.amount * 100))::bigint as sum_cents
  from public.transactions t
  where t.type = 'adjust' and coalesce(t.hidden, false) = false
  group by t.account_id
) s on s.account_id = a.id
where a.kind <> 'credit'
  and a.facade_offset is not null
  and a.facade_offset + coalesce(s.sum_cents, 0) <> 0
on conflict (id) do nothing;

insert into public.facade_adjusts (id, user_id, account_id, date, cents, created_at)
select ('fa00' || substr(t.id::text, 5))::uuid,
       t.user_id,
       t.account_id,
       t.date,
       round(t.amount * 100)::bigint,
       t.created_at
from public.transactions t
join public.accounts a on a.id = t.account_id
where t.type = 'adjust'
  and coalesce(t.hidden, false) = false
  and a.kind <> 'credit'
  and a.facade_offset is null
  and t.amount <> 0
on conflict (id) do nothing;
