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
} from "lucide-react"
import Image from "next/image"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Badge } from "@/components/ui/badge"

export type ViewType = 
  | "overview" 
  | "scan-center" 
  | "detected-agents"
  | "findings" 
  | "run-traces"
  | "branch-compare" 
  | "prompt-playground" 
  | "chat-assistant" 
  | "settings"

interface AppSidebarProps {
  currentView: ViewType
  onViewChange: (view: ViewType) => void
  onChangeProject: () => void
  findingsCount?: number
}

const mainNavItems = [
  { id: "overview" as ViewType, label: "Overview", icon: LayoutDashboard },
  { id: "scan-center" as ViewType, label: "Scan Center", icon: ScanSearch },
  { id: "detected-agents" as ViewType, label: "Detected Agents", icon: Bot },
  { id: "findings" as ViewType, label: "Findings", icon: AlertTriangle, badge: true },
  { id: "run-traces" as ViewType, label: "Run Traces", icon: Activity },
  { id: "branch-compare" as ViewType, label: "Branch Compare", icon: GitCompare },
  { id: "prompt-playground" as ViewType, label: "Prompt Playground", icon: MessageSquare },
  { id: "chat-assistant" as ViewType, label: "Chat Assistant", icon: TestTube },
]

const bottomNavItems = [
  { id: "settings" as ViewType, label: "Settings", icon: Settings },
]

export function AppSidebar({ currentView, onViewChange, onChangeProject, findingsCount = 12 }: AppSidebarProps) {
  return (
    <div className="w-60 h-full bg-sidebar border-r border-sidebar-border flex flex-col">
      {/* Header */}
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
        
        {/* Project Selector */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="w-full justify-between bg-sidebar-accent border-sidebar-border h-9 text-sm">
              <div className="flex items-center gap-2 truncate">
                <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="truncate">customer-service-agent</span>
              </div>
              <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem>customer-service-agent</DropdownMenuItem>
            <DropdownMenuItem>code-review-bot</DropdownMenuItem>
            <DropdownMenuItem>data-analyst-agent</DropdownMenuItem>
            <DropdownMenuItem onClick={onChangeProject}>
              <span className="text-accent">Open another project...</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Main Navigation */}
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

      {/* Bottom Navigation */}
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
