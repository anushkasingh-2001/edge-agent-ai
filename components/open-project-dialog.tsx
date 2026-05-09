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
import { projectIdFromPath, type Project } from "@/lib/projects"

interface OpenProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called when project is opened (no scan). */
  onOpenProject: (project: Project) => void
  /** Called when user wants to open and scan immediately. */
  onOpenAndScan: (project: Project) => void
}

export function OpenProjectDialog({
  open,
  onOpenChange,
  onOpenProject,
  onOpenAndScan,
}: OpenProjectDialogProps) {
  const [projectPath, setProjectPath] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setError(null)
      setBusy(false)
    }
  }, [open])

  const validate = async (): Promise<Project | null> => {
    setError(null)
    if (!projectPath.trim()) {
      setError("Enter an absolute path to your project folder.")
      return null
    }
    setBusy(true)
    try {
      const res = await fetch("/api/projects/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectPath }),
      })
      const data = (await res.json()) as {
        ok?: boolean
        name?: string
        path?: string
        error?: string
      }
      if (!res.ok || !data.ok || !data.path || !data.name) {
        throw new Error(data.error || "Could not open project")
      }
      const project: Project = {
        id: projectIdFromPath(data.path),
        name: data.name,
        path: data.path,
        source: "local",
        lastOpenedAt: new Date().toISOString(),
      }
      return project
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open project")
      return null
    } finally {
      setBusy(false)
    }
  }

  const handleOpen = async () => {
    const project = await validate()
    if (project) {
      onOpenProject(project)
      onOpenChange(false)
      setProjectPath("")
    }
  }

  const handleOpenAndScan = async () => {
    const project = await validate()
    if (project) {
      onOpenAndScan(project)
      onOpenChange(false)
      setProjectPath("")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Open Local Project</DialogTitle>
          <DialogDescription>
            Enter the absolute path to your project root. The Python scanner will run
            against this directory only.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="project-path" className="text-sm">
              Local project path
            </Label>
            <Input
              id="project-path"
              placeholder="/Users/anushka/Desktop/EDGE_AGENT_AI/edge-agent-ai/sample-agent"
              value={projectPath}
              onChange={(e) => setProjectPath(e.target.value)}
              className="bg-secondary/50 font-mono text-sm"
              disabled={busy}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleOpen()
              }}
            />
          </div>
          {error ? (
            <p className="text-sm text-destructive border border-destructive/30 rounded-md p-2 bg-destructive/10">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() => void handleOpen()}
            disabled={busy || !projectPath.trim()}
          >
            Open Project
          </Button>
          <Button
            onClick={() => void handleOpenAndScan()}
            disabled={busy || !projectPath.trim()}
          >
            {busy ? "Working…" : "Open and Scan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
