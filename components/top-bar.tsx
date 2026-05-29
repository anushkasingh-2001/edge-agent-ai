"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  ChevronDown,
  GitBranch,
  GitCompare,
  Download,
  Upload,
  Play,
  Bot,
  Check,
  Wrench,
  GitPullRequest,
  ArrowUpFromLine,
  Mail,
} from "lucide-react"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { toast } from "sonner"
import { ExportReportButton } from "@/components/export-report-button"
import {
  ALL_AGENTS_OPTION,
  type TopBarAgentOption,
  type AgentToolGroup,
  type ScanReport,
} from "@/lib/scan-report"
import type { Project } from "@/lib/projects"
import type { PolicyApiResponse } from "@/lib/policy-client"
import { fetchGitStatus, type GitStatusResponse } from "@/lib/git-client"
import { setOnLoginRequired } from "@/lib/api-fetch"
import {
  CommitDialog,
  PullConfirmDialog,
  PushConfirmDialog,
} from "@/components/git-ops-dialogs"
import { CreatePrDialog } from "@/components/git-pr-dialog"
import {
  GithubAuthBadge,
  GithubLoginDialog,
} from "@/components/github-login-dialog"
import { AccountAuthDialog } from "@/components/account-auth-dialog"
import {
  fetchGitHubAuthStatus,
  type GitHubAuthStatusResponse,
} from "@/lib/github-client"
import { fetchAccount, type AccountPlan, type AccountUser } from "@/lib/plan-client"

interface TopBarProps {
  projectName: string
  currentBranch: string
  onBranchChange: (branch: string) => void
  selectedAgents: string[]
  onAgentChange: (agents: string[]) => void
  riskScore: number
  onRunScan: () => void
  onNavigateToBranchCompare: () => void
  agentOptions?: TopBarAgentOption[]
  /** Per-agent tool inventory shown in the Tools picker next to All Agents.
   * Empty when no scan has been run. */
  toolsInventory?: AgentToolGroup[]
  /** Total tool count across all agents (sum of `toolsInventory[].paths`). */
  totalToolCount?: number
  /** Whether a real scan report is loaded (drives Tools button enabled state). */
  hasScan?: boolean
  /** Whether a project is currently opened. Drives whether the branch
   * dropdown is interactable. */
  hasProject?: boolean
  /** Combined branch list (local + remote-tracking, deduped server-side).
   * Empty when the folder isn't a Git repo or no project is opened. */
  branches?: string[]
  /** Subset of `branches` that exist only as remote-tracking refs (not yet
   * checked out locally). Used to render a small "remote" badge. */
  remoteOnlyBranches?: string[]
  /** The repo's actual checked-out branch, if known. Marked with a HEAD badge
   * so users can tell which one Git considers current. */
  gitCurrentBranch?: string | null
  /** Whether the opened folder is a Git repository. */
  isGitRepo?: boolean
  /** Branches are being fetched from /api/git/branches. */
  gitLoading?: boolean
  /** Latest scan report — drives the Export Report button. */
  scanReport?: ScanReport | null
  /** Selected project — used in the export filename / markdown header. */
  project?: Project | null
  /** Latest policy evaluation. When present the Export Report dropdown
   *  grows two extra "Export policy report" options. Optional so the
   *  top-bar works fine before a policy evaluation has run. */
  policyResponse?: PolicyApiResponse | null
  /**
   * Called after a successful Pull / Commit / Push so the parent can
   * re-fetch the branch list and update headline state. Optional —
   * top-bar will still refresh its own local git status either way.
   */
  onGitOpComplete?: () => void
}

const defaultAgents: TopBarAgentOption[] = [ALL_AGENTS_OPTION]

function getRiskLevel(score: number): { label: string; color: string } {
  if (score >= 86) return { label: "Critical", color: "text-red-400" }
  if (score >= 61) return { label: "High", color: "text-orange-400" }
  if (score >= 31) return { label: "Medium", color: "text-yellow-400" }
  return { label: "Low", color: "text-green-400" }
}

function getRiskBadgeColor(score: number): string {
  if (score >= 86) return "border-red-500/50 text-red-400 bg-red-500/10"
  if (score >= 61) return "border-orange-500/50 text-orange-400 bg-orange-500/10"
  if (score >= 31) return "border-yellow-500/50 text-yellow-400 bg-yellow-500/10"
  return "border-green-500/50 text-green-400 bg-green-500/10"
}

export function TopBar({
  projectName,
  currentBranch,
  onBranchChange,
  selectedAgents,
  onAgentChange,
  riskScore,
  onRunScan,
  onNavigateToBranchCompare,
  agentOptions = defaultAgents,
  toolsInventory = [],
  totalToolCount = 0,
  hasScan = false,
  hasProject = false,
  branches = [],
  remoteOnlyBranches = [],
  gitCurrentBranch = null,
  isGitRepo = false,
  gitLoading = false,
  scanReport = null,
  project = null,
  policyResponse = null,
  onGitOpComplete,
}: TopBarProps) {
  const agents = agentOptions
  const riskInfo = getRiskLevel(riskScore)
  const [branchPickerOpen, setBranchPickerOpen] = useState(false)
  const [toolsPickerOpen, setToolsPickerOpen] = useState(false)
  const [pullOpen, setPullOpen] = useState(false)
  const [commitOpen, setCommitOpen] = useState(false)
  const [pushOpen, setPushOpen] = useState(false)
  const [createPrOpen, setCreatePrOpen] = useState(false)
  const [gitStatus, setGitStatus] = useState<GitStatusResponse | null>(null)
  // Top-bar GitHub auth indicator. Refreshed on mount and after the
  // sign-in dialog reports a change so the badge flips from "Sign in"
  // to "@user" without a page reload.
  const [signInOpen, setSignInOpen] = useState(false)
  const [ghAuth, setGhAuth] = useState<GitHubAuthStatusResponse | null>(null)
  // Edge Agent AI account — the identity of record for plan + credits. The
  // GitHub badge below is a SEPARATE, optional integration.
  const [accountOpen, setAccountOpen] = useState(false)
  const [account, setAccount] = useState<AccountUser | null>(null)
  const [accountPlan, setAccountPlan] = useState<AccountPlan | null>(null)
  const refreshGhAuth = useCallback(async () => {
    try {
      const s = await fetchGitHubAuthStatus()
      setGhAuth(s)
    } catch {
      setGhAuth(null)
    }
  }, [])
  const refreshAccount = useCallback(async () => {
    try {
      const a = await fetchAccount()
      setAccount(a?.user ?? null)
      setAccountPlan(a?.plan ?? null)
    } catch {
      setAccount(null)
      setAccountPlan(null)
    }
  }, [])
  useEffect(() => {
    void refreshGhAuth()
    void refreshAccount()
  }, [refreshGhAuth, refreshAccount])

  // When a cloud request returns 401 (account session expired/cleared), the
  // account can't be silently re-authenticated — prompt an account re-login by
  // opening the Edge Agent AI account dialog.
  useEffect(() => {
    setOnLoginRequired(() => {
      toast.error("Session expired", {
        description: "Sign in to your Edge Agent AI account to keep using hosted AI.",
      })
      setAccountOpen(true)
    })
    return () => setOnLoginRequired(null)
  }, [])

  // Fetch a lightweight git status snapshot so the dialogs can show
  // working-tree state and the pull button can pre-warn on uncommitted
  // changes without opening the modal first. Re-runs whenever the
  // project, branch, or repo-state inputs change.
  const refreshLocalGitStatus = useCallback(async () => {
    if (!project?.path || !isGitRepo) {
      setGitStatus(null)
      return
    }
    try {
      const s = await fetchGitStatus(project.path)
      setGitStatus(s)
    } catch {
      setGitStatus(null)
    }
  }, [project?.path, isGitRepo])

  useEffect(() => {
    void refreshLocalGitStatus()
  }, [refreshLocalGitStatus, currentBranch])

  const handleAfterGitOp = useCallback(() => {
    void refreshLocalGitStatus()
    onGitOpComplete?.()
  }, [refreshLocalGitStatus, onGitOpComplete])
  const remoteOnlySet = useMemo(
    () => new Set(remoteOnlyBranches),
    [remoteOnlyBranches]
  )
  const toolsButtonLabel = !hasProject
    ? "Tools"
    : !hasScan
      ? "Tools"
      : `Tools (${totalToolCount})`
  const toolsTriggerDisabled = !hasProject || !hasScan
  const selectedAgentNames = selectedAgents.includes("all")
    ? "All Agents"
    : selectedAgents.length === 1
      ? agents.find((a) => a.id === selectedAgents[0])?.name || "Select Agents"
      : `${selectedAgents.length} Agents`

  // Decide what the branch button shows. With no project, fall back to a
  // disabled placeholder so we don't pretend a branch is checked out.
  const branchButtonLabel = !hasProject
    ? "No project"
    : gitLoading
      ? "Loading branches..."
      : !isGitRepo
        ? "Not a Git repo"
        : currentBranch || gitCurrentBranch || "(no branch)"
  const branchTriggerDisabled = !hasProject || gitLoading
  const hasRealBranches = isGitRepo && branches.length > 0

  const toggleAgent = (agentId: string) => {
    if (agentId === "all") {
      onAgentChange(["all"])
    } else {
      const newAgents = selectedAgents.filter(id => id !== "all")
      if (newAgents.includes(agentId)) {
        const filtered = newAgents.filter(id => id !== agentId)
        onAgentChange(filtered.length > 0 ? filtered : ["all"])
      } else {
        onAgentChange([...newAgents, agentId])
      }
    }
  }

  // Top bar wraps to a second row at narrow widths instead of clipping.
  // `min-h-14` keeps the original 56px height at wide widths and lets it grow
  // when children wrap; `flex-wrap` + `gap-y-2` makes the right cluster drop
  // under the left cluster instead of being pushed off-screen. At ≥~1450px the
  // layout is visually identical to before.
  return (
    <div className="min-h-14 border-b border-border bg-card/50 backdrop-blur-sm px-4 py-2 flex flex-wrap items-center justify-between gap-y-2">
      {/* Left Section: Project Name, Branch, Agents */}
      <div className="flex flex-wrap items-center gap-4 gap-y-2">
        {/* Project Name */}
        <span className="text-sm font-medium">{projectName}</span>

        <div className="h-6 w-px bg-border" />

        {/* Branch Selector — Popover + Command (cmdk) so we can search across
            hundreds/thousands of branches like the GitHub picker does. */}
        <Popover open={branchPickerOpen} onOpenChange={setBranchPickerOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="gap-2 bg-secondary/50"
              disabled={branchTriggerDisabled}
            >
              <GitBranch className="h-4 w-4" />
              <span className="max-w-[160px] truncate">{branchButtonLabel}</span>
              <ChevronDown className="h-3 w-3" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 p-0">
            {!hasProject ? (
              <div className="p-3 text-xs text-muted-foreground">
                Open a project to see branches.
              </div>
            ) : gitLoading ? (
              <div className="p-3 text-xs text-muted-foreground">
                Loading branches...
              </div>
            ) : !isGitRepo ? (
              <div className="p-3 text-xs text-muted-foreground">
                This folder is not a Git repository.
              </div>
            ) : branches.length === 0 ? (
              <div className="p-3 text-xs text-muted-foreground">
                No branches found.
              </div>
            ) : (
              <Command>
                <CommandInput
                  placeholder={`Search ${branches.length} branch${branches.length === 1 ? "" : "es"}...`}
                />
                <CommandList className="max-h-[320px]">
                  <CommandEmpty>No matching branch.</CommandEmpty>
                  <CommandGroup heading="Branches">
                    {branches.map((branch) => {
                      const isHead = branch === gitCurrentBranch
                      const isSelected = branch === currentBranch
                      const isRemoteOnly = remoteOnlySet.has(branch)
                      return (
                        <CommandItem
                          key={branch}
                          // cmdk lowercases the value passed to onSelect, so
                          // close over `branch` instead of relying on the arg.
                          value={branch}
                          onSelect={() => {
                            onBranchChange(branch)
                            setBranchPickerOpen(false)
                          }}
                          className="gap-2"
                        >
                          <GitBranch className="h-4 w-4 shrink-0" />
                          <span className="flex-1 truncate">{branch}</span>
                          {isRemoteOnly && (
                            <Badge
                              variant="outline"
                              className="text-[10px] px-1 py-0 border-muted-foreground/40 text-muted-foreground"
                            >
                              remote
                            </Badge>
                          )}
                          {isHead && (
                            <Badge
                              variant="outline"
                              className="text-[10px] px-1 py-0 border-accent/40 text-accent"
                            >
                              HEAD
                            </Badge>
                          )}
                          {isSelected && (
                            <Check className="h-4 w-4 text-accent" />
                          )}
                        </CommandItem>
                      )
                    })}
                  </CommandGroup>
                  <CommandGroup>
                    <CommandItem
                      value="__compare_branches__"
                      onSelect={() => {
                        setBranchPickerOpen(false)
                        onNavigateToBranchCompare()
                      }}
                      disabled={!hasRealBranches}
                      className="gap-2"
                    >
                      <GitCompare className="h-4 w-4" />
                      <span>Compare Branches</span>
                    </CommandItem>
                  </CommandGroup>
                </CommandList>
              </Command>
            )}
          </PopoverContent>
        </Popover>

        {/* Agent Selector */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-2 bg-secondary/50">
              <Bot className="h-4 w-4" />
              <span className="max-w-[120px] truncate">{selectedAgentNames}</span>
              <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Detected Agents
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {agents.map((agent) => (
              <DropdownMenuItem
                key={agent.id}
                onClick={() => toggleAgent(agent.id)}
                className="flex-col items-start gap-1 py-2"
              >
                <div className="flex items-center justify-between w-full">
                  <div className="flex items-center gap-2">
                    <div className={`w-4 h-4 rounded border flex items-center justify-center ${
                      selectedAgents.includes(agent.id) || (agent.id !== "all" && selectedAgents.includes("all"))
                        ? "bg-accent border-accent"
                        : "border-border"
                    }`}>
                      {(selectedAgents.includes(agent.id) || (agent.id !== "all" && selectedAgents.includes("all"))) && (
                        <Check className="h-3 w-3 text-accent-foreground" />
                      )}
                    </div>
                    <span className="font-medium">{agent.name}</span>
                  </div>
                  {agent.id !== "all" && (
                    <Badge variant="outline" className={`text-xs ${getRiskBadgeColor(agent.risk)}`}>
                      {agent.risk}/100
                    </Badge>
                  )}
                </div>
                {agent.id !== "all" && (
                  <div className="text-xs text-muted-foreground pl-6 flex gap-3">
                    <span>{agent.framework}</span>
                    <span>{agent.tools} tools</span>
                    <span>{agent.prompts} prompts</span>
                  </div>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Tools Inventory — total tool count across the project, with a
            per-agent (framework) breakdown of the file paths that count as
            tools. Searchable so big inventories like MCP (272) stay usable. */}
        <Popover open={toolsPickerOpen} onOpenChange={setToolsPickerOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="gap-2 bg-secondary/50"
              disabled={toolsTriggerDisabled}
              title={
                !hasProject
                  ? "Open a project first"
                  : !hasScan
                    ? "Run a scan to populate tools"
                    : `${totalToolCount} tools detected`
              }
            >
              <Wrench className="h-4 w-4" />
              <span className="max-w-[120px] truncate">{toolsButtonLabel}</span>
              <ChevronDown className="h-3 w-3" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-96 p-0">
            {!hasProject ? (
              <div className="p-3 text-xs text-muted-foreground">
                Open a project to see detected tools.
              </div>
            ) : !hasScan ? (
              <div className="p-3 text-xs text-muted-foreground">
                Run a scan to populate the tools inventory.
              </div>
            ) : toolsInventory.length === 0 ? (
              <div className="p-3 text-xs text-muted-foreground">
                No tools detected in this project.
              </div>
            ) : (
              <Command>
                <CommandInput
                  placeholder={`Search ${totalToolCount} tool${totalToolCount === 1 ? "" : "s"}...`}
                />
                <CommandList className="max-h-[360px]">
                  <CommandEmpty>No matching tool.</CommandEmpty>
                  {toolsInventory.map((group) => (
                    <CommandGroup
                      key={group.agent}
                      heading={`${group.agent} (${group.tools.length})`}
                    >
                      {group.tools.map((tool) => (
                        <CommandItem
                          key={`${group.agent}::${tool.file}:${tool.line}:${tool.name}`}
                          // Search across name + path + agent + kind so a user
                          // can type any of them. cmdk lowercases the value.
                          value={`${group.agent} ${tool.name} ${tool.file} ${tool.kind}`}
                          onSelect={() => {
                            void navigator.clipboard?.writeText(
                              `${tool.file}:${tool.line}`
                            )
                          }}
                          className="gap-2 items-start py-2"
                          title={`${tool.name}\n${tool.file}:${tool.line}\n(click to copy file:line)`}
                        >
                          <Wrench className="h-3.5 w-3.5 shrink-0 text-muted-foreground mt-0.5" />
                          <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                            <span className="text-sm font-medium truncate">
                              {tool.name}
                            </span>
                            <span className="text-[11px] text-muted-foreground font-mono truncate">
                              {tool.file}:{tool.line}
                            </span>
                          </div>
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1 py-0 border-muted-foreground/30 text-muted-foreground shrink-0"
                          >
                            {tool.kind}
                          </Badge>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  ))}
                </CommandList>
              </Command>
            )}
          </PopoverContent>
        </Popover>

        {/* Risk Score */}
        <Badge variant="outline" className={`${getRiskBadgeColor(riskScore)} font-medium`}>
          {riskScore}/100 {riskInfo.label} Risk
        </Badge>
      </div>

      {/* Right Section: Actions in order: Run Scan, Pull, Commit, Push, Export Report */}
      <TooltipProvider>
        <div className="flex flex-wrap items-center gap-2 gap-y-2">
          {/* Edge Agent AI account — identity of record for plan + credits.
            * Shows the signed-in email, or a "Sign in" button. Clicking opens
            * the account dialog (sign up / sign in / sign out). */}
          {account ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setAccountOpen(true)}
              className="gap-1.5"
              title={
                `Signed in as ${account.email}` +
                (accountPlan
                  ? ` — ${accountPlan.tier} plan, ${Math.max(0, accountPlan.creditsLimit - accountPlan.creditsUsed)} credits left`
                  : "") +
                (account.emailVerified === false ? " — email not verified" : "")
              }
            >
              <Mail className="h-4 w-4" />
              <span className="max-w-[160px] truncate text-xs">{account.email}</span>
              <Badge
                variant="outline"
                className="text-[10px] py-0 capitalize border-emerald-500/40 text-emerald-300"
              >
                {accountPlan?.tier ?? "free"}
              </Badge>
              {accountPlan && (
                <span className="text-[10px] font-mono text-muted-foreground">
                  {Math.max(0, accountPlan.creditsLimit - accountPlan.creditsUsed)} cr
                </span>
              )}
              {account.emailVerified === false && (
                <Badge
                  variant="outline"
                  className="text-[10px] py-0 border-amber-500/40 text-amber-300"
                >
                  unverified
                </Badge>
              )}
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setAccountOpen(true)}>
              <Mail className="h-4 w-4" />
              Sign in
            </Button>
          )}

          {/* GitHub auth indicator. OPTIONAL integration for repo/PR access —
            * it does not affect the account, plan, or credits. Clicking opens
            * the GitHub connect dialog. */}
          <GithubAuthBadge
            status={ghAuth}
            onSignInClick={() => setSignInOpen(true)}
          />

          {/* Run Scan - Primary */}
          <Button onClick={onRunScan} size="sm" className="gap-2">
            <Play className="h-4 w-4" />
            Run Scan
          </Button>

          {/* Pull / Commit / Push.
           *
           * All three are disabled until we have a project that is actually
           * a git repo and a branch to operate on. The actual API calls
           * happen inside the dialogs so we don't fire destructive verbs
           * without a confirmation step. */}
          {(() => {
            const gitDisabled =
              !hasProject || !isGitRepo || !currentBranch || !project?.path
            // INCLUSIVE dirty signal: tracked-modified, any untracked,
            // OR a `git stash` entry on this branch. The status route
            // does the calculation; we just consume the boolean here.
            // Stashes are per-branch — a stash on `main` will trip
            // the yellow dot only when `main` is checked out, never
            // when the user is sitting on `low`.
            const dirty = gitStatus?.workingTreeStatus === "uncommitted"
            const trackedDirty = (gitStatus?.trackedModifiedCount ?? 0) > 0
            const ownUntrackedCount =
              gitStatus?.ownBranchUntrackedCount ?? 0
            const crossBranchCount =
              gitStatus?.crossBranchUntrackedCount ?? 0
            const crossBranchNames =
              gitStatus?.crossBranchUntrackedBranches ?? []
            const stashCount = gitStatus?.currentBranchStashCount ?? 0
            // Pull-context dirtiness EXCLUDES the stash — a stash
            // doesn't conflict with `git pull --ff-only`. Used for
            // the Pull button tooltip so it doesn't yell "commit
            // first" when the only "dirt" is a stash that pull
            // wouldn't touch anyway.
            const pullDirty =
              trackedDirty ||
              ownUntrackedCount > 0 ||
              crossBranchCount > 0
            // Quieter secondary signal: cross-branch leakage. Doesn't
            // light up the yellow dot but a grey dot lets the user
            // know git status would show changes — they're just
            // attributed elsewhere.
            const hasSecondaryOnly = !dirty && crossBranchCount > 0
            const dirtyTooltip = (() => {
              if (!dirty) return null
              const parts: string[] = []
              if (trackedDirty)
                parts.push(
                  `${gitStatus?.trackedModifiedCount} tracked file${
                    gitStatus?.trackedModifiedCount === 1 ? "" : "s"
                  } modified`
                )
              if (ownUntrackedCount > 0)
                parts.push(
                  `${ownUntrackedCount} new file${
                    ownUntrackedCount === 1 ? "" : "s"
                  } on '${currentBranch}'`
                )
              if (crossBranchCount > 0)
                parts.push(
                  `${crossBranchCount} untracked from ${
                    crossBranchNames.length > 0
                      ? crossBranchNames.map((b) => `'${b}'`).join(", ")
                      : "other branches"
                  }`
                )
              if (stashCount > 0)
                parts.push(
                  `${stashCount} stash${
                    stashCount === 1 ? "" : "es"
                  } on '${currentBranch}'`
                )
              return parts.join(" · ")
            })()
            const secondaryTooltip = hasSecondaryOnly
              ? `'${currentBranch}' is clean. ${crossBranchCount} untracked file${
                  crossBranchCount === 1 ? "" : "s"
                } belong${crossBranchCount === 1 ? "s" : ""} to ${
                  crossBranchNames.length > 0
                    ? crossBranchNames.map((b) => `'${b}'`).join(", ")
                    : "other branches"
                } and won't be committed here.`
              : null
            return (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      disabled={gitDisabled}
                      onClick={() => setPullOpen(true)}
                    >
                      <Download className="h-4 w-4" />
                      Pull
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>
                      {gitDisabled
                        ? "Open a Git repo to enable pull"
                        : pullDirty
                          ? "Working tree has uncommitted changes — commit/stash first"
                          : `Pull latest changes for '${currentBranch}'`}
                    </p>
                  </TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      disabled={gitDisabled}
                      onClick={() => {
                        void refreshLocalGitStatus()
                        setCommitOpen(true)
                      }}
                    >
                      <Upload className="h-4 w-4" />
                      Commit
                      {dirty && (
                        <span
                          className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-yellow-400"
                          title={dirtyTooltip ?? "Uncommitted changes"}
                        />
                      )}
                      {hasSecondaryOnly && (
                        <span
                          className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-muted-foreground/60"
                          title={secondaryTooltip ?? ""}
                        />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>
                      {gitDisabled
                        ? "Open a Git repo to enable commit"
                        : dirty
                          ? `'${currentBranch}' has local changes${
                              dirtyTooltip ? `: ${dirtyTooltip}` : ""
                            }`
                          : hasSecondaryOnly
                            ? secondaryTooltip ?? ""
                            : `Commit local changes ('${currentBranch}' is currently clean)`}
                    </p>
                  </TooltipContent>
                </Tooltip>

                {/* Push — raw `git push origin <branch>` through the
                 *  same policy gate as Create PR. Useful when the user
                 *  already has an open PR for this branch (or doesn't
                 *  need a PR at all) and just wants their new commits
                 *  to reach origin. The dialog
                 *  (`PushConfirmDialog`) handles the scan toggles,
                 *  permission errors, and policy block / warn
                 *  surfacing — we just open it here. */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      disabled={gitDisabled}
                      onClick={() => {
                        void refreshLocalGitStatus()
                        setPushOpen(true)
                      }}
                    >
                      <ArrowUpFromLine className="h-4 w-4" />
                      Push
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>
                      {gitDisabled
                        ? "Open a Git repo to enable push"
                        : `Run policy gate and push '${currentBranch}' to origin`}
                    </p>
                  </TooltipContent>
                </Tooltip>

                {/* Create PR replaces the old raw Push button. We
                 *  intentionally keep this button enabled at all times
                 *  so users always get feedback when they click it —
                 *  the dialog (or a toast) explains *why* if some
                 *  pre-condition isn't met. A disabled button with no
                 *  feedback was the previous bug source ("button not
                 *  clickable"). */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="sm"
                      className="gap-2"
                      onClick={() => {
                        if (!hasProject || !project?.path) {
                          toast.error(
                            "Open a project before creating a pull request."
                          )
                          return
                        }
                        if (!isGitRepo) {
                          toast.error(
                            "This folder is not a Git repository — initialise it with `git init` first."
                          )
                          return
                        }
                        if (!currentBranch) {
                          toast.error(
                            "No branch is currently selected. Pick a branch in the top bar first."
                          )
                          return
                        }
                        setCreatePrOpen(true)
                      }}
                    >
                      <GitPullRequest className="h-4 w-4" />
                      Create PR
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>
                      {!hasProject
                        ? "Open a project to create a pull request"
                        : !isGitRepo
                          ? "Folder is not a Git repository"
                          : !currentBranch
                            ? "Pick a branch first"
                            : "Run policy gate, push branch, and open a PR"}
                    </p>
                  </TooltipContent>
                </Tooltip>
              </>
            )
          })()}

          {/* Export Report — dropdown for JSON / Markdown, disabled with
              tooltip when no scan has been loaded yet. */}
          <ExportReportButton
            report={scanReport}
            project={project}
            branch={currentBranch}
            policy={policyResponse}
          />
        </div>
      </TooltipProvider>

      {/* Pull / Commit dialogs strictly need a path + git repo to do
          anything meaningful — keep them gated so they can't crash on
          null props. The Create PR dialog renders its own hard-block
          panel for those cases, so it's mounted unconditionally and
          its open click always opens *something* (avoiding the silent
          "button not clickable" trap). */}
      {project?.path && isGitRepo && currentBranch && (
        <>
          <PullConfirmDialog
            open={pullOpen}
            onOpenChange={(open) => {
              setPullOpen(open)
              if (open) void refreshLocalGitStatus()
            }}
            projectPath={project.path}
            branch={currentBranch}
            // Pull only cares about REAL working-tree dirtiness; a
            // stash sitting in `.git/refs/stash` doesn't conflict
            // with `git pull --ff-only`. So we recompute the
            // status here, deliberately ignoring the stash count.
            workingTreeStatus={
              gitStatus
                ? (gitStatus.trackedModifiedCount ?? 0) > 0 ||
                  (gitStatus.ownBranchUntrackedCount ?? 0) > 0 ||
                  (gitStatus.crossBranchUntrackedCount ?? 0) > 0
                  ? "uncommitted"
                  : "clean"
                : null
            }
            headBranch={gitCurrentBranch}
            onComplete={handleAfterGitOp}
          />
          <CommitDialog
            open={commitOpen}
            onOpenChange={(open) => {
              setCommitOpen(open)
              if (open) void refreshLocalGitStatus()
            }}
            projectPath={project.path}
            branch={currentBranch}
            workingTreeStatus={gitStatus?.workingTreeStatus ?? null}
            latestStashRef={gitStatus?.latestCurrentBranchStashRef ?? null}
            latestStashMessage={
              gitStatus?.latestCurrentBranchStashMessage ?? null
            }
            stashCount={gitStatus?.currentBranchStashCount ?? 0}
            onComplete={handleAfterGitOp}
          />
          <PushConfirmDialog
            open={pushOpen}
            onOpenChange={(open) => {
              setPushOpen(open)
              if (open) void refreshLocalGitStatus()
            }}
            projectPath={project.path}
            branch={currentBranch}
            headBranch={gitCurrentBranch}
            onComplete={handleAfterGitOp}
          />
        </>
      )}
      <CreatePrDialog
        open={createPrOpen}
        onOpenChange={setCreatePrOpen}
        projectPath={project?.path ?? null}
        headBranch={currentBranch || null}
        branches={branches ?? []}
        remoteOnlyBranches={remoteOnlyBranches ?? []}
        onCreated={handleAfterGitOp}
      />
      {/* Edge Agent AI account dialog — the primary sign up / sign in. Always
          mounted so the badge and the login-required handler can open it. */}
      <AccountAuthDialog
        open={accountOpen}
        onOpenChange={setAccountOpen}
        onAuthChanged={() => void refreshAccount()}
      />
      {/* In-app GitHub connect dialog (optional integration). Always mounted so
          the badge in the header can open it regardless of which view is
          active. */}
      <GithubLoginDialog
        open={signInOpen}
        onOpenChange={setSignInOpen}
        onAuthChanged={() => {
          void refreshGhAuth()
          // Refresh git status too — connecting GitHub changes which account
          // is used for permission checks the next time the user
          // hits Pull/Commit/Push.
          void refreshLocalGitStatus()
        }}
      />
    </div>
  )
}
