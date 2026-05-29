/**
 * POST /api/cloud/finding/patch-generate
 *
 * Cloud-side single-finding patch GENERATION. Receives a redacted prompt
 * built by the desktop's local server, runs the hosted resolver + model,
 * and returns the patch text. Never touches local files. See
 * lib/server-cloud-generate.ts for the full contract.
 */

import { handleCloudGenerate, handleCloudGeneratePreflight } from "@/lib/server-cloud-generate"

export const dynamic = "force-dynamic"
// 60s keeps this deployable on any Vercel plan (Hobby caps functions at
// 60s). The cloud path makes a single model call (callLlm caps well under
// this), so 60s is ample.
export const maxDuration = 60

export async function POST(req: Request) {
  return handleCloudGenerate(req)
}

export async function OPTIONS(req: Request) {
  return handleCloudGeneratePreflight(req)
}
