"use client"

/**
 * Onboarding / welcome gate.
 *
 * Shown on first load when the visitor has no session and hasn't yet
 * dismissed it. Three paths:
 *
 *   1. Provide email + first/last name → creates a session (and saves
 *      the account to the cloud) → enters the app.
 *   2. Skip → continue anonymously (only deterministic "Save Resources"
 *      scans; AI modes are locked until they sign in / subscribe).
 *   3. View plans → jump straight to Plan & Billing.
 *
 * The "Continue" path requires demo billing (`NEXT_PUBLIC_BILLING_MOCK`);
 * when it's off we hide the sign-in form and only offer Skip / View plans.
 */

import { useState } from "react"
import Image from "next/image"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2, XCircle, ArrowRight, CreditCard } from "lucide-react"
import { devLogin } from "@/lib/plan-client"

export interface OnboardingWelcomeProps {
  /** Continue anonymously. */
  onSkip: () => void
  /** Go to the Plan & Billing page (optionally after signing in). */
  onViewPlans: () => void
  /** A session was created — enter the app. */
  onSignedIn: () => void
}

export function OnboardingWelcome({ onSkip, onViewPlans, onSignedIn }: OnboardingWelcomeProps) {
  const [email, setEmail] = useState("")
  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [busy, setBusy] = useState<"continue" | "plans" | null>(null)
  const [error, setError] = useState<string | null>(null)

  const mockEnabled = process.env.NEXT_PUBLIC_BILLING_MOCK === "1"

  const validEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())

  const signIn = async (): Promise<boolean> => {
    setError(null)
    if (!validEmail) {
      setError("Enter a valid email to continue.")
      return false
    }
    const r = await devLogin(email.trim().toLowerCase(), {
      firstName: firstName.trim() || undefined,
      lastName: lastName.trim() || undefined,
    })
    if (!r.ok) {
      setError(r.error)
      return false
    }
    return true
  }

  const onContinue = async () => {
    setBusy("continue")
    const ok = await signIn()
    setBusy(null)
    if (ok) onSignedIn()
  }

  const onPlans = async () => {
    // If they typed an email, sign them in first so the plan they pick is
    // saved against it; otherwise just browse plans anonymously.
    if (mockEnabled && validEmail) {
      setBusy("plans")
      await signIn()
      setBusy(null)
    }
    onViewPlans()
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md bg-card border-border">
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
          <CardTitle className="text-xl">Welcome</CardTitle>
          <CardDescription>
            Tell us who you are to unlock AI analysis modes, or skip to run
            deterministic scans anonymously.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {mockEnabled ? (
            <>
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
                  />
                </div>
              </div>
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
                />
              </div>

              {error && (
                <div className="flex items-center gap-2 text-xs text-red-400">
                  <XCircle className="h-3.5 w-3.5" />
                  <span>{error}</span>
                </div>
              )}

              <Button className="w-full" disabled={busy !== null} onClick={onContinue}>
                {busy === "continue" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    Continue <ArrowRight className="h-4 w-4 ml-1.5" />
                  </>
                )}
              </Button>
            </>
          ) : (
            <div className="rounded-md border border-yellow-500/40 bg-yellow-500/[0.06] p-3 text-xs text-yellow-300">
              Sign-in is disabled (set <code>NEXT_PUBLIC_BILLING_MOCK=1</code>).
              You can still run deterministic scans or view plans.
            </div>
          )}

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
