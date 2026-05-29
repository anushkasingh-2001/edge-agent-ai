/**
 * Postgres-backed `UserStore` (production).
 *
 * Tables: see migrations/004_users.sql (users, workspaces, linked_accounts).
 * Takes the same generic `SqlClient` as the billing adapter so the build
 * doesn't hard-depend on `pg`.
 *
 * SECURITY: stores a scrypt password hash only — never plaintext, never a
 * provider API key.
 */

import { randomUUID } from "node:crypto"
import type { SqlClient } from "./server-postgres-billing-store"
import {
  UserExistsError,
  normalizeEmail,
  DEFAULT_REFRESH_RETENTION_MS,
  type AuthTokenRecord,
  type CreateUserInput,
  type LinkedAccount,
  type RefreshTokenRecord,
  type TokenCleanupOptions,
  type TokenCleanupResult,
  type UserRecord,
  type UserStore,
  type WorkspaceRecord,
} from "./server-user-store"

interface UserRow {
  id: string
  email: string
  name: string | null
  password_hash: string
  email_verified: boolean | null
  email_verified_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}

interface AuthTokenRow {
  id: string
  user_id: string
  token_hash: string
  expires_at: Date | string
  created_at: Date | string
  used_at: Date | string | null
}

interface RefreshTokenRow {
  id: string
  user_id: string
  workspace_id: string
  token_hash: string
  expires_at: Date | string
  created_at: Date | string
  revoked_at: Date | string | null
}

interface WorkspaceRow {
  id: string
  owner_user_id: string
  name: string
  created_at: Date | string
}

interface LinkRow {
  id: string
  user_id: string
  provider: string
  provider_user_id: string
  token_ref: string | null
  created_at: Date | string
}

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : String(v)
}

function rowToUser(r: UserRow): UserRecord {
  return {
    id: r.id,
    email: r.email,
    name: r.name ?? undefined,
    passwordHash: r.password_hash,
    emailVerified: Boolean(r.email_verified),
    emailVerifiedAt: r.email_verified_at ? iso(r.email_verified_at) : undefined,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  }
}

function rowToAuthToken(r: AuthTokenRow): AuthTokenRecord {
  return {
    id: r.id,
    userId: r.user_id,
    tokenHash: r.token_hash,
    expiresAt: iso(r.expires_at),
    createdAt: iso(r.created_at),
    usedAt: r.used_at ? iso(r.used_at) : undefined,
  }
}

function rowToRefreshToken(r: RefreshTokenRow): RefreshTokenRecord {
  return {
    id: r.id,
    userId: r.user_id,
    workspaceId: r.workspace_id,
    tokenHash: r.token_hash,
    expiresAt: iso(r.expires_at),
    createdAt: iso(r.created_at),
    revokedAt: r.revoked_at ? iso(r.revoked_at) : undefined,
  }
}

function rowToWorkspace(r: WorkspaceRow): WorkspaceRecord {
  return { id: r.id, ownerUserId: r.owner_user_id, name: r.name, createdAt: iso(r.created_at) }
}

function rowToLink(r: LinkRow): LinkedAccount {
  return {
    id: r.id,
    userId: r.user_id,
    provider: r.provider,
    providerUserId: r.provider_user_id,
    tokenRef: r.token_ref ?? undefined,
    createdAt: iso(r.created_at),
  }
}

export class SqlUserStore implements UserStore {
  constructor(private readonly client: SqlClient) {}

  async createUser(
    input: CreateUserInput,
  ): Promise<{ user: UserRecord; workspace: WorkspaceRecord }> {
    const email = normalizeEmail(input.email)
    await this.client.query("BEGIN")
    try {
      const existing = await this.client.query<UserRow>(
        `SELECT id FROM users WHERE email = $1`,
        [email],
      )
      if (existing.rows.length > 0) {
        await this.client.query("ROLLBACK")
        throw new UserExistsError(email)
      }
      const userId = `usr_${randomUUID()}`
      const wsId = `ws_${randomUUID()}`
      const name = input.name?.trim() || null
      const userIns = await this.client.query<UserRow>(
        `INSERT INTO users (id, email, name, password_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [userId, email, name, input.passwordHash],
      )
      const wsIns = await this.client.query<WorkspaceRow>(
        `INSERT INTO workspaces (id, owner_user_id, name)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [wsId, userId, name ? `${name}'s workspace` : "Personal workspace"],
      )
      await this.client.query("COMMIT")
      return { user: rowToUser(userIns.rows[0]), workspace: rowToWorkspace(wsIns.rows[0]) }
    } catch (e) {
      await this.client.query("ROLLBACK").catch(() => undefined)
      throw e
    }
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const res = await this.client.query<UserRow>(`SELECT * FROM users WHERE email = $1`, [
      normalizeEmail(email),
    ])
    return res.rows.length > 0 ? rowToUser(res.rows[0]) : null
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const res = await this.client.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [id])
    return res.rows.length > 0 ? rowToUser(res.rows[0]) : null
  }

  async getWorkspaceForUser(userId: string): Promise<WorkspaceRecord | null> {
    const res = await this.client.query<WorkspaceRow>(
      `SELECT * FROM workspaces WHERE owner_user_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [userId],
    )
    return res.rows.length > 0 ? rowToWorkspace(res.rows[0]) : null
  }

  async updatePassword(userId: string, passwordHash: string): Promise<void> {
    await this.client.query(
      `UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1`,
      [userId, passwordHash],
    )
  }

  async markEmailVerified(userId: string): Promise<void> {
    await this.client.query(
      `UPDATE users
          SET email_verified = TRUE,
              email_verified_at = COALESCE(email_verified_at, NOW()),
              updated_at = NOW()
        WHERE id = $1`,
      [userId],
    )
  }

  async createVerificationToken(
    userId: string,
    tokenHash: string,
    expiresAt: string,
  ): Promise<AuthTokenRecord> {
    // Supersede outstanding tokens for this user.
    await this.client.query(`DELETE FROM email_verification_tokens WHERE user_id = $1`, [userId])
    const res = await this.client.query<AuthTokenRow>(
      `INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [`vt_${randomUUID()}`, userId, tokenHash, expiresAt],
    )
    return rowToAuthToken(res.rows[0])
  }

  async findVerificationToken(tokenHash: string): Promise<AuthTokenRecord | null> {
    const res = await this.client.query<AuthTokenRow>(
      `SELECT * FROM email_verification_tokens
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
        LIMIT 1`,
      [tokenHash],
    )
    return res.rows.length > 0 ? rowToAuthToken(res.rows[0]) : null
  }

  async consumeVerificationToken(id: string): Promise<void> {
    await this.client.query(
      `UPDATE email_verification_tokens SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`,
      [id],
    )
  }

  async createResetToken(
    userId: string,
    tokenHash: string,
    expiresAt: string,
  ): Promise<AuthTokenRecord> {
    await this.client.query(`DELETE FROM password_reset_tokens WHERE user_id = $1`, [userId])
    const res = await this.client.query<AuthTokenRow>(
      `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [`rt_${randomUUID()}`, userId, tokenHash, expiresAt],
    )
    return rowToAuthToken(res.rows[0])
  }

  async findResetToken(tokenHash: string): Promise<AuthTokenRecord | null> {
    const res = await this.client.query<AuthTokenRow>(
      `SELECT * FROM password_reset_tokens
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
        LIMIT 1`,
      [tokenHash],
    )
    return res.rows.length > 0 ? rowToAuthToken(res.rows[0]) : null
  }

  async consumeResetToken(id: string): Promise<void> {
    await this.client.query(
      `UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`,
      [id],
    )
  }

  async createRefreshToken(
    userId: string,
    workspaceId: string,
    tokenHash: string,
    expiresAt: string,
  ): Promise<RefreshTokenRecord> {
    const res = await this.client.query<RefreshTokenRow>(
      `INSERT INTO refresh_tokens (id, user_id, workspace_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [`ref_${randomUUID()}`, userId, workspaceId, tokenHash, expiresAt],
    )
    return rowToRefreshToken(res.rows[0])
  }

  async findRefreshToken(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const res = await this.client.query<RefreshTokenRow>(
      `SELECT * FROM refresh_tokens
        WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()
        LIMIT 1`,
      [tokenHash],
    )
    return res.rows.length > 0 ? rowToRefreshToken(res.rows[0]) : null
  }

  async revokeRefreshToken(id: string): Promise<void> {
    await this.client.query(
      `UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL`,
      [id],
    )
  }

  async revokeAllRefreshTokens(userId: string, workspaceId?: string): Promise<number> {
    const res = workspaceId
      ? await this.client.query(
          `UPDATE refresh_tokens SET revoked_at = NOW()
            WHERE user_id = $1 AND workspace_id = $2 AND revoked_at IS NULL`,
          [userId, workspaceId],
        )
      : await this.client.query(
          `UPDATE refresh_tokens SET revoked_at = NOW()
            WHERE user_id = $1 AND revoked_at IS NULL`,
          [userId],
        )
    return (res as { rowCount?: number }).rowCount ?? 0
  }

  async cleanupExpiredTokens(opts?: TokenCleanupOptions): Promise<TokenCleanupResult> {
    const now = new Date(opts?.now ?? Date.now()).toISOString()
    const retention = opts?.refreshRetentionMs ?? DEFAULT_REFRESH_RETENTION_MS
    const revokedCutoff = new Date((opts?.now ?? Date.now()) - retention).toISOString()

    const v = await this.client.query(
      `DELETE FROM email_verification_tokens WHERE used_at IS NOT NULL OR expires_at <= $1`,
      [now],
    )
    const r = await this.client.query(
      `DELETE FROM password_reset_tokens WHERE used_at IS NOT NULL OR expires_at <= $1`,
      [now],
    )
    const f = await this.client.query(
      `DELETE FROM refresh_tokens
        WHERE expires_at <= $1 OR (revoked_at IS NOT NULL AND revoked_at <= $2)`,
      [now, revokedCutoff],
    )
    const rows = (x: unknown): number => (x as { rowCount?: number }).rowCount ?? 0
    return { verification: rows(v), reset: rows(r), refresh: rows(f) }
  }

  async linkAccount(input: Omit<LinkedAccount, "id" | "createdAt">): Promise<LinkedAccount> {
    const id = `lnk_${randomUUID()}`
    const res = await this.client.query<LinkRow>(
      `INSERT INTO linked_accounts (id, user_id, provider, provider_user_id, token_ref)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, provider) DO UPDATE
         SET provider_user_id = EXCLUDED.provider_user_id,
             token_ref        = EXCLUDED.token_ref
       RETURNING *`,
      [id, input.userId, input.provider, input.providerUserId, input.tokenRef ?? null],
    )
    return rowToLink(res.rows[0])
  }

  async getLinkedAccounts(userId: string): Promise<LinkedAccount[]> {
    const res = await this.client.query<LinkRow>(
      `SELECT * FROM linked_accounts WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId],
    )
    return res.rows.map(rowToLink)
  }

  async _resetForTests(): Promise<void> {
    await this.client.query(
      "TRUNCATE refresh_tokens, password_reset_tokens, email_verification_tokens, linked_accounts, workspaces, users",
    )
  }
}
