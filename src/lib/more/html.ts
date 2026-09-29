/**
 * 提示框是 HTML：分类名、账户名、备注都是用户随手写的字，拼进去之前转义。
 * 分类叫「<Steam>游戏」不转义的话，提示框里只剩「游戏」——浏览器把 <Steam> 当标签吞了（2026-09-29 审出来的）。
 */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string)
}
