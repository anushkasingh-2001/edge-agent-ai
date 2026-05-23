/**
 * Single source of truth for severity badge colours.
 *
 * Used by the finding drawer, the Findings table row, and the new
 * workspace side-panel so a single rename here updates every place
 * we render a severity badge.
 */

export type Severity = "critical" | "high" | "medium" | "low" | string

export function severityBadgeClass(severity: Severity): string {
  switch (severity) {
    case "critical":
      return "bg-red-500/10 text-red-400 border-red-500/20"
    case "high":
      return "bg-orange-500/10 text-orange-400 border-orange-500/20"
    case "medium":
      return "bg-yellow-500/10 text-yellow-400 border-yellow-500/20"
    case "low":
      return "bg-blue-500/10 text-blue-400 border-blue-500/20"
    default:
      return ""
  }
}

export function severityIconColor(severity: Severity): string {
  switch (severity) {
    case "critical":
      return "text-red-400"
    case "high":
      return "text-orange-400"
    case "medium":
      return "text-yellow-400"
    case "low":
      return "text-blue-400"
    default:
      return "text-muted-foreground"
  }
}
