"use client"

/**
 * Onboarding / welcome gate.
 *
 * Shown on first load when the visitor has no session and hasn't yet
 * dismissed it. Paths:
 *
 *   1. Register with first/last name, email, and password → creates an
 *      Edge Agent AI account. In production the account must verify its email
 *      before it can enter the app (a "verify your email" step is shown).
 *   2. Skip → continue anonymously (only the deterministic "Lite" mode
 *      runs; AI modes are locked until they sign in).
 *   3. View plans → jump straight to Plan & Billing.
 */

import { useState } from "react"
import Image from "next/image"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2, XCircle, ArrowRight, CreditCard, Eye, EyeOff, MailCheck } from "lucide-react"
import { loginAccount, registerAccount, resendVerification, verifyEmailCode } from "@/lib/plan-client"

export interface OnboardingWelcomeProps {
  /** Continue anonymously. */
  onSkip: () => void
  /** Go to the Plan & Billing page (optionally after signing in). */
  onViewPlans: () => void
  /** A session was created — enter the app. */
  onSignedIn: () => void
}

const MIN_PASSWORD_LEN = 8

/** Verification step state: set when an account exists but isn't verified. */
interface PendingVerify {
  email: string
  /** Demo-only (undeliverable email): pre-fills the code so the flow is testable. */
  code?: string
}

export function OnboardingWelcome({ onSkip, onViewPlans, onSignedIn }: OnboardingWelcomeProps) {
  const [authMode, setAuthMode] = useState<"register" | "login">("register")
  const [email, setEmail] = useState("")
  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState<"continue" | "plans" | "verify" | "resend" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingVerify | null>(null)
  const [codeInput, setCodeInput] = useState("")

  /** Enter the verify-code step, pre-filling the code in demo mode. */
  const beginVerify = (p: PendingVerify) => {
    setPending(p)
    setCodeInput(p.code ?? "")
  }

  const trimmedEmail = email.trim().toLowerCase()
  const validEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmedEmail)
  // Registration enforces the password policy; sign-in only needs a non-empty
  // password (the existing one may predate the policy).
  const validPassword = authMode === "login" ? password.length > 0 : password.length >= MIN_PASSWORD_LEN

  /** Sign in to a verified account. */
  const signIn = async (): Promise<"signed-in" | "verify" | "error"> => {
    const login = await loginAccount({ email: trimmedEmail, password })
    if (login.ok) return "signed-in"
    if (login.code === "email_not_verified") {
      beginVerify({ email: login.email ?? trimmedEmail, code: login.verificationCode })
      return "verify"
    }
    setError(login.error ?? "Invalid email or password.")
    return "error"
  }

  /** Register, or sign in if the account already exists. Returns:
   *  - "signed-in"  → a session was issued (enter the app)
   *  - "verify"     → the email must be verified first (pending state set)
   *  - "error"      → failed (error state set) */
  const registerOrSignIn = async (): Promise<"signed-in" | "verify" | "error"> => {
    setError(null)
    if (!validEmail) {
      setError("Enter a valid email to continue.")
      return "error"
    }
    if (!validPassword) {
      setError(
        authMode === "login"
          ? "Enter your password."
          : `Password must be at least ${MIN_PASSWORD_LEN} characters.`,
      )
      return "error"
    }

    // Sign-in mode: authenticate an existing account only.
    if (authMode === "login") return signIn()

    // Register mode: create the account.
    const name = [firstName.trim(), lastName.trim()].filter(Boolean).join(" ") || undefined
    const register = await registerAccount({ email: trimmedEmail, password, name })

    if (register.ok && "requiresVerification" in register && register.requiresVerification) {
      beginVerify({ email: register.email, code: register.verificationCode })
      return "verify"
    }
    if (register.ok) return "signed-in"

    // The email already belongs to an account — don't silently sign them in;
    // tell them plainly and switch to the sign-in form so they can continue.
    if (register.code === "user_exists") {
      setAuthMode("login")
      setError("A user with this email already exists. Please sign in instead.")
      return "error"
    }

    setError(register.error)
    return "error"
  }

  const onContinue = async () => {
    setBusy("continue")
    const outcome = await registerOrSignIn()
    setBusy(null)
    if (outcome === "signed-in") onSignedIn()
  }

  const onPlans = async () => {
    if (validEmail && validPassword) {
      setBusy("plans")
      const outcome = await registerOrSignIn()
      setBusy(null)
      if (outcome === "verify") return // show verify step first
    }
    onViewPlans()
  }

  // --- verification step actions ------------------------------------------ //
  const codeDigits = codeInput.replace(/\D/g, "")
  const onVerifyCode = async () => {
    if (!pending || codeDigits.length !== 6) {
      setError("Enter the 6-digit code from your email.")
      return
    }
    setBusy("verify")
    setError(null)
    const res = await verifyEmailCode(pending.email, codeDigits)
    setBusy(null)
    if (res.ok) onSignedIn()
    else setError(res.error ?? "That code is invalid or has expired.")
  }

  const onResend = async () => {
    if (!pending) return
    setBusy("resend")
    setError(null)
    setInfo(null)
    const res = await resendVerification(pending.email)
    setBusy(null)
    if (res.ok) {
      if (res.verificationCode) {
        setPending({ email: pending.email, code: res.verificationCode })
        setCodeInput(res.verificationCode)
      }
      setInfo("A new code was sent. Check your inbox.")
    } else {
      setError(res.error ?? "Could not resend the code.")
    }
  }

  const header = (
    <CardHeader className="space-y-3">
      <div className="flex items-center gap-2">
        <Image
          src="https://hebbkx1anhila5yf.public.blob.vercel-storage.com/edge_agent_ai-2ZiMAJND6E8xlZHoIAaqyh3xFOwQv9.png"
          alt="Edge Agent AI"
          width={32}
          height={32}
          className="rounded"
        />
        <span className="font-semibold">Edge Agent AI</span>
      </div>
      <CardTitle className="text-xl">
        {pending ? "Verify your email" : authMode === "login" ? "Welcome back" : "Welcome"}
      </CardTitle>
      <CardDescription>
        {pending
          ? `We emailed a 6-digit code to ${pending.email}. Enter it below to finish.`
          : authMode === "login"
            ? "Sign in to your account to unlock AI analysis modes."
            : "Create your account to unlock AI analysis modes, or skip to run deterministic scans anonymously."}
      </CardDescription>
    </CardHeader>
  )

  // --- verification pending view ------------------------------------------ //
  if (pending) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <Card className="w-full max-w-md bg-card border-border">
          {header}
          <CardContent className="space-y-4">
            {pending.code ? (
              // Email couldn't be delivered (demo sender / no verified domain),
              // so the code is shown here and pre-filled below.
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/[0.06] p-3 text-sm text-amber-200">
                <MailCheck className="h-4 w-4 mt-0.5 shrink-0" />
                <span>
                  We couldn&apos;t email the code (the demo sender only delivers to the Resend
                  account owner). Use this code &mdash; it&apos;s filled in below:{" "}
                  <strong className="font-mono tracking-widest">{pending.code}</strong>
                </span>
              </div>
            ) : (
              <div className="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/[0.06] p-3 text-sm text-emerald-300">
                <MailCheck className="h-4 w-4 mt-0.5 shrink-0" />
                <span>
                  Check your inbox for the 6-digit code and enter it below. Didn&apos;t get it?
                  Resend below.
                </span>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="ob-code" className="text-xs">
                Verification code
              </Label>
              <Input
                id="ob-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="123456"
                disabled={busy !== null}
                className="text-center text-lg tracking-[0.5em] font-mono"
                maxLength={6}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void onVerifyCode()
                }}
              />
            </div>

            <Button
              className="w-full"
              disabled={busy !== null || codeDigits.length !== 6}
              onClick={onVerifyCode}
            >
              {busy === "verify" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  Verify &amp; continue <ArrowRight className="h-4 w-4 ml-1.5" />
                </>
              )}
            </Button>

            {info && (
              <div className="rounded-md border border-sky-500/40 bg-sky-500/[0.06] p-2 text-xs text-sky-300">
                {info}
              </div>
            )}
            {error && (
              <div className="flex items-center gap-2 text-xs text-red-400">
                <XCircle className="h-3.5 w-3.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex items-center justify-between gap-2 pt-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy !== null}
                onClick={() => {
                  setPending(null)
                  setCodeInput("")
                  setError(null)
                  setInfo(null)
                }}
              >
                Back
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={onResend}>
                {busy === "resend" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Resend code"
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  // --- registration form view --------------------------------------------- //
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md bg-card border-border">
        {header}
        <CardContent className="space-y-4">
          {authMode === "register" && (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ob-first" className="text-xs">
                First name
              </Label>
              <Input
                id="ob-first"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="Ada"
                disabled={busy !== null}
                autoComplete="given-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ob-last" className="text-xs">
                Last name
              </Label>
              <Input
                id="ob-last"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder="Lovelace"
                disabled={busy !== null}
                autoComplete="family-name"
              />
            </div>
          </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="ob-email" className="text-xs">
              Email
            </Label>
            <Input
              id="ob-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              disabled={busy !== null}
              autoComplete="email"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ob-password" className="text-xs">
              Password
            </Label>
            <div className="relative">
              <Input
                id="ob-password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={authMode === "login" ? "Your password" : `At least ${MIN_PASSWORD_LEN} characters`}
                disabled={busy !== null}
                autoComplete={authMode === "login" ? "current-password" : "new-password"}
                className="pr-10"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void onContinue()
                }}
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showPassword ? "Hide password" : "Show password"}
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 text-xs text-red-400">
              <XCircle className="h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <Button className="w-full" disabled={busy !== null} onClick={onContinue}>
            {busy === "continue" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                {authMode === "login" ? "Sign in" : "Create account"}{" "}
                <ArrowRight className="h-4 w-4 ml-1.5" />
              </>
            )}
          </Button>

          {/* Toggle between register and sign-in. */}
          <div className="text-center text-xs text-muted-foreground">
            {authMode === "login" ? (
              <>
                Need an account?{" "}
                <button
                  type="button"
                  className="text-foreground underline underline-offset-2 hover:opacity-80"
                  disabled={busy !== null}
                  onClick={() => {
                    setAuthMode("register")
                    setError(null)
                  }}
                >
                  Create one
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button
                  type="button"
                  className="text-foreground underline underline-offset-2 hover:opacity-80"
                  disabled={busy !== null}
                  onClick={() => {
                    setAuthMode("login")
                    setError(null)
                  }}
                >
                  Sign in
                </button>
              </>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={onSkip}>
              Skip for now
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={onPlans}>
              {busy === "plans" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <CreditCard className="h-4 w-4 mr-1.5" />
                  View plans
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
