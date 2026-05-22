/**
 * Parse structured finding explanations emitted by the scanner.
 *
 * Python analyzers join five sections into `reason` using stable headers:
 *   What was detected / Why it can be risky / Why this may be okay / What to verify
 * Suggested fix stays in `suggestedFix` separately.
 */

export type ParsedFindingExplanation = {
  whatDetected: string | null
  whyRisky: string | null
  whyMayBeOk: string | null
  whatToVerify: string | null
  /** True when reason uses the new multi-section format */
  structured: boolean
  /** Fallback: full reason text when not structured */
  legacyReason: string
}

const SECTION_PATTERNS: { key: keyof Omit<ParsedFindingExplanation, "structured" | "legacyReason">; prefix: string }[] = [
  { key: "whatDetected", prefix: "What was detected:" },
  { key: "whyRisky", prefix: "Why it can be risky:" },
  { key: "whyMayBeOk", prefix: "Why this may be okay:" },
  { key: "whatToVerify", prefix: "What to verify:" },
]

export function parseFindingReason(reason: string): ParsedFindingExplanation {
  const trimmed = (reason ?? "").trim()
  if (!trimmed) {
    return {
      whatDetected: null,
      whyRisky: null,
      whyMayBeOk: null,
      whatToVerify: null,
      structured: false,
      legacyReason: "",
    }
  }

  if (!trimmed.includes("What was detected:")) {
    return {
      whatDetected: null,
      whyRisky: null,
      whyMayBeOk: null,
      whatToVerify: null,
      structured: false,
      legacyReason: trimmed,
    }
  }

  const result: ParsedFindingExplanation = {
    whatDetected: null,
    whyRisky: null,
    whyMayBeOk: null,
    whatToVerify: null,
    structured: true,
    legacyReason: trimmed,
  }

  for (let i = 0; i < SECTION_PATTERNS.length; i++) {
    const { key, prefix } = SECTION_PATTERNS[i]
    const start = trimmed.indexOf(prefix)
    if (start < 0) continue

    const contentStart = start + prefix.length
    let end = trimmed.length
    for (let j = i + 1; j < SECTION_PATTERNS.length; j++) {
      const nextIdx = trimmed.indexOf(SECTION_PATTERNS[j].prefix, contentStart)
      if (nextIdx >= 0) {
        end = nextIdx
        break
      }
    }
    const slice = trimmed.slice(contentStart, end).trim()
    result[key] = slice || null
  }

  return result
}

/** User-facing label for presence-warning findings (agent unknown). */
export function isPresenceWarningCategory(category: string): boolean {
  const c = category.toLowerCase()
  return c.includes("presence warning") || c === "dangerous code present"
}

export function presenceWarningBadgeLabel(category: string): string | null {
  if (!isPresenceWarningCategory(category)) return null
  return "Presence warning — not agent-confirmed"
}
