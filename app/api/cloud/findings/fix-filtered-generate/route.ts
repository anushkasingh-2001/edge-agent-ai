/**
 * POST /api/cloud/findings/fix-filtered-generate
 *
 * Cloud-side GENERATION leg for the bulk "fix filtered" flow. The desktop
 * clusters findings locally and asks this endpoint for ONE representative
 * patch per LLM cluster. Never touches local files. See
 * lib/server-cloud-generate.ts.
 */

import { handleCloudGenerate, handleCloudGeneratePreflight } from "@/lib/server-cloud-generate"

export const dynamic = "force-dynamic"
// 60s keeps this deployable on any Vercel plan (Hobby caps functions at
// 60s). The cloud path makes a single model call per request, so 60s is ample.
export const maxDuration = 60

export async function POST(req: Request) {
  return handleCloudGenerate(req)
}

export async function OPTIONS(req: Request) {
  return handleCloudGeneratePreflight(req)
}
