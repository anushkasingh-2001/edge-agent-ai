"use client"

/**
 * /auth/reset-password?token=…  —  landing page for the reset email link.
 *
 * Reads the token from the query string and lets the user set a new password
 * via POST /api/auth/reset-password. Same-origin fetch (served by the hosted
 * web app at NEXT_PUBLIC_APP_URL). The token is never logged.
 */

import { Suspense, useState } from "react"
import { useSearchParams } from "next/navigation"

function ResetInner() {
  const params = useSearchParams()
  const token = params.get("token") ?? ""
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!token) {
      setError("This reset link is missing its token.")
      return
    }
    if (password.length < 8) {
      setError("Use at least 8 characters.")
      return
    }
    if (password !== confirm) {
      setError("Passwords don't match.")
      return
    }
    setBusy(true)
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      })
      const data = (await res.json()) as { ok?: boolean; error?: string }
      if (res.ok && data.ok) setDone(true)
      else setError(data.error ?? "This reset link is invalid or has expired.")
    } catch {
      setError("Could not reach the server. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <main style={wrap}>
      <div style={card}>
        <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Reset your password</h1>
        {done ? (
          <>
            <p style={{ color: "#047857" }}>
              Your password was reset. Please log in again with your new password.
            </p>
            <a href="/" style={link}>Go to Edge Agent AI</a>
          </>
        ) : (
          <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 10, textAlign: "left" }}>
            <label style={lbl}>New password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              style={input}
              autoComplete="new-password"
            />
            <label style={lbl}>Confirm password</label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Re-enter password"
              style={input}
              autoComplete="new-password"
            />
            {error && <p style={{ color: "#b91c1c", fontSize: 13 }}>{error}</p>}
            <button type="submit" disabled={busy} style={btn}>
              {busy ? "Resetting…" : "Reset password"}
            </button>
          </form>
        )}
      </div>
    </main>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<main style={wrap}><div style={card}>Loading…</div></main>}>
      <ResetInner />
    </Suspense>
  )
}

const wrap: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#0b0b0c",
  padding: 24,
}
const card: React.CSSProperties = {
  maxWidth: 420,
  width: "100%",
  background: "#fff",
  borderRadius: 12,
  padding: 28,
  textAlign: "center",
  boxShadow: "0 10px 30px rgba(0,0,0,.3)",
}
const lbl: React.CSSProperties = { fontSize: 13, color: "#374151", fontWeight: 500 }
const input: React.CSSProperties = {
  border: "1px solid #d1d5db",
  borderRadius: 8,
  padding: "8px 10px",
  fontSize: 14,
}
const btn: React.CSSProperties = {
  marginTop: 8,
  background: "#3b82f6",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  padding: "10px 14px",
  fontWeight: 600,
  cursor: "pointer",
}
const link: React.CSSProperties = {
  display: "inline-block",
  marginTop: 16,
  color: "#2563eb",
  textDecoration: "underline",
}
