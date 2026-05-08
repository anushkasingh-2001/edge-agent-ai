"use client"

import { useState } from "react"
import { useTheme } from "next-themes"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { 
  Save,
  Palette,
  ScanSearch,
  GitBranch,
  ChevronDown,
  Webhook,
} from "lucide-react"

export function Settings() {
  const { theme, setTheme } = useTheme()
  const [webhookEnabled, setWebhookEnabled] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [alertDestination, setAlertDestination] = useState("slack")

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-muted-foreground">Configure Edge Agent AI preferences</p>
      </div>

      {/* A. Appearance */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Palette className="h-4 w-4" />
            Appearance
          </CardTitle>
          <CardDescription>Customize the look and feel</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Theme</Label>
            <Select value={theme} onValueChange={setTheme}>
              <SelectTrigger className="w-48 bg-secondary/50">
                <SelectValue placeholder="Select theme" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
                <SelectItem value="system">System</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">
              Choose how Edge Agent AI appears on this device.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* B. Scan Preferences */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ScanSearch className="h-4 w-4" />
            Scan Preferences
          </CardTitle>
          <CardDescription>Configure scanning behavior</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Auto-scan local file changes</Label>
              <p className="text-sm text-muted-foreground">
                Rerun selected checks when files are modified inside the opened local project folder. For GitHub repos, remote changes are scanned after you pull/sync locally.
              </p>
            </div>
            <Switch defaultChecked />
          </div>
          <Separator className="bg-border" />
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Desktop notifications</Label>
              <p className="text-sm text-muted-foreground">
                Show a system notification when critical or high-risk findings are detected.
              </p>
            </div>
            <Switch defaultChecked />
          </div>
        </CardContent>
      </Card>

      {/* C. Git Workflow */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <GitBranch className="h-4 w-4" />
            Git Workflow
          </CardTitle>
          <CardDescription>Configure version control integration</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Run scan before commit</Label>
            </div>
            <Switch defaultChecked />
          </div>
          <Separator className="bg-border" />
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Run scan before push</Label>
            </div>
            <Switch defaultChecked />
          </div>
          <Separator className="bg-border" />
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Warn on critical findings</Label>
            </div>
            <Switch defaultChecked />
          </div>
          <p className="text-sm text-muted-foreground">
            Use these settings to check the selected branch before committing or pushing changes.
          </p>
        </CardContent>
      </Card>

      {/* D. Advanced Integrations */}
      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <Card className="bg-card border-border">
          <CollapsibleTrigger asChild>
            <CardHeader className="cursor-pointer hover:bg-secondary/30 transition-colors rounded-t-lg">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <Webhook className="h-4 w-4" />
                  Advanced Integrations
                </CardTitle>
                <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
              </div>
              <CardDescription>Configure external service integrations</CardDescription>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="space-y-6 pt-0">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Send scan alerts to external tool</Label>
                </div>
                <Switch checked={webhookEnabled} onCheckedChange={setWebhookEnabled} />
              </div>
              {webhookEnabled && (
                <>
                  <Separator className="bg-border" />
                  <div className="space-y-2">
                    <Label>Alert destination</Label>
                    <Select value={alertDestination} onValueChange={setAlertDestination}>
                      <SelectTrigger className="w-48 bg-secondary/50">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="slack">Slack</SelectItem>
                        <SelectItem value="discord">Discord</SelectItem>
                        <SelectItem value="jira">Jira</SelectItem>
                        <SelectItem value="linear">Linear</SelectItem>
                        <SelectItem value="custom">Custom webhook</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="webhook">Webhook URL</Label>
                    <Input 
                      id="webhook" 
                      placeholder="https://hooks.slack.com/..." 
                      className="bg-secondary/50" 
                    />
                    <p className="text-sm text-muted-foreground">
                      Paste the webhook URL from Slack, Discord, Jira, Linear, or your internal system. Edge Agent AI will send scan summaries after scans.
                    </p>
                  </div>
                </>
              )}
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      {/* Save Button */}
      <div className="flex justify-end">
        <Button>
          <Save className="h-4 w-4 mr-2" />
          Save Settings
        </Button>
      </div>
    </div>
  )
}
