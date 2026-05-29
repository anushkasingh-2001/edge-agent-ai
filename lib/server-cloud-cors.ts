/**
 * CORS for the cloud generation endpoints.
 *
 * The packaged desktop renderer loads from a loopback origin
 * (`http://127.0.0.1:<port>`) whose port varies per launch, and its local
 * Next server relays generation calls to the cloud backend server-to-server.
 * Browsers/Electron will preflight cross-origin POSTs that carry an
 * `Authorization` header, so the cloud must answer `OPTIONS` and echo the
 * appropriate `Access-Control-*` headers.
 *
 * Allowed origins (first match wins):
 *   - any origin listed in `EDGE_AGENT_CLOUD_ALLOWED_ORIGINS` (comma list),
 *   - `*` if that list contains `*` (dev convenience only),
 *   - any loopback origin (desktop renderer / local dev).
 *
 * For a same-origin web deployment there is no cross-origin call and these
 * headers are simply unused.
 */

function allowedOriginsFromEnv(): string[] {
  return (process.env.EDGE_AGENT_CLOUD_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

function isLoopbackOrigin(origin: string): boolean {
  if (!origin) return false
  try {
    const u = new URL(origin)
    return (
      u.hostname === "127.0.0.1" ||
      u.hostname === "localhost" ||
      u.hostname === "[::1]" ||
      u.hostname === "::1"
    )
  } catch {
    return false
  }
}

function originAllowed(origin: string): boolean {
  const list = allowedOriginsFromEnv()
  if (list.includes("*")) return true
  if (origin && list.includes(origin)) return true
  return isLoopbackOrigin(origin)
}

/** CORS response headers for the given request. When the origin is not
 *  allowed the `Access-Control-Allow-Origin` header is omitted (the browser
 *  then blocks the cross-origin read, which is the desired default-deny). */
export function cloudCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? ""
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  }
  if (originAllowed(origin)) {
    headers["Access-Control-Allow-Origin"] = origin || "*"
    headers["Access-Control-Allow-Credentials"] = "true"
  }
  return headers
}

/** Standard 204 preflight response. */
export function cloudPreflightResponse(req: Request): Response {
  return new Response(null, { status: 204, headers: cloudCorsHeaders(req) })
}
