// Supabase 客户端单例。除 api.ts 外，任何文件都不允许 import 这个模块。
import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

/** 环境变量是否已配置；未配置时登录页会给出提示而不是白屏 */
export const configured = Boolean(url && key)

export const supabase = createClient(url || 'https://placeholder.supabase.co', key || 'placeholder', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // 我们用 HashRouter，且不用 OAuth / 魔法链接，关掉 URL 解析避免和路由打架
    detectSessionInUrl: false,
  },
})
