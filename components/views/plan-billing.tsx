"use client"

/**
 * Plan & Billing view.
 *
 * Demo flow: the user enters an email and selects a plan; we establish a
 * session for that email (`/api/auth/dev-login`) and persist the chosen
 * plan to the server billing store (`/api/billing/dev-checkout`). With
 * `DATABASE_URL` set that store is the Neon Postgres database, so the
 * email + subscription land in the cloud — no real payment, no card.
 *
 * Requires the server to run with `BILLING_MOCK=1` and the client flag
 * `NEXT_PUBLIC_BILLING_MOCK=1`; otherwise the buttons explain that mock
 * billing is disabled.
 */

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  CreditCard,
  Check,
  Loader2,
  CheckCircle2,
  XCircle,
  Cloud,
  Sparkles,
} from "lucide-react"
import { selectPlanMock, devLogin, devLogout, DEMO_BILLING_LABEL } from "@/lib/plan-client"
import { apiFetch } from "@/lib/api-fetch"

type Tier = "starter" | "pro" | "team"

interface PlanInfo {
  tier: Tier
  name: string
  price: string
  credits: string
  highlight?: boolean
  features: string[]
}

const PLANS: PlanInfo[] = [
  {
    tier: "starter",
    name: "Starter",
    price: "$9/mo",
    credits: "500 AI credits / month",
    features: ["Lite + Balanced modes", "AI explanations & fixes", "Single workspace"],
  },
  {
    tier: "pro",
    name: "Pro",
    price: "$29/mo",
    credits: "2,000 AI credits / month",
    highlight: true,
    features: ["Everything in Starter", "Deep (Pro) mode", "4× more AI credits", "Priority model routing"],
  },
  {
    // Backend tier name stays `team` (the highest "Max" tier); the card is
    // labelled "Max" so the plan matches the Exhaustive/Custom mode names.
    tier: "team",
    name: "Max",
    price: "$99/mo",
    credits: "10,000 AI credits / month",
    features: ["Everything in Pro", "Exhaustive (Max) mode", "Custom (manual model selection)", "Shared workspace"],
  },
]

interface PlanState {
  authenticated: boolean
  email: string | null
  tier: string
  creditsRemaining: number
  creditsTotal: number
  subscriptionStatus?: string
  backend?: string
}

export function PlanBilling() {
  const [email, setEmail] = useState("")
  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [state, setState] = useState<PlanState | null>(null)
  const [busy, setBusy] = useState<Tier | "signout" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const mockEnabled = process.env.NEXT_PUBLIC_BILLING_MOCK === "1"

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch("/api/plan")
      if (!res.ok) return
      const json = (await res.json()) as {
        authenticated?: boolean
        email?: string | null
        plan?: { tier?: string; creditsRemaining?: number; creditsTotal?: number; subscriptionStatus?: string }
        capabilities?: { billingBackend?: string }
      }
      setState({
        authenticated: Boolean(json.authenticated),
        email: json.email ?? null,
        tier: json.plan?.tier ?? "free",
        creditsRemaining: json.plan?.creditsRemaining ?? 0,
        creditsTotal: json.plan?.creditsTotal ?? 0,
        subscriptionStatus: json.plan?.subscriptionStatus,
        backend: json.capabilities?.billingBackend,
      })
      if (json.email && !email) setEmail(json.email)
    } catch {
      /* ignore */
    }
  }, [email])

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const select = async (tier: Tier) => {
    setError(null)
    setSuccess(null)
    const e = email.trim().toLowerCase()
    if (!e || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) {
      setError("Enter a valid email before selecting a plan.")
      return
    }
    setBusy(tier)
    // 1. Establish a session for this email (sets the signed cookie). When
    //    not signed in we sign in / create the account first, capturing the
    //    optional first/last name so the cloud billing row is attributed.
    const login = await devLogin(e, {
      firstName: firstName.trim() || undefined,
      lastName: lastName.trim() || undefined,
    })
    if (!login.ok) {
      setError(login.error)
      setBusy(null)
      return
    }
    // 2. Persist the plan to the cloud billing store.
    const r = await selectPlanMock(tier)
    if (!r.ok) {
      // 409 → "Subscription already exists for …" surfaces here.
      setError(r.error)
      setBusy(null)
      await refresh()
      return
    }
    setSuccess(`Saved to the cloud — ${r.email ?? e} is now on the ${r.tier} plan.`)
    await refresh()
    setBusy(null)
  }

  const signOut = async () => {
    setBusy("signout")
    setError(null)
    setSuccess(null)
    await devLogout()
    setEmail("")
    await refresh()
    setBusy(null)
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <CreditCard className="h-6 w-6" />
          Plan &amp; Billing
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Enter your email, choose a plan, and we&apos;ll save your subscription to the cloud.
        </p>
        {mockEnabled && (
          <p className="text-amber-200/90 text-sm mt-2">{DEMO_BILLING_LABEL}</p>
        )}
      </div>

      {!mockEnabled && (
        <Card className="border-yellow-500/40 bg-yellow-500/[0.06]">
          <CardContent className="py-4 text-sm flex items-center gap-2">
            <XCircle className="h-4 w-4 text-yellow-400" />
            <span>
              Demo billing is disabled. Set <code>BILLING_MOCK=1</code> and{" "}
              <code>NEXT_PUBLIC_BILLING_MOCK=1</code> (plus <code>JWT_SECRET</code>) in{" "}
              <code>.env.local</code> and restart the dev server.
            </span>
          </CardContent>
        </Card>
      )}

      {/* Account / email */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4" />
            Your account
          </CardTitle>
          <CardDescription>
            {state?.authenticated && state.email
              ? "You're signed in. Your selected plan is saved against this email."
              : "Enter the email this subscription belongs to."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {!(state?.authenticated && state.email) && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="billing-first-name" className="text-xs">
                  First name
                </Label>
                <Input
                  id="billing-first-name"
                  type="text"
                  placeholder="Ada"
                  value={firstName}
                  onChange={(ev) => setFirstName(ev.target.value)}
                  disabled={busy !== null}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="billing-last-name" className="text-xs">
                  Last name
                </Label>
                <Input
                  id="billing-last-name"
                  type="text"
                  placeholder="Lovelace"
                  value={lastName}
                  onChange={(ev) => setLastName(ev.target.value)}
                  disabled={busy !== null}
                />
              </div>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="billing-email" className="text-xs">
              Email
            </Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="billing-email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(ev) => setEmail(ev.target.value)}
                className="max-w-sm"
                disabled={busy !== null}
              />
              {state?.authenticated && state.email && (
                <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={signOut}>
                  {busy === "signout" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Sign out"}
                </Button>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Cloud className="h-3.5 w-3.5" />
              Saved to:{" "}
              <strong className="text-foreground">
                {state?.backend === "postgres"
                  ? "Neon Postgres (cloud)"
                  : state?.backend === "file"
                    ? "local file (set DATABASE_URL for cloud)"
                    : "…"}
              </strong>
            </span>
            <span>
              Current plan:{" "}
              <strong className="text-foreground uppercase">{state?.tier ?? "—"}</strong>
            </span>
            <span>
              Credits:{" "}
              <strong className="text-foreground">
                {state ? `${state.creditsRemaining} / ${state.creditsTotal}` : "—"}
              </strong>
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Plan cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {PLANS.map((p) => {
          const isCurrent = state?.tier === p.tier && state?.subscriptionStatus !== "none"
          return (
            <Card
              key={p.tier}
              className={
                p.highlight
                  ? "border-accent/60 bg-accent/[0.04] relative"
                  : "bg-card border-border relative"
              }
            >
              {p.highlight && (
                <Badge className="absolute -top-2 right-3 bg-accent text-accent-foreground">
                  Popular
                </Badge>
              )}
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  {p.highlight && <Sparkles className="h-4 w-4 text-accent" />}
                  {p.name}
                </CardTitle>
                <CardDescription>
                  <span className="text-xl font-semibold text-foreground">{p.price}</span>
                  <br />
                  {p.credits}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <ul className="space-y-1.5 text-xs text-muted-foreground">
                  {p.features.map((f) => (
                    <li key={f} className="flex items-start gap-2">
                      <Check className="h-3.5 w-3.5 text-emerald-400 mt-0.5 shrink-0" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <Button
                  type="button"
                  variant={p.highlight ? "default" : "outline"}
                  className="w-full"
                  disabled={busy !== null || !mockEnabled || isCurrent}
                  onClick={() => select(p.tier)}
                >
                  {busy === p.tier ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : isCurrent ? (
                    "Current plan"
                  ) : (
                    `Select ${p.name}`
                  )}
                </Button>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {success && (
        <div className="flex items-center gap-2 text-sm text-emerald-400 rounded-md border border-emerald-500/30 bg-emerald-500/[0.06] p-3">
          <CheckCircle2 className="h-4 w-4" />
          <span>{success}</span>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 text-sm text-red-400 rounded-md border border-red-500/30 bg-red-500/[0.06] p-3">
          <XCircle className="h-4 w-4" />
          <span>{error}</span>
        </div>
      )}
    </div>
  )
}
