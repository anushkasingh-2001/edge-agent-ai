"use client"

import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { Project } from "@/lib/projects"

interface CloneGithubDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Cloned, no scan. */
  onCloned: (project: Project) => void
  /** Cloned and immediately scan. */
  onClonedAndScan: (project: Project) => void
}

export function CloneGithubDialog({
  open,
  onOpenChange,
  onCloned,
  onClonedAndScan,
}: CloneGithubDialogProps) {
  const [githubUrl, setGithubUrl] = useState("")
  const [branch, setBranch] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setError(null)
      setBusy(false)
    }
  }, [open])

  const doClone = async (): Promise<Project | null> => {
    setError(null)
    if (!githubUrl.trim()) {
      setError("Enter a GitHub URL (https://github.com/... or git@github.com:...).")
      return null
    }
    setBusy(true)
    try {
      const res = await fetch("/api/projects/clone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          githubUrl: githubUrl.trim(),
          branch: branch.trim() || null,
        }),
      })
      // When Turbopack / Next fails to compile the route module, the
      // server responds with a plain-text "Internal Server Error" body
      // (HTTP 500). Calling `res.json()` on that body produces a confusing
      // `Unexpected token 'I'…` error — peek the content-type and fall
      // back to a friendlier message so the user knows what to do.
      const contentType = res.headers.get("content-type") ?? ""
      if (!contentType.includes("application/json")) {
        const text = (await res.text().catch(() => "")).slice(0, 200)
        if (res.status >= 500) {
          throw new Error(
            "The dev server returned a non-JSON error — usually a stale Turbopack cache. " +
              "Stop pnpm dev, run `rm -rf .next`, restart, and try again." +
              (text ? `\n\nServer said: ${text}` : "")
          )
        }
        throw new Error(
          `Unexpected response from the clone API (HTTP ${res.status}).` +
            (text ? ` Server said: ${text}` : "")
        )
      }
      const data = (await res.json()) as {
        ok?: boolean
        project?: Project
        error?: string
        stderr?: string
      }
      if (!res.ok || !data.ok || !data.project) {
        throw new Error(data.error || data.stderr || "Clone failed")
      }
      return data.project
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not clone repository")
      return null
    } finally {
      setBusy(false)
    }
  }

  const handleClone = async () => {
    const project = await doClone()
    if (project) {
      onCloned(project)
      onOpenChange(false)
      setGithubUrl("")
      setBranch("")
    }
  }

  const handleCloneAndScan = async () => {
    const project = await doClone()
    if (project) {
      onClonedAndScan(project)
      onOpenChange(false)
      setGithubUrl("")
      setBranch("")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Clone from GitHub</DialogTitle>
          <DialogDescription>
            Shallow-clones a public repo. Requires <span className="font-mono">git</span> on
            the dev server.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="git-url" className="text-sm">
              GitHub repository URL
            </Label>
            <Input
              id="git-url"
              placeholder="https://github.com/username/repository"
              value={githubUrl}
              onChange={(e) => setGithubUrl(e.target.value)}
              className="bg-secondary/50 font-mono text-sm"
              disabled={busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="git-branch" className="text-sm">
              Branch (optional)
            </Label>
            <Input
              id="git-branch"
              placeholder="main"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className="bg-secondary/50 font-mono text-sm"
              disabled={busy}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-sm">Local destination</Label>
            <p className="font-mono text-xs bg-secondary/40 border border-border rounded-md px-2 py-1.5">
              .edge-agent-workspace/&lt;repo-name&gt;
            </p>
          </div>
          {error ? (
            <p className="text-sm text-destructive border border-destructive/30 rounded-md p-2 bg-destructive/10">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter className="gap-2 flex-wrap">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() => void handleClone()}
            disabled={busy || !githubUrl.trim()}
          >
            {busy ? "Cloning…" : "Clone"}
          </Button>
          <Button
            onClick={() => void handleCloneAndScan()}
            disabled={busy || !githubUrl.trim()}
          >
            {busy ? "Cloning…" : "Clone and Scan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
