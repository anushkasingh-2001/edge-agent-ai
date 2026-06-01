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
import { verifyEmail } from "@/lib/plan-client"

type State = "working" | "ok" | "error"

// Seconds to show the success message before redirecting into the app.
const REDIRECT_DELAY_MS = 1500

function VerifyInner() {
  const params = useSearchParams()
  const token = params.get("token") ?? ""
  const [state, setState] = useState<State>("working")
  const [message, setMessage] = useState("Verifying your email…")

  useEffect(() => {
    let cancelled = false
    let redirectTimer: ReturnType<typeof setTimeout> | undefined
    async function run() {
      if (!token) {
        setState("error")
        setMessage("This verification link is missing its token.")
        return
      }
      // verifyEmail() confirms the token AND stores the session the server
      // issues on success (access + refresh token), so the app is signed in.
      const res = await verifyEmail(token)
      if (cancelled) return
      if (res.ok) {
        setState("ok")
        setMessage("Your email is verified. Taking you to Edge Agent AI…")
        // Mark onboarding complete so the app loads straight into the
        // authenticated experience instead of the welcome gate.
        try {
          window.localStorage.setItem("edge-agent-ai.onboarded", "1")
        } catch {
          /* best-effort */
        }
        // Auto-redirect into the app, now authenticated.
        redirectTimer = setTimeout(() => {
          window.location.assign("/")
        }, REDIRECT_DELAY_MS)
      } else {
        setState("error")
        setMessage(res.error ?? "This verification link is invalid or has expired.")
      }
    }
    void run()
    return () => {
      cancelled = true
      if (redirectTimer) clearTimeout(redirectTimer)
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
            {state === "ok" ? "Continue to Edge Agent AI" : "Go to Edge Agent AI"}
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
