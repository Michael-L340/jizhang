-- 分类含义说明（来自用户 Excel 的口径定义），可在设置页修改
alter table public.categories add column if not exists note text;

update public.categories c set note = v.note
from (values
  ('日常餐饮',        '正常校园吃饭消费'),
  ('娱乐消费',        '娱乐餐饮消费、游戏充钱'),
  ('经常生活开支',    '通勤、水电、房租'),
  ('非经常生活消费',  '如买礼物送人、买衣服'),
  ('意外开支',        '其他')
) as v(name, note)
where c.kind = 'expense' and c.parent_id is null and c.name = v.name and c.note is null;
