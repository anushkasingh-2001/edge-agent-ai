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
  resetPassword,
  sendVerificationEmail,
  verifyEmail,
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

type Mode = "login" | "register" | "forgot" | "reset"

export function AccountAuthDialog({ open, onOpenChange, onAuthChanged }: Props) {
  const [mode, setMode] = useState<Mode>("login")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [name, setName] = useState("")
  const [resetToken, setResetToken] = useState("")
  const [verifyTokenInput, setVerifyTokenInput] = useState("")
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
        setError(res.error ?? "Could not send verification email.")
        return
      }
      if (res.verificationToken) {
        // Dev/desktop: no email transport, so prefill the token to verify now.
        setVerifyTokenInput(res.verificationToken)
        setInfo("Verification token generated. Click Verify to confirm your email.")
      } else {
        setInfo("Verification email sent. Check your inbox.")
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleVerifyEmail = async () => {
    const token = verifyTokenInput.trim()
    if (!token) {
      setError("Paste the verification token from your email.")
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await verifyEmail(token)
      if (!res.ok) {
        setError(res.error ?? "Verification failed.")
        return
      }
      toast.success("Email verified.")
      setVerifyTokenInput("")
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

  const handleSubmit = async () => {
    const e = email.trim()
    if (!e || !password) {
      setError("Enter your email and password.")
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const result =
        mode === "register"
          ? await registerAccount({ email: e, password, name: name.trim() || undefined })
          : await loginAccount({ email: e, password })
      if (result.ok) {
        toast.success(
          mode === "register"
            ? `Welcome, ${result.user.email}.`
            : `Signed in as ${result.user.email}.`,
        )
        setPassword("")
        if (mode === "register" && result.user.emailVerified === false) {
          setInfo("Check your email to verify your account.")
        }
        await refresh()
        onAuthChanged?.()
      } else {
        setError(result.error)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.")
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
                    : "Sign in to Edge Agent AI"}
          </DialogTitle>
          <DialogDescription>
            {isAuthed
              ? "Your account owns your plan and credits. Connect GitHub separately for repo/PR access."
              : mode === "forgot"
                ? "Enter your account email and we'll send a password reset link."
                : mode === "reset"
                  ? "Enter the reset token from your email and a new password."
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
                    Check your email to verify your account. Verifying unlocks paid plans and AI
                    modes beyond the free tier.
                  </span>
                </div>
                <Input
                  value={verifyTokenInput}
                  onChange={(e) => setVerifyTokenInput(e.target.value)}
                  placeholder="Paste verification token (from the email link)"
                  disabled={submitting}
                  className="h-8 text-xs"
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleResendVerification}
                    disabled={submitting}
                  >
                    Resend verification email
                  </Button>
                  <Button size="sm" onClick={handleVerifyEmail} disabled={submitting || !verifyTokenInput}>
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
