/**
 * Password hashing for Edge Agent AI accounts.
 *
 * Uses scrypt (RFC 7914) from node:crypto — a memory-hard KDF that ships
 * with Node, so we add no third-party dependency (consistent with the
 * in-process HS256 implementation in server-auth.ts). Each password gets a
 * unique 16-byte random salt; verification is constant-time.
 *
 * Stored format (single string, safe to keep in a TEXT column):
 *   scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>
 *
 * SECURITY: plaintext passwords are never stored, logged, or returned.
 */

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto"

// Cost parameters. N must be a power of two. These defaults target ~tens of
// ms per hash on a server CPU — strong for interactive login without being
// a DoS vector. `maxmem` is raised so Node doesn't reject N=16384,r=8.
const N = 16384
const R = 8
const P = 1
const KEYLEN = 64
const SALT_BYTES = 16
const MAXMEM = 64 * 1024 * 1024

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM }, (err, derived) => {
      if (err) reject(err)
      else resolve(derived as Buffer)
    })
  })
}

/** Hash a plaintext password into the storable `scrypt$…` string. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const derived = await scryptAsync(password, salt)
  return `scrypt$${N}$${R}$${P}$${salt.toString("hex")}$${derived.toString("hex")}`
}

/**
 * Verify a plaintext password against a stored hash. Returns false for any
 * malformed/unknown hash rather than throwing, so a corrupt row can't 500
 * the login route. Constant-time comparison prevents timing leaks.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (typeof stored !== "string") return false
  const parts = stored.split("$")
  if (parts.length !== 6 || parts[0] !== "scrypt") return false
  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false
  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(parts[4], "hex")
    expected = Buffer.from(parts[5], "hex")
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false

  let derived: Buffer
  try {
    derived = await new Promise<Buffer>((resolve, reject) => {
      scryptCb(password, salt, expected.length, { N: n, r, p, maxmem: MAXMEM }, (err, d) => {
        if (err) reject(err)
        else resolve(d as Buffer)
      })
    })
  } catch {
    return false
  }
  if (derived.length !== expected.length) return false
  return timingSafeEqual(derived, expected)
}

// ---------------------------------------------------------------------------
// Opaque token hashing (email-verification / password-reset / refresh tokens).
//
// These tokens are high-entropy random strings, so a fast one-way hash
// (SHA-256) is the right primitive — we only ever need to look up "does this
// presented token match a stored digest?", and a slow KDF would add no value
// against a 256-bit random secret. We store ONLY the digest; the raw token is
// shown once to its owner (emailed in production) and never persisted.
// ---------------------------------------------------------------------------

/** Generate a URL-safe random token (default 32 bytes ≈ 256 bits). */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url")
}

/** One-way digest of an opaque token, safe to store at rest. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex")
}

/** Constant-time comparison of a presented token against a stored digest. */
export function verifyToken(token: string, storedHash: string): boolean {
  if (typeof token !== "string" || typeof storedHash !== "string") return false
  let a: Buffer
  let b: Buffer
  try {
    a = Buffer.from(hashToken(token), "hex")
    b = Buffer.from(storedHash, "hex")
  } catch {
    return false
  }
  if (a.length !== b.length || a.length === 0) return false
  return timingSafeEqual(a, b)
}

/** Basic password policy: at least 8 chars, not absurdly long. */
export function passwordPolicyError(password: string): string | null {
  if (typeof password !== "string" || password.length < 8) {
    return "Password must be at least 8 characters."
  }
  if (password.length > 200) {
    return "Password must be at most 200 characters."
  }
  return null
}
