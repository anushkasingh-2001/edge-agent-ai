/**
 * Edge Agent AI account store — users, workspaces, and linked external
 * accounts (e.g. GitHub).
 *
 * This is the IDENTITY of record for the product: subscriptions, credits,
 * and Stripe customers all key off `user.id` / `workspace.id` created here,
 * NOT off a GitHub login. GitHub is stored only as an optional row in
 * `linked_accounts` for repo/PR access.
 *
 * The default is a file-backed JSON store under `$EDGE_AGENT_HOME` (desktop
 * / dev). Production swaps in the Postgres impl via the bootstrap.
 *
 * SECURITY:
 *   - `passwordHash` is a scrypt digest (see server-password.ts) — never a
 *     plaintext password.
 *   - No provider API key is ever stored here. A linked GitHub token is
 *     referenced by `tokenRef` (or stored server-side only) and never
 *     returned to the renderer.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"

export interface UserRecord {
  id: string
  email: string
  name?: string
  passwordHash: string
  emailVerified: boolean
  emailVerifiedAt?: string
  createdAt: string
  updatedAt: string
}

/** Hashed, single-use, expiring token. Used for email verification and
 *  password resets. We store only `tokenHash` — never the raw token. */
export interface AuthTokenRecord {
  id: string
  userId: string
  tokenHash: string
  expiresAt: string
  createdAt: string
  usedAt?: string
}

/** Long-lived refresh token (hashed). Lets a client mint a fresh access JWT
 *  without re-entering the password. Rotated on use; revocable. */
export interface RefreshTokenRecord {
  id: string
  userId: string
  workspaceId: string
  tokenHash: string
  expiresAt: string
  createdAt: string
  revokedAt?: string
}

export interface WorkspaceRecord {
  id: string
  ownerUserId: string
  name: string
  createdAt: string
}

export interface LinkedAccount {
  id: string
  userId: string
  provider: string
  providerUserId: string
  /** Opaque reference to where the provider token lives server-side (never
   *  the token itself, never returned to the renderer). */
  tokenRef?: string
  createdAt: string
}

/** Public projection — safe to return to the client (no password hash). */
export interface PublicUser {
  id: string
  email: string
  name?: string
  emailVerified: boolean
  workspaceId: string
  role: "owner"
}

export interface TokenCleanupOptions {
  /** Reference time in epoch ms. Defaults to Date.now(). */
  now?: number
  /** How long to keep expired/revoked refresh-token rows for audit before
   *  deleting them. Defaults to 30 days. */
  refreshRetentionMs?: number
}

export interface TokenCleanupResult {
  verification: number
  reset: number
  refresh: number
}

/** Default retention for spent refresh-token rows (30 days). */
export const DEFAULT_REFRESH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export class UserExistsError extends Error {
  readonly code = "user_exists"
  readonly status = 409
  constructor(email: string) {
    super(`An account already exists for ${email}.`)
    this.name = "UserExistsError"
  }
}

export interface CreateUserInput {
  email: string
  passwordHash: string
  name?: string
}

export interface UserStore {
  createUser(input: CreateUserInput): Promise<{ user: UserRecord; workspace: WorkspaceRecord }>
  getUserByEmail(email: string): Promise<UserRecord | null>
  getUserById(id: string): Promise<UserRecord | null>
  getWorkspaceForUser(userId: string): Promise<WorkspaceRecord | null>

  /** Replace a user's password hash (password reset). */
  updatePassword(userId: string, passwordHash: string): Promise<void>
  /** Mark the user's email as verified (idempotent). */
  markEmailVerified(userId: string): Promise<void>

  // --- email-verification tokens --------------------------------------- //
  createVerificationToken(userId: string, tokenHash: string, expiresAt: string): Promise<AuthTokenRecord>
  /** Look up a usable (unused, unexpired) verification token by hash. */
  findVerificationToken(tokenHash: string): Promise<AuthTokenRecord | null>
  /** Mark a verification token used so it cannot be replayed. */
  consumeVerificationToken(id: string): Promise<void>

  // --- password-reset tokens ------------------------------------------- //
  createResetToken(userId: string, tokenHash: string, expiresAt: string): Promise<AuthTokenRecord>
  findResetToken(tokenHash: string): Promise<AuthTokenRecord | null>
  consumeResetToken(id: string): Promise<void>

  // --- refresh tokens -------------------------------------------------- //
  createRefreshToken(
    userId: string,
    workspaceId: string,
    tokenHash: string,
    expiresAt: string,
  ): Promise<RefreshTokenRecord>
  findRefreshToken(tokenHash: string): Promise<RefreshTokenRecord | null>
  revokeRefreshToken(id: string): Promise<void>
  /** Revoke every active refresh token for a user (optionally scoped to a
   *  workspace). Used on password reset + logout-all. Returns the count
   *  revoked. */
  revokeAllRefreshTokens(userId: string, workspaceId?: string): Promise<number>

  // --- maintenance ----------------------------------------------------- //
  /** Delete spent/expired auth tokens. Verification + reset tokens that are
   *  used or expired are removed; refresh tokens that are expired OR revoked
   *  longer than `refreshRetentionMs` ago are removed. Returns per-table
   *  counts. */
  cleanupExpiredTokens(opts?: TokenCleanupOptions): Promise<TokenCleanupResult>

  // --- linked external accounts (optional integrations) ---------------- //
  linkAccount(input: Omit<LinkedAccount, "id" | "createdAt">): Promise<LinkedAccount>
  getLinkedAccounts(userId: string): Promise<LinkedAccount[]>
  _resetForTests(): Promise<void>
}

export function normalizeEmail(email: string): string {
  return (email ?? "").trim().toLowerCase()
}

export function toPublicUser(user: UserRecord, workspaceId: string): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerified,
    workspaceId,
    role: "owner",
  }
}

// ---------------------------------------------------------------------------
// File-backed implementation
// ---------------------------------------------------------------------------

const APP_DIR_NAME = "edge-agent-ai"
const FILE_NAME = "users.json"

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

interface OnDisk {
  users: Record<string, UserRecord>
  emailIndex: Record<string, string>
  workspaces: Record<string, WorkspaceRecord>
  links: LinkedAccount[]
  verificationTokens: AuthTokenRecord[]
  resetTokens: AuthTokenRecord[]
  refreshTokens: RefreshTokenRecord[]
}

function emptyDisk(): OnDisk {
  return {
    users: {},
    emailIndex: {},
    workspaces: {},
    links: [],
    verificationTokens: [],
    resetTokens: [],
    refreshTokens: [],
  }
}

function readDisk(): OnDisk {
  try {
    const raw = fs.readFileSync(filePath(), "utf8")
    const parsed = JSON.parse(raw) as Partial<OnDisk>
    return {
      users: parsed.users ?? {},
      emailIndex: parsed.emailIndex ?? {},
      workspaces: parsed.workspaces ?? {},
      links: Array.isArray(parsed.links) ? parsed.links : [],
      verificationTokens: Array.isArray(parsed.verificationTokens) ? parsed.verificationTokens : [],
      resetTokens: Array.isArray(parsed.resetTokens) ? parsed.resetTokens : [],
      refreshTokens: Array.isArray(parsed.refreshTokens) ? parsed.refreshTokens : [],
    }
  } catch {
    return emptyDisk()
  }
}

function writeDisk(data: OnDisk): void {
  const dir = appDir()
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {
    /* ignore */
  }
  const fp = filePath()
  const tmp = `${fp}.tmp-${randomUUID()}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, fp)
}

function isoNow(): string {
  return new Date().toISOString()
}

/** A single-use token is usable only if it hasn't been consumed or expired. */
function usableToken(rec: AuthTokenRecord | undefined): AuthTokenRecord | null {
  if (!rec) return null
  if (rec.usedAt) return null
  if (Date.parse(rec.expiresAt) <= Date.now()) return null
  return rec
}

export class FileUserStore implements UserStore {
  async createUser(input: CreateUserInput): Promise<{ user: UserRecord; workspace: WorkspaceRecord }> {
    const disk = readDisk()
    const email = normalizeEmail(input.email)
    if (disk.emailIndex[email]) throw new UserExistsError(email)

    const now = isoNow()
    const user: UserRecord = {
      id: `usr_${randomUUID()}`,
      email,
      name: input.name?.trim() || undefined,
      passwordHash: input.passwordHash,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    }
    const workspace: WorkspaceRecord = {
      id: `ws_${randomUUID()}`,
      ownerUserId: user.id,
      name: user.name ? `${user.name}'s workspace` : "Personal workspace",
      createdAt: now,
    }
    disk.users[user.id] = user
    disk.emailIndex[email] = user.id
    disk.workspaces[workspace.id] = workspace
    writeDisk(disk)
    return { user, workspace }
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const disk = readDisk()
    const id = disk.emailIndex[normalizeEmail(email)]
    return id ? disk.users[id] ?? null : null
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    return readDisk().users[id] ?? null
  }

  async getWorkspaceForUser(userId: string): Promise<WorkspaceRecord | null> {
    const disk = readDisk()
    return Object.values(disk.workspaces).find((w) => w.ownerUserId === userId) ?? null
  }

  async updatePassword(userId: string, passwordHash: string): Promise<void> {
    const disk = readDisk()
    const user = disk.users[userId]
    if (!user) return
    user.passwordHash = passwordHash
    user.updatedAt = isoNow()
    writeDisk(disk)
  }

  async markEmailVerified(userId: string): Promise<void> {
    const disk = readDisk()
    const user = disk.users[userId]
    if (!user) return
    if (!user.emailVerified) {
      user.emailVerified = true
      user.emailVerifiedAt = isoNow()
      user.updatedAt = isoNow()
      writeDisk(disk)
    }
  }

  async createVerificationToken(
    userId: string,
    tokenHash: string,
    expiresAt: string,
  ): Promise<AuthTokenRecord> {
    const disk = readDisk()
    // Supersede any outstanding verification tokens for this user.
    disk.verificationTokens = disk.verificationTokens.filter((t) => t.userId !== userId)
    const rec: AuthTokenRecord = {
      id: `vt_${randomUUID()}`,
      userId,
      tokenHash,
      expiresAt,
      createdAt: isoNow(),
    }
    disk.verificationTokens.push(rec)
    writeDisk(disk)
    return rec
  }

  async findVerificationToken(tokenHash: string): Promise<AuthTokenRecord | null> {
    const rec = readDisk().verificationTokens.find((t) => t.tokenHash === tokenHash)
    return usableToken(rec)
  }

  async consumeVerificationToken(id: string): Promise<void> {
    const disk = readDisk()
    const rec = disk.verificationTokens.find((t) => t.id === id)
    if (rec && !rec.usedAt) {
      rec.usedAt = isoNow()
      writeDisk(disk)
    }
  }

  async createResetToken(
    userId: string,
    tokenHash: string,
    expiresAt: string,
  ): Promise<AuthTokenRecord> {
    const disk = readDisk()
    disk.resetTokens = disk.resetTokens.filter((t) => t.userId !== userId)
    const rec: AuthTokenRecord = {
      id: `rt_${randomUUID()}`,
      userId,
      tokenHash,
      expiresAt,
      createdAt: isoNow(),
    }
    disk.resetTokens.push(rec)
    writeDisk(disk)
    return rec
  }

  async findResetToken(tokenHash: string): Promise<AuthTokenRecord | null> {
    const rec = readDisk().resetTokens.find((t) => t.tokenHash === tokenHash)
    return usableToken(rec)
  }

  async consumeResetToken(id: string): Promise<void> {
    const disk = readDisk()
    const rec = disk.resetTokens.find((t) => t.id === id)
    if (rec && !rec.usedAt) {
      rec.usedAt = isoNow()
      writeDisk(disk)
    }
  }

  async createRefreshToken(
    userId: string,
    workspaceId: string,
    tokenHash: string,
    expiresAt: string,
  ): Promise<RefreshTokenRecord> {
    const disk = readDisk()
    const rec: RefreshTokenRecord = {
      id: `ref_${randomUUID()}`,
      userId,
      workspaceId,
      tokenHash,
      expiresAt,
      createdAt: isoNow(),
    }
    disk.refreshTokens.push(rec)
    // Keep the table from growing without bound on a single account.
    disk.refreshTokens = disk.refreshTokens.slice(-200)
    writeDisk(disk)
    return rec
  }

  async findRefreshToken(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const rec = readDisk().refreshTokens.find((t) => t.tokenHash === tokenHash)
    if (!rec) return null
    if (rec.revokedAt) return null
    if (Date.parse(rec.expiresAt) <= Date.now()) return null
    return rec
  }

  async revokeRefreshToken(id: string): Promise<void> {
    const disk = readDisk()
    const rec = disk.refreshTokens.find((t) => t.id === id)
    if (rec && !rec.revokedAt) {
      rec.revokedAt = isoNow()
      writeDisk(disk)
    }
  }

  async revokeAllRefreshTokens(userId: string, workspaceId?: string): Promise<number> {
    const disk = readDisk()
    let count = 0
    const now = isoNow()
    for (const rec of disk.refreshTokens) {
      if (rec.userId !== userId) continue
      if (workspaceId && rec.workspaceId !== workspaceId) continue
      if (rec.revokedAt) continue
      rec.revokedAt = now
      count++
    }
    if (count > 0) writeDisk(disk)
    return count
  }

  async cleanupExpiredTokens(opts?: TokenCleanupOptions): Promise<TokenCleanupResult> {
    const now = opts?.now ?? Date.now()
    const retention = opts?.refreshRetentionMs ?? DEFAULT_REFRESH_RETENTION_MS
    const disk = readDisk()

    const verifyBefore = disk.verificationTokens.length
    disk.verificationTokens = disk.verificationTokens.filter(
      (t) => !t.usedAt && Date.parse(t.expiresAt) > now,
    )
    const resetBefore = disk.resetTokens.length
    disk.resetTokens = disk.resetTokens.filter(
      (t) => !t.usedAt && Date.parse(t.expiresAt) > now,
    )
    const refreshBefore = disk.refreshTokens.length
    disk.refreshTokens = disk.refreshTokens.filter((t) => {
      const expired = Date.parse(t.expiresAt) <= now
      const revokedLongAgo = t.revokedAt ? now - Date.parse(t.revokedAt) > retention : false
      // Keep tokens that are still active OR recently revoked (audit window).
      return !expired && !revokedLongAgo
    })

    const result: TokenCleanupResult = {
      verification: verifyBefore - disk.verificationTokens.length,
      reset: resetBefore - disk.resetTokens.length,
      refresh: refreshBefore - disk.refreshTokens.length,
    }
    if (result.verification || result.reset || result.refresh) writeDisk(disk)
    return result
  }

  async linkAccount(input: Omit<LinkedAccount, "id" | "createdAt">): Promise<LinkedAccount> {
    const disk = readDisk()
    // One link per (user, provider): replace if it already exists.
    disk.links = disk.links.filter(
      (l) => !(l.userId === input.userId && l.provider === input.provider),
    )
    const link: LinkedAccount = { ...input, id: `lnk_${randomUUID()}`, createdAt: isoNow() }
    disk.links.push(link)
    writeDisk(disk)
    return link
  }

  async getLinkedAccounts(userId: string): Promise<LinkedAccount[]> {
    return readDisk().links.filter((l) => l.userId === userId)
  }

  async _resetForTests(): Promise<void> {
    try {
      fs.rmSync(filePath(), { force: true })
    } catch {
      /* ignore */
    }
  }
}
