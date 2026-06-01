/**
 * Next.js server-startup hook.
 *
 * Bootstraps the billing + account stores ONCE per Node process. With
 * `DATABASE_URL` set the singletons become Postgres-backed stores; without
 * it (dev only) we fall back to file storage. In production without
 * `DATABASE_URL`, billing/AI routes return 503 `billing_db_unconfigured`
 * and account routes return 503 `user_db_unconfigured`.
 *
 * Optionally runs `migrations/*.sql` against the DB when
 * `AUTO_MIGRATE_BILLING=1` is set — handy for preview environments
 * and `vercel preview` builds. Production deployments should run
 * `pnpm db:migrate` from CI instead.
 *
 * See https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 */

export async function register(): Promise<void> {
  // Edge runtime imports must be lazy — `pg` is a Node-only module.
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== "nodejs") return

  try {
    const { bootstrapBillingStore } = await import("./lib/server-billing-bootstrap")
    const report = await bootstrapBillingStore()
    // eslint-disable-next-line no-console
    console.log(
      `[edge-agent] billing store ready: backend=${report.backend} ok=${report.ok}${
        report.error ? ` error=${report.error}` : ""
      }`,
    )
    if (process.env.AUTO_MIGRATE_BILLING === "1" && report.backend === "postgres") {
      const { runBillingMigrations } = await import("./lib/server-postgres-migrate")
      const m = await runBillingMigrations()
      // eslint-disable-next-line no-console
      console.log(
        `[edge-agent] auto-migrate: ok=${m.ok} applied=${m.applied.join(",") || "none"}${
          m.error ? ` error=${m.error}` : ""
        }`,
      )
    }

    const { bootstrapUserStore, getUserBackendTag } = await import("./lib/server-user-bootstrap")
    await bootstrapUserStore()
    // eslint-disable-next-line no-console
    console.log(`[edge-agent] user store ready: backend=${getUserBackendTag()}`)
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[edge-agent] server bootstrap failed:", e)
  }
}
