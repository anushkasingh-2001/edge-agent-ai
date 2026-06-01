/**
 * Server email adapter — sends transactional auth emails (verification +
 * password reset) in production.
 *
 * Provider selection (first match wins):
 *   1. RESEND_API_KEY                  → Resend HTTPS API (no extra dep).
 *   2. SMTP_HOST (+ PORT/USER/PASS)    → SMTP via optional `nodemailer`.
 *   3. none                            → "unconfigured" transport.
 *
 * Required env:
 *   - EMAIL_FROM            sender address, e.g. "Edge Agent AI <noreply@…>"
 *   - NEXT_PUBLIC_APP_URL   base URL used to build the email links
 *
 * SECURITY:
 *   - This module receives raw tokens only as part of a fully-formed link and
 *     NEVER logs the message body, the link, or the token. Logs carry only
 *     non-sensitive metadata (provider name, recipient domain, subject, error).
 *   - No provider API key / SMTP password is ever returned to a caller or
 *     included in a thrown error surfaced to the client.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails"

export interface EmailMessage {
  to: string
  subject: string
  html: string
  text: string
}

export interface EmailResult {
  ok: boolean
  provider: string
  /** Non-sensitive error summary (safe to log). */
  error?: string
}

interface EmailTransport {
  name: string
  send(msg: EmailMessage): Promise<void>
}

// --- test seam -------------------------------------------------------------
let testTransport: EmailTransport | null = null

/** Override the transport in tests (capture sent mail). Pass null to restore
 *  real provider resolution. */
export function _setEmailTransportForTests(t: EmailTransport | null): void {
  testTransport = t
}

// --- helpers ---------------------------------------------------------------

function emailFrom(): string {
  return (process.env.EMAIL_FROM ?? "").trim() || "Edge Agent AI <onboarding@resend.dev>"
}

/** App base URL for building links. Trailing slash trimmed. */
export function appBaseUrl(): string {
  const url = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/+$/, "")
  return url || "http://localhost:3000"
}

export function verifyEmailLink(token: string): string {
  return `${appBaseUrl()}/auth/verify-email?token=${encodeURIComponent(token)}`
}

export function resetPasswordLink(token: string): string {
  return `${appBaseUrl()}/auth/reset-password?token=${encodeURIComponent(token)}`
}

/** Recipient domain only — used for safe-to-log diagnostics. */
function recipientDomain(to: string): string {
  const at = to.lastIndexOf("@")
  return at >= 0 ? to.slice(at + 1) : "(none)"
}

/** Is a real email provider configured? */
export function emailConfigured(): boolean {
  if (testTransport) return true
  if ((process.env.RESEND_API_KEY ?? "").trim()) return true
  if ((process.env.SMTP_HOST ?? "").trim()) return true
  return false
}

// --- transports ------------------------------------------------------------

function resendTransport(apiKey: string): EmailTransport {
  return {
    name: "resend",
    async send(msg) {
      const res = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: emailFrom(),
          to: [msg.to],
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
        }),
      })
      if (!res.ok) {
        // Read a short status only — never echo the body (could be reflected).
        throw new Error(`resend responded HTTP ${res.status}`)
      }
    },
  }
}

function smtpTransport(): EmailTransport {
  return {
    name: "smtp",
    async send(msg) {
      // nodemailer is an OPTIONAL peer dep. Dynamic import keeps it out of the
      // bundle unless SMTP is actually used. Install with `pnpm add nodemailer`.
      const dynImport = new Function("p", "return import(p)") as (p: string) => Promise<unknown>
      let nodemailer: {
        createTransport: (cfg: unknown) => { sendMail: (m: unknown) => Promise<unknown> }
      }
      try {
        nodemailer = (await dynImport("nodemailer")) as typeof nodemailer
      } catch {
        throw new Error("SMTP requested but 'nodemailer' is not installed (pnpm add nodemailer)")
      }
      const port = Number(process.env.SMTP_PORT ?? 587)
      const transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure: port === 465,
        auth:
          process.env.SMTP_USER || process.env.SMTP_PASS
            ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
            : undefined,
      })
      await transport.sendMail({
        from: emailFrom(),
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      })
    },
  }
}

function resolveTransport(): EmailTransport | null {
  if (testTransport) return testTransport
  const resendKey = (process.env.RESEND_API_KEY ?? "").trim()
  if (resendKey) return resendTransport(resendKey)
  if ((process.env.SMTP_HOST ?? "").trim()) return smtpTransport()
  return null
}

/**
 * Send an email. Returns a result instead of throwing so callers (auth routes)
 * can stay generic and never leak provider failures. Logs only metadata —
 * never the body, link, or token.
 */
export async function sendEmail(msg: EmailMessage): Promise<EmailResult> {
  const transport = resolveTransport()
  if (!transport) {
    // Misconfiguration in production; harmless in dev (token may be surfaced
    // in the response when EDGE_AGENT_RETURN_AUTH_TOKENS=1).
    if (process.env.NODE_ENV === "production") {
      console.error(
        `[email] no provider configured — set RESEND_API_KEY or SMTP_HOST (to=${recipientDomain(msg.to)})`,
      )
    }
    return { ok: false, provider: "none", error: "email_provider_unconfigured" }
  }
  try {
    await transport.send(msg)
    return { ok: true, provider: transport.name }
  } catch (e) {
    const error = e instanceof Error ? e.message : "send_failed"
    // Safe metadata only — the message body / token are never logged.
    console.error(`[email] send failed via ${transport.name} to ${recipientDomain(msg.to)}: ${error}`)
    return { ok: false, provider: transport.name, error }
  }
}

// --- message builders ------------------------------------------------------

const APP = "Edge Agent AI"

export async function sendVerificationEmail(to: string, token: string): Promise<EmailResult> {
  const link = verifyEmailLink(token)
  return sendEmail({
    to,
    subject: `Verify your ${APP} email`,
    text: `Welcome to ${APP}.\n\nVerify your email by opening this link:\n${link}\n\nThis link expires in 24 hours. If you didn't create an account, ignore this email.`,
    html: `<p>Welcome to <strong>${APP}</strong>.</p>
<p>Verify your email by clicking the button below:</p>
<p><a href="${link}" style="display:inline-block;padding:10px 16px;background:#10b981;color:#fff;border-radius:6px;text-decoration:none">Verify email</a></p>
<p>Or paste this link into your browser:<br><a href="${link}">${link}</a></p>
<p style="color:#888;font-size:12px">This link expires in 24 hours. If you didn't create an account, you can ignore this email.</p>`,
  })
}

export async function sendVerificationCodeEmail(to: string, code: string): Promise<EmailResult> {
  return sendEmail({
    to,
    subject: `Your ${APP} verification code: ${code}`,
    text: `Welcome to ${APP}.\n\nYour email verification code is:\n\n${code}\n\nEnter it in the app to verify your email. This code expires in 15 minutes. If you didn't create an account, you can ignore this email.`,
    html: `<p>Welcome to <strong>${APP}</strong>.</p>
<p>Your email verification code is:</p>
<p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:16px 0;color:#10b981">${code}</p>
<p>Enter it in the app to verify your email.</p>
<p style="color:#888;font-size:12px">This code expires in 15 minutes. If you didn't create an account, you can ignore this email.</p>`,
  })
}

export async function sendPasswordResetEmail(to: string, token: string): Promise<EmailResult> {
  const link = resetPasswordLink(token)
  return sendEmail({
    to,
    subject: `Reset your ${APP} password`,
    text: `We received a request to reset your ${APP} password.\n\nReset it by opening this link:\n${link}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email — your password won't change.`,
    html: `<p>We received a request to reset your <strong>${APP}</strong> password.</p>
<p>Choose a new password by clicking the button below:</p>
<p><a href="${link}" style="display:inline-block;padding:10px 16px;background:#3b82f6;color:#fff;border-radius:6px;text-decoration:none">Reset password</a></p>
<p>Or paste this link into your browser:<br><a href="${link}">${link}</a></p>
<p style="color:#888;font-size:12px">This link expires in 1 hour. If you didn't request a reset, you can ignore this email — your password won't change.</p>`,
  })
}
