"use client"

/**
 * /auth/verify-email?token=…  —  landing page for the verification email link.
 *
 * Reads the token from the query string and confirms it against
 * POST /api/auth/verify-email. Same-origin fetch (this page is served by the
 * hosted web app at NEXT_PUBLIC_APP_URL). The token is never logged.
 */

import { Suspense, useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"

type State = "working" | "ok" | "error"

function VerifyInner() {
  const params = useSearchParams()
  const token = params.get("token") ?? ""
  const [state, setState] = useState<State>("working")
  const [message, setMessage] = useState("Verifying your email…")

  useEffect(() => {
    let cancelled = false
    async function run() {
      if (!token) {
        setState("error")
        setMessage("This verification link is missing its token.")
        return
      }
      try {
        const res = await fetch("/api/auth/verify-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        })
        const data = (await res.json()) as { ok?: boolean; error?: string }
        if (cancelled) return
        if (res.ok && data.ok) {
          setState("ok")
          setMessage("Your email is verified. You can return to the app and sign in.")
        } else {
          setState("error")
          setMessage(data.error ?? "This verification link is invalid or has expired.")
        }
      } catch {
        if (!cancelled) {
          setState("error")
          setMessage("Could not reach the server. Please try again.")
        }
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [token])

  return (
    <main style={wrap}>
      <div style={card}>
        <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Edge Agent AI</h1>
        <p style={{ color: state === "error" ? "#b91c1c" : state === "ok" ? "#047857" : "#374151" }}>
          {message}
        </p>
        {state !== "working" && (
          <a href="/" style={link}>
            Go to Edge Agent AI
          </a>
        )}
      </div>
    </main>
  )
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<main style={wrap}><div style={card}>Loading…</div></main>}>
      <VerifyInner />
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
const link: React.CSSProperties = {
  display: "inline-block",
  marginTop: 16,
  color: "#2563eb",
  textDecoration: "underline",
}
