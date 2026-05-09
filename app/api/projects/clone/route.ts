import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { NextResponse } from "next/server"
import {
  expandUserPath,
  getScanAllowRoot,
  isPathInside,
} from "@/lib/server-path-utils"

const WORKSPACE_DIR = ".edge-agent-workspace"

function projectIdFromPath(p: string): string {
  let h = 0
  for (let i = 0; i < p.length; i++) {
    h = (h * 31 + p.charCodeAt(i)) | 0
  }
  return `proj_${(h >>> 0).toString(36)}`
}

function repoNameFromUrl(url: string): string {
  const cleaned = url.trim().replace(/\.git$/i, "").replace(/\/$/, "")
  const parts = cleaned.split(/[/:]/)
  const last = parts[parts.length - 1] || "repo"
  return last.replace(/[^a-zA-Z0-9._-]/g, "-") || "repo"
}

function isAllowedGitUrl(url: string): boolean {
  return /^https:\/\/github\.com\//i.test(url) || /^git@github\.com:/i.test(url)
}

/** Compare two git URLs ignoring `.git`, trailing `/`, host case, and http/https/ssh form. */
function normaliseGitUrl(url: string): string {
  let u = url.trim().toLowerCase()
  u = u.replace(/\.git$/, "")
  u = u.replace(/\/$/, "")
  // git@github.com:owner/repo  -> github.com/owner/repo
  u = u.replace(/^git@([^:]+):/, "$1/")
  // https://github.com/owner/repo -> github.com/owner/repo
  u = u.replace(/^https?:\/\//, "")
  return u
}

function gitOriginUrl(dir: string): string | null {
  if (!fs.existsSync(path.join(dir, ".git"))) return null
  try {
    const proc = spawnSync(
      "git",
      ["-C", dir, "remote", "get-url", "origin"],
      { encoding: "utf-8", maxBuffer: 1024 * 1024 }
    )
    if (proc.status !== 0) return null
    return proc.stdout.trim() || null
  } catch {
    return null
  }
}

function gitCurrentBranch(dir: string): string | null {
  try {
    const proc = spawnSync(
      "git",
      ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"],
      { encoding: "utf-8", maxBuffer: 1024 * 1024 }
    )
    if (proc.status !== 0) return null
    const out = proc.stdout.trim()
    return out && out !== "HEAD" ? out : null
  } catch {
    return null
  }
}

function nextAvailableTarget(parent: string, baseName: string): string {
  const first = path.join(parent, baseName)
  if (!fs.existsSync(first)) return first
  for (let i = 2; i <= 99; i++) {
    const candidate = path.join(parent, `${baseName}-${i}`)
    if (!fs.existsSync(candidate)) return candidate
  }
  return path.join(parent, `${baseName}-${Date.now()}`)
}

export async function POST(request: Request) {
  let body: {
    githubUrl?: string
    url?: string
    branch?: string | null
    parentPath?: string
  } = {}
  try {
    body = await request.json()
  } catch {
    body = {}
  }

  const rawUrl =
    typeof body.githubUrl === "string"
      ? body.githubUrl
      : typeof body.url === "string"
        ? body.url
        : ""
  const url = rawUrl.trim()
  const branch =
    typeof body.branch === "string" && body.branch.trim() ? body.branch.trim() : null

  if (!url) {
    return NextResponse.json(
      { ok: false, error: "githubUrl is required" },
      { status: 400 }
    )
  }
  if (!isAllowedGitUrl(url)) {
    return NextResponse.json(
      {
        ok: false,
        error: "URL must start with https://github.com/ or git@github.com:",
      },
      { status: 400 }
    )
  }

  const allowRoot = getScanAllowRoot()

  const parentRaw =
    typeof body.parentPath === "string" && body.parentPath.trim()
      ? body.parentPath.trim()
      : path.join(allowRoot, WORKSPACE_DIR)

  let parentResolved: string
  try {
    parentResolved = path.resolve(expandUserPath(parentRaw))
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid parent path" },
      { status: 400 }
    )
  }
  if (!isPathInside(parentResolved, allowRoot)) {
    return NextResponse.json(
      { ok: false, error: "Parent path is outside the allowed directory" },
      { status: 403 }
    )
  }

  try {
    fs.mkdirSync(parentResolved, { recursive: true })
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: `Could not create destination: ${
          e instanceof Error ? e.message : "unknown error"
        }`,
      },
      { status: 500 }
    )
  }

  const baseName = repoNameFromUrl(url)
  const firstChoice = path.join(parentResolved, baseName)

  // Case 1: target already exists and IS a clone of the same repo → reuse it.
  if (fs.existsSync(firstChoice)) {
    const existingOrigin = gitOriginUrl(firstChoice)
    if (
      existingOrigin &&
      normaliseGitUrl(existingOrigin) === normaliseGitUrl(url)
    ) {
      const detectedBranch = gitCurrentBranch(firstChoice) ?? branch ?? "main"
      const project = {
        id: projectIdFromPath(firstChoice),
        name: baseName,
        path: firstChoice,
        source: "github" as const,
        githubUrl: url,
        branch: detectedBranch,
        lastOpenedAt: new Date().toISOString(),
      }
      return NextResponse.json({ ok: true as const, project, reused: true })
    }
  }

  // Case 2: target taken by something else → pick a fresh suffixed name.
  const targetDir = nextAvailableTarget(parentResolved, baseName)

  // `--depth 1` keeps the clone fast, but on its own it implies
  // `--single-branch`, which means only the requested branch ends up under
  // refs/remotes/origin/*. The branch picker would then look broken on big
  // repos like openclaw (1500+ branches → only `main` listed).
  // `--no-single-branch` overrides that: we still fetch only the latest commit
  // of each branch, but we get a remote-tracking ref for every branch so the
  // UI can list them.
  const args = ["clone", "--depth", "1", "--no-single-branch"]
  if (branch) {
    args.push("--branch", branch)
  }
  args.push(url, targetDir)

  const proc = spawnSync("git", args, {
    encoding: "utf-8",
    maxBuffer: 20 * 1024 * 1024,
  })

  if (proc.error || proc.status !== 0) {
    try {
      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true })
      }
    } catch {
      /* ignore */
    }
    return NextResponse.json(
      {
        ok: false,
        error: "git clone failed",
        stderr: proc.stderr?.slice(0, 4000),
      },
      { status: 500 }
    )
  }

  const resolved = path.resolve(targetDir)
  if (!isPathInside(resolved, allowRoot)) {
    return NextResponse.json(
      { ok: false, error: "Clone landed outside allowed directory" },
      { status: 500 }
    )
  }

  const project = {
    id: projectIdFromPath(resolved),
    name: path.basename(resolved),
    path: resolved,
    source: "github" as const,
    githubUrl: url,
    branch: branch ?? "main",
    lastOpenedAt: new Date().toISOString(),
  }

  return NextResponse.json({ ok: true as const, project })
}
