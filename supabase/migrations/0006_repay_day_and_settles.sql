-- 白条的两处补齐。
--
-- 1) accounts.repay_day —— 这个白条每月几号还款。
--    到期日 = 下单日之后最近的那个还款日。京东白条是 17 号，所以 9/6 下单 → 9/17 到期；
--    花呗和美团月付是 1 号，9/6 下单 → 10/1 到期。正好在还款日当天下单算下一个月的。
--    0005 里写的「第 k 期在下单月之后第 k 个月」是写死的规则，四个平台各不相同，
--    所以改成一个账户存一个数字；分期第 k 期 = 第一期往后推 k−1 个月。
--    null = 没有固定还款日（拼多多先用后付逐笔扣款），未结清的一律算进本月应还。
--    允许到 31：遇到短月由代码落到当月最后一天，不在这里限制成 28。
alter table public.accounts add column if not exists repay_day smallint
  check (repay_day is null or repay_day between 1 and 31);

-- 2) transactions.settles —— 这笔还款/扣款结清了哪几单，存被结清的支出 id。
--    只对「转进白条账户」的转账有意义。挂在还款这一侧而不是在支出上打标记，
--    是为了让一次还款只写一条记录（不会出现「转账记下了、标记没打上」的半成品），
--    而且删掉这笔还款时结清关系跟着一起消失，不用另外去清。
--    只对「一次还清」的订单用；分期订单按账单走，不参与勾选。
--    不加外键：指向已删除订单的 id 由显示层忽略即可，加了外键反而会挡住删除。
alter table public.transactions add column if not exists settles uuid[];

-- 现有四个白条账户的还款日。名字对不上就什么都不做，不报错。
update public.accounts set repay_day = 17 where kind = 'credit' and name = '京东白条' and repay_day is null;
update public.accounts set repay_day = 1  where kind = 'credit' and name in ('花呗', '美团月付') and repay_day is null;
