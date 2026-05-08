"use client"

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { 
  MessageSquare, 
  Eye, 
  Check, 
  X, 
  TestTube,
  FileCode,
  AlertTriangle,
  Lightbulb,
  Code
} from "lucide-react"
import type { Finding } from "@/components/views/findings"

interface FindingDrawerProps {
  finding: Finding | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function FindingDrawer({ finding, open, onOpenChange }: FindingDrawerProps) {
  if (!finding) return null

  const severityBadgeClass = (severity: string) => {
    switch (severity) {
      case "critical": return "bg-red-500/10 text-red-400 border-red-500/20"
      case "high": return "bg-orange-500/10 text-orange-400 border-orange-500/20"
      case "medium": return "bg-yellow-500/10 text-yellow-400 border-yellow-500/20"
      case "low": return "bg-blue-500/10 text-blue-400 border-blue-500/20"
      default: return ""
    }
  }

  const severityIcon = (severity: string) => {
    const colorClass = severity === "critical" ? "text-red-400" :
                      severity === "high" ? "text-orange-400" :
                      severity === "medium" ? "text-yellow-400" : "text-blue-400"
    return <AlertTriangle className={`h-5 w-5 ${colorClass}`} />
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[600px] sm:max-w-[600px] bg-card border-border overflow-y-auto">
        <SheetHeader className="space-y-4">
          <div className="flex items-start gap-3">
            {severityIcon(finding.severity)}
            <div className="flex-1">
              <SheetTitle className="text-lg font-semibold leading-tight">
                {finding.title}
              </SheetTitle>
              <div className="flex items-center gap-2 mt-2">
                <Badge variant="outline" className={severityBadgeClass(finding.severity)}>
                  {finding.severity}
                </Badge>
                <Badge variant="outline" className="bg-secondary/50">
                  {finding.category}
                </Badge>
              </div>
            </div>
          </div>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          {/* Location */}
          <div className="flex items-center gap-4 p-3 rounded-lg bg-secondary/30">
            <FileCode className="h-4 w-4 text-muted-foreground" />
            <div className="flex-1">
              <div className="font-mono text-sm">{finding.file}:{finding.line}</div>
              {finding.agent !== "—" && (
                <div className="text-xs text-muted-foreground">Agent: {finding.agent}</div>
              )}
            </div>
          </div>

          <Separator className="bg-border" />

          {/* Why this is risky */}
          <div className="space-y-2">
            <h3 className="text-sm font-medium flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-orange-400" />
              Why this is risky
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {finding.reason}
            </p>
          </div>

          {/* Evidence */}
          <div className="space-y-2">
            <h3 className="text-sm font-medium flex items-center gap-2">
              <Eye className="h-4 w-4 text-blue-400" />
              Evidence
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {finding.evidence}
            </p>
          </div>

          {/* Code Snippet */}
          <div className="space-y-2">
            <h3 className="text-sm font-medium flex items-center gap-2">
              <Code className="h-4 w-4 text-muted-foreground" />
              Code Involved
            </h3>
            <pre className="p-4 rounded-lg bg-[#0d0d0d] border border-border text-sm font-mono overflow-x-auto">
              <code className="text-green-400">{finding.code}</code>
            </pre>
          </div>

          {/* Suggested Fix */}
          <div className="space-y-2">
            <h3 className="text-sm font-medium flex items-center gap-2">
              <Lightbulb className="h-4 w-4 text-yellow-400" />
              Suggested Fix
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {finding.suggestedFix}
            </p>
          </div>

          <Separator className="bg-border" />

          {/* Actions */}
          <div className="grid grid-cols-2 gap-3">
            <Button variant="outline" className="justify-start">
              <MessageSquare className="h-4 w-4 mr-2" />
              Ask Chat
            </Button>
            <Button variant="outline" className="justify-start">
              <Eye className="h-4 w-4 mr-2" />
              Preview Fix
            </Button>
            <Button className="justify-start">
              <Check className="h-4 w-4 mr-2" />
              Apply Fix
            </Button>
            <Button variant="outline" className="justify-start text-muted-foreground">
              <X className="h-4 w-4 mr-2" />
              Ignore
            </Button>
          </div>

          <Button variant="outline" className="w-full justify-start">
            <TestTube className="h-4 w-4 mr-2" />
            Create Test for This Issue
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
