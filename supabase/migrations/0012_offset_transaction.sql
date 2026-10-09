-- 0012：「抵消」勾选（2026-10-09，用户原话「有些收入，是因为支出退款的，如果计算进入收入，会虚增」
-- 「也可以是支出抵消收入」）。
--
-- is_offset = true 的收入不算收入，从**它所选的支出分类**里扣掉（退款）；
-- is_offset = true 的支出不算支出，从**它所选的收入分类**里扣掉（垫付、代收）。账户余额照常变。
-- 所以这种记录的分类和自己的类型是反着的：收入挂支出分类、支出挂收入分类。
--
-- 只加一个可空列；null / false = 普通收支。回退到 1.3.31 及以前：旧代码不读这一列，
-- 抵消的那几笔照普通收支算（收入、支出各自虚高，结余和余额都不错）。
alter table public.transactions add column if not exists is_offset boolean;

-- 0001 的守卫要求「分类的 kind = 流水的 type」。抵消的那笔反过来：分类的 kind = 另一边。
-- 只放开这一种情况，别的照旧拒收。search_path 钉死，免得被同名对象劫持。
create or replace function public.tx_category_kind_guard()
returns trigger language plpgsql set search_path = public as $$
declare k text; want text;
begin
  if new.category_id is not null then
    select kind into k from public.categories where id = new.category_id;
    want := new.type;
    if new.is_offset is true and new.type in ('expense', 'income') then
      want := case new.type when 'expense' then 'income' else 'expense' end;
    end if;
    if k <> want then raise exception '分类类型(%)与流水类型(%)不匹配', k, new.type; end if;
  end if;
  return new;
end $$;
