// 记账助手的服务端（Supabase Edge Function，Deno）。只做一件事：确认是你本人登录着，带上 DeepSeek 密钥转发。
// 账本不经过这里（App 在手机上算好，只发问题和算好的数）。
//
// 部署前要在 Supabase 后台 Edge Functions → Secrets 设好：
//   DEEPSEEK_API_KEY  （必填，只在这里读；绝不写进任何文件）
//   ALLOWED_USER_ID   （选填：只允许这个用户 id 调用；不设就允许本项目任何登录用户——注册是关着的，只有你）
// 网关默认 verify_jwt = true：没登录、过期、拿公开 anon key 来的请求到不了这里。
//
// 模型、参数、输出上限都写死在这里，调用方改不了（防止被当成通用的大模型接口刷钱）。

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'
const MODEL = 'deepseek-flash' // deepseek-chat 已于 2026-07-24 退役
const STAGES = {
  intent: { max_tokens: 1200, temperature: 0.2 },
  analysis: { max_tokens: 1600, temperature: 0.4 },
} as const
const MAX_BODY_BYTES = 96 * 1024
const MAX_MESSAGES = 30
const MAX_CONTENT_CHARS = 40000
const UPSTREAM_TIMEOUT_MS = 25000

/** GitHub Pages 上的 App，和本地开发（电脑本机、同一 WiFi 下的手机） */
function allowOrigin(origin: string | null): string | null {
  if (!origin) return null
  if (origin === 'https://michael-l340.github.io') return origin
  if (/^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d{2,5})?$/.test(origin)) return origin
  return null
}

function json(status: number, body: unknown, origin: string | null): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' }
  if (origin) headers['Access-Control-Allow-Origin'] = origin
  return new Response(JSON.stringify(body), { status, headers })
}

/** 网关已经验过签名，这里只读出是谁（sub）和角色 */
function claims(req: Request): { sub?: string; role?: string } | null {
  const auth = req.headers.get('Authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const pad = part.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((part.length + 3) % 4)
    return JSON.parse(atob(pad))
  } catch {
    return null
  }
}

Deno.serve(async (req) => {
  const origin = allowOrigin(req.headers.get('Origin'))
  if (req.method === 'OPTIONS') {
    if (!origin) return new Response(null, { status: 403 })
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      },
    })
  }
  if (req.method !== 'POST') return json(405, { error: 'method' }, origin)

  // 只认登录用户（anon key 的 role 是 anon、没有 sub），可选地只认一个人
  const c = claims(req)
  if (!c || c.role !== 'authenticated' || !c.sub) return json(401, { error: 'auth' }, origin)
  const allowed = Deno.env.get('ALLOWED_USER_ID')
  if (allowed && c.sub !== allowed) return json(403, { error: 'auth' }, origin)

  const key = Deno.env.get('DEEPSEEK_API_KEY')
  if (!key) return json(500, { error: 'not_configured' }, origin)

  // 请求体：真正读到的字节数说了算，不信 Content-Length
  const raw = new Uint8Array(await req.arrayBuffer())
  if (raw.byteLength > MAX_BODY_BYTES) return json(413, { error: 'too_large' }, origin)
  let body: { stage?: unknown; messages?: unknown }
  try {
    body = JSON.parse(new TextDecoder().decode(raw))
  } catch {
    return json(400, { error: 'bad_json' }, origin)
  }
  const stage = body.stage === 'analysis' ? 'analysis' : body.stage === 'intent' ? 'intent' : null
  if (!stage) return json(400, { error: 'bad_stage' }, origin)
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > MAX_MESSAGES) return json(400, { error: 'bad_messages' }, origin)
  const messages: { role: string; content: string }[] = []
  for (const m of body.messages) {
    const role = (m as { role?: unknown })?.role
    const content = (m as { content?: unknown })?.content
    if ((role !== 'system' && role !== 'user' && role !== 'assistant') || typeof content !== 'string' || !content || content.length > MAX_CONTENT_CHARS) return json(400, { error: 'bad_messages' }, origin)
    messages.push({ role, content })
  }

  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS)
  const t0 = Date.now()
  try {
    const r = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        messages,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        ...STAGES[stage],
      }),
    })
    if (!r.ok) {
      console.log(JSON.stringify({ stage, upstream: r.status, ms: Date.now() - t0 }))
      // 402 = DeepSeek 余额不足，429 = 限流：都告诉 App「暂时用不了」
      return json(r.status === 402 || r.status === 429 ? r.status : 502, { error: 'upstream' }, origin)
    }
    const d = await r.json()
    const choice = d?.choices?.[0]
    console.log(JSON.stringify({ stage, ok: true, ms: Date.now() - t0, usage: d?.usage ?? null, finish: choice?.finish_reason ?? null }))
    return json(200, { content: typeof choice?.message?.content === 'string' ? choice.message.content : '', finish: choice?.finish_reason ?? '' }, origin)
  } catch {
    console.log(JSON.stringify({ stage, timeout: ctl.signal.aborted, ms: Date.now() - t0 }))
    return json(ctl.signal.aborted ? 504 : 502, { error: 'upstream' }, origin)
  } finally {
    clearTimeout(timer)
  }
})
