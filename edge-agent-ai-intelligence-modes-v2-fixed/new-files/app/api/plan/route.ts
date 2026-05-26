/**
 * GET /api/plan
 *
 * Returns the SAFE, browser-exposable view of the caller's subscription:
 * tier, which intelligence modes are allowed, whether manual model
 * selection is permitted, and remaining AI credits. No provider keys,
 * ever.
 *
 * The UI uses this to:
 *   - disable Pro/Max/Manual when the plan doesn't include them,
 *   - show "Hosted AI — included in your plan" + credits,
 *   - in Manual mode, only offer models the plan allows.
 *
 * Auth/identity is stubbed to a single workspace user for now; swap
 * `resolveIdentity` for the real session lookup.
 */

import { NextResponse } from "next/server"
import { loadSubscription, planSummary } from "@/lib/server-subscription"

export const dynamic = "force-dynamic"

function resolveIdentity(_req: Request): { userId: string; workspaceId: string } {
  // TODO: replace with real session/workspace resolution.
  return { userId: "local-user", workspaceId: "local-workspace" }
}

export async function GET(req: Request) {
  const { userId, workspaceId } = resolveIdentity(req)
  const sub = loadSubscription(userId, workspaceId)
  return NextResponse.json({ plan: planSummary(sub) })
}
