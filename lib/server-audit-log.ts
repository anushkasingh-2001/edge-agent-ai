/**
 * Hosted-AI audit log.
 *
 * Every hosted model attempt produces ONE structured record. Routes
 * call:
 *
 *   const reqId = beginAudit(...)
 *   ...
 *   completeAudit(reqId, "success", { ... })
 *
 * Records live in `$EDGE_AGENT_HOME/audit.log` (newline-delimited JSON).
 * Production deployments swap the writer for a centralized log
 * pipeline via `setAuditWriter`.
 *
 * Security:
 *   - Never log `apiKey` / `baseUrl` / `Authorization` headers.
 *   - Never log prompts or source code by default.
 *   - `contextHash` is the only opaque pointer to the input.
 *   - Error messages are passed through `redactSecrets` so any
 *     accidentally-quoted bearer/sk-... token is masked.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"

export type AuditStatus = "started" | "success" | "blocked" | "failed"

export interface AuditRecord {
  requestId: string
  userId: string
  workspaceId: string
  task: string
  intelligenceMode: string
  provider: string
  model: string
  apiKeySource: "hosted"
  estimatedCredits: number
  actualCredits?: number
  inputTokens?: number
  outputTokens?: number
  contextHash?: string
  status: AuditStatus
  blockReason?: string
  errorClass?: string
  source?: string
  createdAt: string
}

export interface AuditWriter {
  write(record: AuditRecord): void
  recent(limit?: number): AuditRecord[]
  _resetForTests(): void
}

const APP_DIR_NAME = "edge-agent-ai"
const FILE_NAME = "audit.log"
const TAIL_CAP = 5000

function appDir(): string {
  const override = process.env.EDGE_AGENT_HOME
  if (override) return override
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
    return path.join(appData, APP_DIR_NAME)
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(xdg, APP_DIR_NAME)
}

function filePath(): string {
  return path.join(appDir(), FILE_NAME)
}

function ensureDir(): void {
  try {
    fs.mkdirSync(appDir(), { recursive: true, mode: 0o700 })
  } catch {
    /* ignore */
  }
}

class FileAuditWriter implements AuditWriter {
  write(record: AuditRecord): void {
    try {
      ensureDir()
      fs.appendFileSync(filePath(), JSON.stringify(record) + "\n", {
        mode: 0o600,
      })
    } catch {
      // Audit writes must NEVER fail the actual request. Swallow.
    }
  }

  recent(limit = 100): AuditRecord[] {
    try {
      const raw = fs.readFileSync(filePath(), "utf8")
      const lines = raw.trimEnd().split("\n").slice(-Math.max(1, limit))
      const out: AuditRecord[] = []
      for (const line of lines) {
        try {
          out.push(JSON.parse(line) as AuditRecord)
        } catch {
          /* skip corrupt line */
        }
      }
      return out
    } catch {
      return []
    }
  }

  _resetForTests(): void {
    try {
      fs.rmSync(filePath(), { force: true })
    } catch {
      /* ignore */
    }
  }
}

/** Postgres-backed audit writer. Writes are fire-and-forget — the
 *  contract is that an audit write MUST NOT fail the AI request, so
 *  we swallow errors after a single warn. Production deployments
 *  opt in by setting `AUDIT_LOG_STORE=postgres`. */
class PostgresAuditWriter implements AuditWriter {
  // We keep a small in-process tail to keep `recent()` cheap even
  // when the DB is unreachable. The tail is for the dashboard; the
  // authoritative store is the DB.
  private tail: AuditRecord[] = []

  write(record: AuditRecord): void {
    this.tail = [record, ...this.tail].slice(0, TAIL_CAP)
    void this.persist(record)
  }

  private async persist(record: AuditRecord): Promise<void> {
    try {
      const { getAsyncBillingStore, ensureBootstrap } = await import(
        "./server-billing-bootstrap"
      )
      await ensureBootstrap()
      const store = getAsyncBillingStore() as unknown as {
        writeAuditLog?: (r: AuditRecord) => Promise<void>
      }
      if (typeof store.writeAuditLog === "function") {
        await store.writeAuditLog(record)
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[audit] persist failed:", e instanceof Error ? e.message : e)
    }
  }

  recent(limit = 100): AuditRecord[] {
    return this.tail.slice(0, Math.max(1, limit))
  }

  _resetForTests(): void {
    this.tail = []
  }
}

function pickDefaultWriter(): AuditWriter {
  if ((process.env.AUDIT_LOG_STORE ?? "").toLowerCase() === "postgres") {
    return new PostgresAuditWriter()
  }
  return new FileAuditWriter()
}

let writer: AuditWriter = pickDefaultWriter()

export function getAuditWriter(): AuditWriter {
  return writer
}

export function setAuditWriter(next: AuditWriter): void {
  writer = next
}

/** Stable, content-only hash for audit traceability without leaking
 *  the raw prompt / source. */
export function hashContext(parts: Array<string | undefined>): string {
  const h = createHash("sha256")
  for (const p of parts) h.update(String(p ?? ""))
  return h.digest("hex").slice(0, 16)
}

// ---------------------------------------------------------------------------
// Secret redactor — used everywhere we surface an upstream error string
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  // OpenAI / Anthropic / GitHub style key sigils. Any "sk-*" or
  // sigil-prefixed token that is at least 4 trailing characters is
  // assumed to be a secret. We err on the side of redacting too much
  // — false positives in audit logs are far less harmful than leaks.
  /\b(sk|sk-(?:proj|live|svcacct|test)?|sk-ant|rk_live|pk_live|ghp|ghu|gho|gh_pat)[-_][A-Za-z0-9_-]{4,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\bya29\.[A-Za-z0-9_-]+/g,
  /Bearer\s+[A-Za-z0-9._-]{8,}/gi,
  /["']?api[_-]?key["']?\s*[:=]\s*["'][^"']{4,}["']/gi,
]

export function redactSecrets(s: string | undefined | null): string {
  if (!s) return ""
  let out = String(s)
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]")
  return out.length > 2000 ? `${out.slice(0, 2000)}…[truncated]` : out
}

// ---------------------------------------------------------------------------
// Begin/Complete API used by routes
// ---------------------------------------------------------------------------

const PENDING = new Map<string, AuditRecord>()

export function beginAudit(args: {
  userId: string
  workspaceId: string
  task: string
  intelligenceMode: string
  provider: string
  model: string
  estimatedCredits: number
  contextHash?: string
  source?: string
}): string {
  const requestId = randomUUID()
  const record: AuditRecord = {
    requestId,
    userId: args.userId,
    workspaceId: args.workspaceId,
    task: args.task,
    intelligenceMode: args.intelligenceMode,
    provider: args.provider,
    model: args.model,
    apiKeySource: "hosted",
    estimatedCredits: args.estimatedCredits,
    contextHash: args.contextHash,
    status: "started",
    source: args.source,
    createdAt: new Date().toISOString(),
  }
  PENDING.set(requestId, record)
  getAuditWriter().write(record)
  return requestId
}

export function completeAudit(
  requestId: string,
  status: AuditStatus,
  patch: Partial<
    Pick<
      AuditRecord,
      | "actualCredits"
      | "inputTokens"
      | "outputTokens"
      | "blockReason"
      | "errorClass"
    >
  > = {},
): void {
  const base = PENDING.get(requestId) ?? {
    requestId,
    userId: "unknown",
    workspaceId: "unknown",
    task: "unknown",
    intelligenceMode: "unknown",
    provider: "unknown",
    model: "unknown",
    apiKeySource: "hosted" as const,
    estimatedCredits: 0,
    status: "started" as const,
    createdAt: new Date().toISOString(),
  }
  PENDING.delete(requestId)
  const record: AuditRecord = {
    ...base,
    ...patch,
    status,
    blockReason: patch.blockReason ? redactSecrets(patch.blockReason) : patch.blockReason,
    errorClass: patch.errorClass,
    createdAt: new Date().toISOString(),
  }
  getAuditWriter().write(record)
}

/** One-shot audit (e.g. plan-blocked before any upstream attempt). */
export function logBlocked(args: {
  userId: string
  workspaceId: string
  task: string
  intelligenceMode: string
  blockReason: string
  provider?: string
  model?: string
}): void {
  const record: AuditRecord = {
    requestId: randomUUID(),
    userId: args.userId,
    workspaceId: args.workspaceId,
    task: args.task,
    intelligenceMode: args.intelligenceMode,
    provider: args.provider ?? "n/a",
    model: args.model ?? "n/a",
    apiKeySource: "hosted",
    estimatedCredits: 0,
    status: "blocked",
    blockReason: redactSecrets(args.blockReason),
    createdAt: new Date().toISOString(),
  }
  getAuditWriter().write(record)
}
