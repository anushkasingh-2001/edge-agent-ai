"use client"

import {
  LayoutDashboard,
  ScanSearch,
  AlertTriangle,
  GitCompare,
  MessageSquare,
  TestTube,
  Activity,
  Bot,
  Settings,
  ChevronDown,
  FolderOpen,
  Github,
  FolderPlus,
  Gauge,
} from "lucide-react"
import Image from "next/image"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Badge } from "@/components/ui/badge"
import type { Project } from "@/lib/projects"

export type ViewType =
  | "overview"
  | "scan-center"
  | "detected-agents"
  | "findings"
  | "run-traces"
  | "branch-compare"
  | "evaluations"
  | "prompt-playground"
  | "chat-assistant"
  | "settings"

interface AppSidebarProps {
  currentView: ViewType
  onViewChange: (view: ViewType) => void
  findingsCount?: number
  selectedProject: Project | null
  recentProjects: Project[]
  onSwitchProject: (project: Project) => void
  onOpenLocalProject: () => void
  onCloneFromGithub: () => void
}

const mainNavItems = [
  { id: "overview" as ViewType, label: "Overview", icon: LayoutDashboard },
  { id: "scan-center" as ViewType, label: "Scan Center", icon: ScanSearch },
  { id: "detected-agents" as ViewType, label: "Detected Agents", icon: Bot },
  { id: "findings" as ViewType, label: "Findings", icon: AlertTriangle, badge: true },
  { id: "run-traces" as ViewType, label: "Run Traces", icon: Activity },
  { id: "branch-compare" as ViewType, label: "Branch Compare", icon: GitCompare },
  { id: "evaluations" as ViewType, label: "Evaluations", icon: Gauge },
  { id: "prompt-playground" as ViewType, label: "Prompt Playground", icon: MessageSquare },
  { id: "chat-assistant" as ViewType, label: "Chat Assistant", icon: TestTube },
]

const bottomNavItems = [
  { id: "settings" as ViewType, label: "Settings", icon: Settings },
]

export function AppSidebar({
  currentView,
  onViewChange,
  findingsCount = 0,
  selectedProject,
  recentProjects,
  onSwitchProject,
  onOpenLocalProject,
  onCloneFromGithub,
}: AppSidebarProps) {
  const triggerLabel = selectedProject?.name ?? "No project opened"
  const others = recentProjects
    .filter((p) => p.path !== selectedProject?.path)
    .slice(0, 8)

  return (
    <div className="w-60 h-full bg-sidebar border-r border-sidebar-border flex flex-col">
      <div className="p-4 border-b border-sidebar-border">
        <div className="flex items-center gap-2 mb-1">
          <Image
            src="https://hebbkx1anhila5yf.public.blob.vercel-storage.com/edge_agent_ai-2ZiMAJND6E8xlZHoIAaqyh3xFOwQv9.png"
            alt="Edge Agent AI"
            width={28}
            height={28}
            className="rounded"
          />
          <span className="font-semibold text-sm">Edge Agent AI</span>
        </div>
        <p className="text-xs text-muted-foreground mb-3">Local Agent Safety Lab</p>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className="w-full justify-between bg-sidebar-accent border-sidebar-border h-9 text-sm"
            >
              <div className="flex items-center gap-2 truncate">
                <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="truncate">{triggerLabel}</span>
              </div>
              <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-64 max-h-[min(24rem,70vh)] overflow-y-auto"
          >
            {selectedProject ? (
              <p
                className="px-2 py-1.5 text-xs text-muted-foreground font-mono truncate"
                title={selectedProject.path}
              >
                {selectedProject.path}
              </p>
            ) : (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                No project opened
              </p>
            )}
            <DropdownMenuSeparator />

            {/* Action rows appear FIRST so they're reachable without
             *  scrolling past a long Recent Projects list — the common
             *  intent for opening this dropdown is "add a new repo",
             *  not "switch to a known one". The icon keeps the accent
             *  color as a visual cue; the label uses the default
             *  foreground so it stays readable both idle and on hover.
             *  The previous "text-accent span" caused the label to
             *  render accent-on-accent (i.e. invisible) once the
             *  dropdown item's focus background kicked in. */}
            <DropdownMenuItem
              onClick={onOpenLocalProject}
              className="font-medium"
            >
              <FolderPlus className="h-4 w-4 mr-2 text-accent" />
              <span>Open Local Project…</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={onCloneFromGithub}
              className="font-medium"
            >
              <Github className="h-4 w-4 mr-2 text-accent" />
              <span>Clone from GitHub…</span>
            </DropdownMenuItem>

            {others.length > 0 ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  Recent projects
                </DropdownMenuLabel>
                {others.map((p) => (
                  <DropdownMenuItem
                    key={p.id}
                    onClick={() => onSwitchProject(p)}
                    className="flex-col items-start gap-0.5"
                  >
                    <span className="truncate w-full">{p.name}</span>
                    <span
                      className="text-[10px] text-muted-foreground font-mono truncate w-full"
                      title={p.path}
                    >
                      {p.path}
                    </span>
                  </DropdownMenuItem>
                ))}
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {mainNavItems.map((item) => (
          <button
            key={item.id}
            onClick={() => onViewChange(item.id)}
            className={cn(
              "w-full flex items-center justify-between px-3 py-2 rounded-md text-sm transition-colors",
              currentView === item.id
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
            )}
          >
            <div className="flex items-center gap-3">
              <item.icon className="h-4 w-4" />
              <span>{item.label}</span>
            </div>
            {item.badge && findingsCount > 0 && (
              <Badge variant="destructive" className="h-5 px-1.5 text-xs font-medium">
                {findingsCount}
              </Badge>
            )}
          </button>
        ))}
      </nav>

      <div className="p-3 border-t border-sidebar-border">
        {bottomNavItems.map((item) => (
          <button
            key={item.id}
            onClick={() => onViewChange(item.id)}
            className={cn(
              "w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
              currentView === item.id
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
            )}
          >
            <item.icon className="h-4 w-4" />
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
