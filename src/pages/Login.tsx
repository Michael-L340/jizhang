import { type FormEvent, useState } from 'react'
import { configured, friendlyError } from '../lib/api'
import { useStore } from '../lib/store'

export function Login() {
  const signIn = useStore((s) => s.signIn)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setErr('')
    setBusy(true)
    try {
      await signIn(email.trim(), password)
    } catch (ex) {
      setErr(friendlyError(ex))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col safe-top">
      <div className="app-main flex flex-col justify-center px-8">
        <div className="text-3xl font-bold mb-1">记账</div>
        <div className="text-muted text-sm mb-8">只给自己用的账本</div>
        {!configured ? (
          <div className="card p-4 text-sm text-expense">尚未配置数据库地址（VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY）。</div>
        ) : (
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <input
              className="card px-4 py-3"
              type="email"
              inputMode="email"
              autoComplete="username"
              placeholder="邮箱"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <input
              className="card px-4 py-3"
              type="password"
              autoComplete="current-password"
              placeholder="密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {err ? <div className="text-sm text-expense px-1">{err}</div> : null}
            <button type="submit" disabled={busy} className="rounded-2xl bg-brand text-white py-3 font-semibold disabled:opacity-50">
              {busy ? '登录中…' : '登录'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
