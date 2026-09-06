-- 白条分期：这笔支出分几期还。只对白条账户上的支出有意义。
-- null = 不是白条上的支出，或按 1 期算（下个月一次还清）；第 k 期在下单月之后第 k 个月到期。
-- 还款本身不预排流水，仍由用户记转账；这一列只用来算「本月应还」和「还剩几期」。
alter table public.transactions add column if not exists installments smallint
  check (installments is null or installments between 1 and 60);
