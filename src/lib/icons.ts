// 二级分类的图标。
//
// 流水行以前显示的是一级分类的图标，所以「日常开支 · 午餐」「日常开支 · 早餐」
// 「日常开支 · 通勤交通」连着几行长得一模一样，扫一眼分不出谁是谁。
//
// 二级分类的 icon 字段数据库里本来就有，只是没给设置入口。现在补上了入口；
// 但让用户手动设三十个太累，所以先按名字猜一个。猜中了直接用，猜不中再退回一级的图标。
// 用关键词而不是全名匹配：改名成「午饭」「早饭」照样认得出。

const BY_NAME: { test: (n: string) => boolean; icon: string }[] = [
  // 吃喝
  { test: (n) => n.includes('早'), icon: '🥐' },
  { test: (n) => n.includes('午'), icon: '🍚' },
  { test: (n) => n.includes('晚'), icon: '🍜' },
  { test: (n) => n.includes('夜宵') || n.includes('宵夜'), icon: '🍢' },
  { test: (n) => n.includes('咖啡') || n.includes('奶茶') || n.includes('饮'), icon: '☕' },
  { test: (n) => n.includes('零食') || n.includes('水果'), icon: '🍎' },
  { test: (n) => n.includes('聚餐') || n.includes('下馆子') || n.includes('外卖'), icon: '🍽️' },
  // 娱乐
  { test: (n) => n.includes('游戏'), icon: '🎮' },
  { test: (n) => n.includes('影音') || n.includes('会员') || n.includes('订阅'), icon: '🎬' },
  { test: (n) => n.includes('电影') || n.includes('演出'), icon: '🎫' },
  { test: (n) => n.includes('旅行') || n.includes('出游') || n.includes('机票'), icon: '✈️' },
  { test: (n) => n.includes('运动') || n.includes('健身'), icon: '🏀' },
  // 居住出行
  { test: (n) => n.includes('房租') || n.includes('租房'), icon: '🏠' },
  { test: (n) => n.includes('水电') || n.includes('燃气') || n.includes('电费'), icon: '💡' },
  { test: (n) => n.includes('通勤') || n.includes('交通') || n.includes('打车') || n.includes('地铁'), icon: '🚇' },
  { test: (n) => n.includes('话费') || n.includes('网费') || n.includes('宽带'), icon: '📶' },
  { test: (n) => n.includes('日用') || n.includes('百货') || n.includes('超市'), icon: '🧺' },
  { test: (n) => n.includes('洗衣') || n.includes('理发'), icon: '✂️' },
  // 购买
  { test: (n) => n.includes('服饰') || n.includes('鞋') || n.includes('衣'), icon: '👕' },
  { test: (n) => n.includes('数码') || n.includes('电器'), icon: '💻' },
  { test: (n) => n.includes('礼物') || n.includes('人情') || n.includes('红包'), icon: '🎁' },
  { test: (n) => n.includes('学习') || n.includes('充电') || n.includes('书'), icon: '📚' },
  { test: (n) => n.includes('医疗') || n.includes('健康') || n.includes('药'), icon: '💊' },
  { test: (n) => n.includes('家居') || n.includes('家装'), icon: '🛋️' },
  // 意外
  { test: (n) => n.includes('罚款') || n.includes('赔偿'), icon: '⚡' },
  { test: (n) => n.includes('维修') || n.includes('损坏'), icon: '🔧' },
  { test: (n) => n.includes('手续费') || n.includes('利息'), icon: '🏦' },
  { test: (n) => n.includes('代付') || n.includes('垫付'), icon: '🤝' },
  // 收入
  { test: (n) => n.includes('工资') || n.includes('实习'), icon: '💼' },
  { test: (n) => n.includes('生活费'), icon: '🧧' },
  { test: (n) => n.includes('奖学金'), icon: '🎓' },
  { test: (n) => n.includes('理财'), icon: '📈' },
  { test: (n) => n.includes('退款'), icon: '↩️' },
]

/** 猜测规则里用到的全部图标。它们必须都在下面的 ICON_GROUPS 里，否则用户想改回去时找不到 */
export const GUESSED_ICONS: readonly string[] = [...new Set(BY_NAME.map((r) => r.icon))]

/** 按分类名猜一个图标；猜不出返回 null */
export function guessIcon(name: string): string | null {
  for (const r of BY_NAME) if (r.test(name)) return r.icon
  return null
}

/**
 * 图标库。分组是为了能找得到——一大片没有分隔的 emoji 反而挑不出来。
 * 分类管理页的「换图标」面板直接渲染这个结构；弹层本身是可滚动的（max-h-86dvh）。
 * 只收在 iOS 上确定能正常显示的 emoji。
 */
export const ICON_GROUPS: { name: string; icons: string[] }[] = [
  { name: '主食餐饭', icons: ['🍚', '🍜', '🍲', '🍛', '🥘', '🍱', '🍙', '🍞', '🥐', '🥯', '🥞', '🧇', '🍳', '🥗', '🍔', '🍟', '🍕', '🌮', '🍢', '🍤', '🥟', '🍖', '🍽️'] },
  { name: '饮品甜点', icons: ['☕', '🍵', '🧋', '🥤', '🧃', '🥛', '🍺', '🍷', '🍸', '🍹', '🍰', '🧁', '🍦', '🍪', '🍫', '🍬'] },
  { name: '果蔬生鲜', icons: ['🍎', '🍌', '🍇', '🍓', '🍉', '🍊', '🥑', '🥕', '🌽', '🥦', '🥩', '🐟', '🥚', '🧀'] },
  { name: '娱乐运动', icons: ['🎮', '🕹️', '🎬', '🎫', '🎤', '🎧', '🎸', '🎹', '🎲', '🎯', '🎪', '🎨', '📺', '🎳', '🏀', '⚽', '🏸', '🎿', '🏊', '🚴', '🧗', '♟️'] },
  { name: '出行旅游', icons: ['🚇', '🚌', '🚗', '🚕', '🚲', '🛵', '✈️', '🚄', '🚢', '🗺️', '🧳', '🏨', '⛽', '🅿️', '🚦', '🛣️', '🏖️', '⛰️', '📶'] },
  { name: '居家日用', icons: ['🏠', '🛋️', '🛏️', '🚿', '🚽', '🧻', '🧺', '🧹', '🧽', '💡', '🔌', '🔋', '🚪', '🪑', '🧯', '🪣', '🧴', '🕯️', '🔥', '💧'] },
  { name: '购物穿戴', icons: ['🛒', '🛍️', '👕', '👖', '👟', '👗', '👜', '🧢', '🕶️', '💍', '⌚', '📱', '💻', '🖥️', '⌨️', '🖨️', '📷', '🎒'] },
  { name: '医疗学习', icons: ['💊', '🏥', '🩺', '🦷', '👓', '🧖', '💈', '💅', '✂️', '📚', '🎓', '✏️', '📝', '🔬', '🧪', '🩹'] },
  { name: '钱与账单', icons: ['💰', '💵', '💴', '💳', '🏦', '📈', '📉', '🧧', '🎁', '🤝', '🧾', '⚖️', '📮', '📦', '🏷️', '💼', '↩️'] },
  { name: '其他', icons: ['⚡', '🔧', '🐾', '🌱', '🌸', '☀️', '🌧️', '❄️', '🎂', '🎄', '🧸', '🔒', '📅', '⭐', '❤️', '🔔'] },
]
