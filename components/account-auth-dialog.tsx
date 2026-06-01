"use client"

/**
 * AccountAuthDialog — Edge Agent AI account sign up / sign in.
 *
 * This is the product's identity of record: the account owns the
 * subscription, credits, and Stripe customer. On success we store the signed
 * session JWT via setCloudAuthToken() (handled inside loginAccount /
 * registerAccount), so every subsequent cloud call carries it as a Bearer.
 *
 * GitHub is a SEPARATE, optional integration (see GithubLoginDialog) and does
 * not appear here.
 *
 * SECURITY: the password is sent over the wire to the cloud auth route and
 * never stored in the browser. No provider API key is involved anywhere.
 */

import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { AlertTriangle, CheckCircle2, Eye, EyeOff, Loader2, LogOut, Mail, UserPlus } from "lucide-react"
import { toast } from "sonner"
import {
  fetchAccount,
  forgotPassword,
  loginAccount,
  logoutAccount,
  logoutAllAccount,
  registerAccount,
  resendVerification,
  resetPassword,
  sendVerificationEmail,
  verifyEmailCode,
  isBillingMockClient,
  DEMO_BILLING_LABEL,
  type AccountPlan,
  type AccountUser,
} from "@/lib/plan-client"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called whenever the account state changes (login/register/logout) so the
   *  parent can refresh badges, plan summary, etc. */
  onAuthChanged?: () => void
}

type Mode = "login" | "register" | "forgot" | "reset" | "verify"

interface PendingVerify {
  email: string
  /** Demo-only (undeliverable email): pre-fills the OTP code so it's testable. */
  code?: string
}

export function AccountAuthDialog({ open, onOpenChange, onAuthChanged }: Props) {
  const [mode, setMode] = useState<Mode>("login")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [name, setName] = useState("")
  const [resetToken, setResetToken] = useState("")
  const [verifyCodeInput, setVerifyCodeInput] = useState("")
  const [pendingVerify, setPendingVerify] = useState<PendingVerify | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const [account, setAccount] = useState<{ user: AccountUser; plan: AccountPlan | null } | null>(
    null,
  )
  const [loadingAccount, setLoadingAccount] = useState(false)

  const refresh = async () => {
    setLoadingAccount(true)
    try {
      setAccount(await fetchAccount())
    } catch {
      setAccount(null)
    } finally {
      setLoadingAccount(false)
    }
  }

  useEffect(() => {
    if (open) {
      setError(null)
      setInfo(null)
      setPassword("")
      setShowPassword(false)
      setMode("login")
      setPendingVerify(null)
      void refresh()
    }
  }, [open])

  // --- email verification (signed-in) --------------------------------- //
  const handleResendVerification = async () => {
    setSubmitting(true)
    setError(null)
    try {
      const res = await sendVerificationEmail()
      if (!res.ok) {
        setError(res.error ?? "Could not send verification code.")
        return
      }
      if (res.verificationCode) {
        // Dev/desktop: no email transport, so prefill the code to verify now.
        setVerifyCodeInput(res.verificationCode)
        setInfo("Verification code generated. Enter it and click Verify.")
      } else {
        setInfo("Verification code emailed. Check your inbox.")
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleVerifyEmail = async () => {
    const code = verifyCodeInput.replace(/\D/g, "")
    if (code.length !== 6) {
      setError("Enter the 6-digit code from your email.")
      return
    }
    const addr = account?.user.email
    if (!addr) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await verifyEmailCode(addr, code)
      if (!res.ok) {
        setError(res.error ?? "That code is invalid or has expired.")
        return
      }
      toast.success("Email verified.")
      setVerifyCodeInput("")
      setInfo(null)
      await refresh()
      onAuthChanged?.()
    } finally {
      setSubmitting(false)
    }
  }

  // --- forgot / reset password ---------------------------------------- //
  const handleForgot = async () => {
    const e = email.trim()
    if (!e) {
      setError("Enter the email for your account.")
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await forgotPassword(e)
      if (res.resetToken) {
        // Dev/desktop: surface the token and jump straight to reset.
        setResetToken(res.resetToken)
        setMode("reset")
        setInfo("Reset token generated. Enter a new password below.")
      } else {
        setInfo(res.message ?? "If an account exists for that email, a reset link was sent.")
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleReset = async () => {
    const token = resetToken.trim()
    if (!token || !password) {
      setError("Enter the reset token and a new password.")
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await resetPassword(token, password)
      if (!res.ok) {
        setError(res.error ?? "Could not reset password.")
        return
      }
      toast.success("Password updated. Sign in with your new password.")
      setPassword("")
      setResetToken("")
      setInfo(null)
      setMode("login")
    } finally {
      setSubmitting(false)
    }
  }

  const enterVerifyStep = (verifyEmailAddr: string, code?: string) => {
    setPendingVerify({ email: verifyEmailAddr, code })
    setVerifyCodeInput(code ?? "")
    setMode("verify")
    setPassword("")
    setError(null)
    setInfo(`We emailed a 6-digit code to ${verifyEmailAddr}. Enter it to finish signing in.`)
  }

  const handleSubmit = async () => {
    const e = email.trim()
    if (!e || !password) {
      setError("Enter your email and password.")
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      if (mode === "register") {
        const result = await registerAccount({ email: e, password, name: name.trim() || undefined })
        if (result.ok && "requiresVerification" in result && result.requiresVerification) {
          enterVerifyStep(result.email, result.verificationCode)
          return
        }
        if (result.ok) {
          toast.success(`Welcome, ${result.user.email}.`)
          setPassword("")
          await refresh()
          onAuthChanged?.()
          return
        }
        setError(result.error)
        return
      }

      // mode === "login"
      const result = await loginAccount({ email: e, password })
      if (result.ok) {
        toast.success(`Signed in as ${result.user.email}.`)
        setPassword("")
        await refresh()
        onAuthChanged?.()
        return
      }
      if (result.code === "email_not_verified") {
        enterVerifyStep(result.email ?? e, result.verificationCode)
        return
      }
      setError(result.error)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.")
    } finally {
      setSubmitting(false)
    }
  }

  // --- pre-login email verification (account exists but unverified) ------- //
  const handleVerifyNow = async () => {
    if (!pendingVerify) return
    const code = verifyCodeInput.replace(/\D/g, "")
    if (code.length !== 6) {
      setError("Enter the 6-digit code from your email.")
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await verifyEmailCode(pendingVerify.email, code)
      if (!res.ok) {
        setError(res.error ?? "That code is invalid or has expired.")
        return
      }
      toast.success("Email verified.")
      setPendingVerify(null)
      setVerifyCodeInput("")
      setMode("login")
      setInfo(null)
      await refresh()
      onAuthChanged?.()
    } finally {
      setSubmitting(false)
    }
  }

  const handleResendPending = async () => {
    if (!pendingVerify) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await resendVerification(pendingVerify.email)
      if (res.ok) {
        if (res.verificationCode) {
          setPendingVerify({ email: pendingVerify.email, code: res.verificationCode })
          setVerifyCodeInput(res.verificationCode)
        }
        setInfo("A new code was sent. Check your inbox.")
      } else {
        setError(res.error ?? "Could not resend the code.")
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleSignOut = async () => {
    setSubmitting(true)
    try {
      await logoutAccount()
      setAccount(null)
      toast.success("Signed out.")
      onAuthChanged?.()
    } finally {
      setSubmitting(false)
    }
  }

  const handleSignOutAll = async () => {
    setSubmitting(true)
    try {
      await logoutAllAccount()
      setAccount(null)
      toast.success("Signed out of all devices.")
      onAuthChanged?.()
    } finally {
      setSubmitting(false)
    }
  }

  const isAuthed = !!account?.user

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            {isAuthed
              ? "Edge Agent AI account"
              : mode === "register"
                ? "Create your Edge Agent AI account"
                : mode === "forgot"
                  ? "Reset your password"
                  : mode === "reset"
                    ? "Choose a new password"
                    : mode === "verify"
                      ? "Verify your email"
                      : "Sign in to Edge Agent AI"}
          </DialogTitle>
          <DialogDescription>
            {isAuthed
              ? "Your account owns your plan and credits. Connect GitHub separately for repo/PR access."
              : mode === "forgot"
                ? "Enter your account email and we'll send a password reset link."
                : mode === "reset"
                  ? "Enter the reset token from your email and a new password."
                  : mode === "verify"
                    ? "Enter the 6-digit code we emailed you to finish signing in."
                    : "Your Edge Agent AI account is your identity for hosted AI, your plan, and your credits."}
          </DialogDescription>
        </DialogHeader>

        {loadingAccount && !account ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking your session…
          </div>
        ) : isAuthed ? (
          /* ---------------------- Signed-in view ---------------------- */
          <div className="space-y-3">
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm text-emerald-300 flex items-start gap-2">
              <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
              <div className="space-y-1">
                <div className="font-medium">{account!.user.email}</div>
                {account!.user.name && (
                  <div className="text-xs opacity-90">{account!.user.name}</div>
                )}
              </div>
            </div>

            {account!.user.emailVerified === false && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-300 space-y-2">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>
                    Enter the code we emailed you to verify your account. Verifying unlocks paid
                    plans and AI modes beyond the free tier.
                  </span>
                </div>
                <Input
                  value={verifyCodeInput}
                  onChange={(e) => setVerifyCodeInput(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="6-digit code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  disabled={submitting}
                  className="h-8 text-xs text-center tracking-[0.3em] font-mono"
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleResendVerification}
                    disabled={submitting}
                  >
                    Resend code
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleVerifyEmail}
                    disabled={submitting || verifyCodeInput.replace(/\D/g, "").length !== 6}
                  >
                    Verify
                  </Button>
                </div>
              </div>
            )}

            {info && (
              <div className="rounded-md border border-sky-500/40 bg-sky-500/5 p-2 text-xs text-sky-300">
                {info}
              </div>
            )}
            {error && (
              <div className="rounded-md border border-red-500/40 bg-red-500/5 p-2 text-xs text-red-300">
                {error}
              </div>
            )}
            <div className="rounded-md border border-border bg-secondary/10 p-3 text-xs space-y-1.5">
              {isBillingMockClient() && (
                <p className="text-amber-200/90 pb-1">{DEMO_BILLING_LABEL}</p>
              )}
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Plan</span>
                <Badge variant="outline" className="capitalize">
                  {account!.plan?.tier ?? "free"}
                </Badge>
              </div>
              {account!.plan && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Credits</span>
                  <span className="font-mono">
                    {Math.max(0, account!.plan.creditsLimit - account!.plan.creditsUsed)} /{" "}
                    {account!.plan.creditsLimit}
                  </span>
                </div>
              )}
            </div>
          </div>
        ) : mode === "verify" ? (
          /* ---------------------- Verify-email step ---------------------- */
          <div className="space-y-4">
            {pendingVerify?.code ? (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-200">
                <Mail className="h-4 w-4 mt-0.5 shrink-0" />
                <span>
                  We couldn&apos;t email the code (the demo sender only delivers to the Resend
                  account owner). Use this code &mdash; it&apos;s filled in below:{" "}
                  <strong className="font-mono tracking-widest">{pendingVerify.code}</strong>
                </span>
              </div>
            ) : (
              <div className="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm text-emerald-300">
                <Mail className="h-4 w-4 mt-0.5 shrink-0" />
                <span>
                  We emailed a 6-digit code to <strong>{pendingVerify?.email}</strong>. Enter it
                  below to verify and sign in. Didn&apos;t get it? Resend below.
                </span>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="acct-verify-code" className="text-sm">
                Verification code
              </Label>
              <Input
                id="acct-verify-code"
                value={verifyCodeInput}
                onChange={(e) => setVerifyCodeInput(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="123456"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                disabled={submitting}
                className="text-center text-lg tracking-[0.5em] font-mono"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleVerifyNow()
                }}
              />
            </div>
            <Button
              className="w-full"
              onClick={handleVerifyNow}
              disabled={submitting || verifyCodeInput.replace(/\D/g, "").length !== 6}
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              Verify &amp; continue
            </Button>
            {info && (
              <div className="rounded-md border border-sky-500/40 bg-sky-500/5 p-2 text-xs text-sky-300">
                {info}
              </div>
            )}
            {error && (
              <div className="rounded-md border border-red-500/40 bg-red-500/5 p-2 text-xs text-red-300">
                {error}
              </div>
            )}
          </div>
        ) : (
          /* ---------------------- Auth form ---------------------- */
          <div className="space-y-4">
            {mode === "register" && (
              <div className="space-y-1.5">
                <Label htmlFor="acct-name" className="text-sm">
                  Name (optional)
                </Label>
                <Input
                  id="acct-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ada Lovelace"
                  disabled={submitting}
                  autoComplete="name"
                />
              </div>
            )}

            {mode === "reset" ? (
              <div className="space-y-1.5">
                <Label htmlFor="acct-reset-token" className="text-sm">
                  Reset token
                </Label>
                <Input
                  id="acct-reset-token"
                  value={resetToken}
                  onChange={(e) => setResetToken(e.target.value)}
                  placeholder="Paste the token from your email"
                  disabled={submitting}
                />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="acct-email" className="text-sm">
                  Email
                </Label>
                <Input
                  id="acct-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  disabled={submitting}
                  autoComplete="email"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && mode === "forgot") void handleForgot()
                  }}
                />
              </div>
            )}

            {mode !== "forgot" && (
              <div className="space-y-1.5">
                <Label htmlFor="acct-password" className="text-sm">
                  {mode === "reset" ? "New password" : "Password"}
                </Label>
                <div className="relative">
                  <Input
                    id="acct-password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={
                      mode === "login" ? "Your password" : "At least 8 characters"
                    }
                    disabled={submitting}
                    autoComplete={mode === "login" ? "current-password" : "new-password"}
                    className="pr-10"
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return
                      if (mode === "reset") void handleReset()
                      else void handleSubmit()
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
            )}

            {info && (
              <div className="rounded-md border border-sky-500/40 bg-sky-500/5 p-2 text-xs text-sky-300">
                {info}
              </div>
            )}
            {error && (
              <div className="rounded-md border border-red-500/40 bg-red-500/5 p-2 text-xs text-red-300">
                {error}
              </div>
            )}

            <div className="flex items-center justify-between">
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setError(null)
                  setInfo(null)
                  if (mode === "forgot" || mode === "reset") setMode("login")
                  else setMode((m) => (m === "login" ? "register" : "login"))
                }}
                disabled={submitting}
              >
                {mode === "login"
                  ? "Need an account? Create one"
                  : mode === "register"
                    ? "Already have an account? Sign in"
                    : "Back to sign in"}
              </button>
              {mode === "login" && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setError(null)
                    setInfo(null)
                    setMode("forgot")
                  }}
                  disabled={submitting}
                >
                  Forgot password?
                </button>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          {isAuthed ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
                Close
              </Button>
              <Button variant="outline" onClick={handleSignOutAll} disabled={submitting}>
                Sign out all devices
              </Button>
              <Button variant="destructive" onClick={handleSignOut} disabled={submitting}>
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <LogOut className="h-4 w-4" />
                )}
                Sign out
              </Button>
            </>
          ) : mode === "verify" ? (
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setPendingVerify(null)
                  setVerifyCodeInput("")
                  setMode("login")
                  setError(null)
                  setInfo(null)
                }}
                disabled={submitting}
              >
                Back to sign in
              </Button>
              <Button variant="outline" onClick={handleResendPending} disabled={submitting}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                Resend code
              </Button>
            </>
          ) : mode === "forgot" ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button onClick={handleForgot} disabled={submitting || !email}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                Send reset link
              </Button>
            </>
          ) : mode === "reset" ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button onClick={handleReset} disabled={submitting || !resetToken || !password}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                Reset password
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button onClick={handleSubmit} disabled={submitting || !email || !password}>
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {mode === "register" ? "Creating…" : "Signing in…"}
                  </>
                ) : (
                  <>
                    {mode === "register" ? (
                      <UserPlus className="h-4 w-4" />
                    ) : (
                      <Mail className="h-4 w-4" />
                    )}
                    {mode === "register" ? "Create account" : "Sign in"}
                  </>
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
