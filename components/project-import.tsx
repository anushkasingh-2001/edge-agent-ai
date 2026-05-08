"use client"

import { useState } from "react"
import { FolderOpen, Github, Clock, Search, ChevronRight } from "lucide-react"
import Image from "next/image"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

const frameworks = [
  { name: "LangChain", color: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" },
  { name: "LangGraph", color: "bg-blue-500/10 text-blue-400 border-blue-500/20" },
  { name: "LlamaIndex", color: "bg-purple-500/10 text-purple-400 border-purple-500/20" },
  { name: "Pydantic AI", color: "bg-pink-500/10 text-pink-400 border-pink-500/20" },
  { name: "Agno", color: "bg-orange-500/10 text-orange-400 border-orange-500/20" },
  { name: "MCP", color: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20" },
  { name: "OpenAPI", color: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20" },
]

const recentProjects = [
  { name: "customer-service-agent", path: "~/projects/cs-agent", frameworks: ["LangChain", "MCP"], lastOpened: "2 hours ago" },
  { name: "code-review-bot", path: "~/projects/code-review", frameworks: ["LangGraph", "OpenAPI"], lastOpened: "Yesterday" },
  { name: "data-analyst-agent", path: "~/projects/data-analyst", frameworks: ["LlamaIndex", "Pydantic AI"], lastOpened: "3 days ago" },
  { name: "support-chatbot", path: "~/projects/support-bot", frameworks: ["LangChain"], lastOpened: "1 week ago" },
]

interface ProjectImportProps {
  onProjectSelect: () => void
}

export function ProjectImport({ onProjectSelect }: ProjectImportProps) {
  const [searchQuery, setSearchQuery] = useState("")
  const [gitUrl, setGitUrl] = useState("")

  const filteredProjects = recentProjects.filter(
    (project) =>
      project.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      project.path.toLowerCase().includes(searchQuery.toLowerCase())
  )

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-8">
      <div className="w-full max-w-3xl space-y-8">
        {/* Header */}
        <div className="text-center space-y-4">
          <div className="flex items-center justify-center gap-3 mb-2">
            <Image 
              src="https://hebbkx1anhila5yf.public.blob.vercel-storage.com/edge_agent_ai-2ZiMAJND6E8xlZHoIAaqyh3xFOwQv9.png" 
              alt="Edge Agent AI"
              width={64}
              height={64}
              className="rounded-lg"
            />
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">Edge Agent AI</h1>
          <p className="text-muted-foreground">Detect. Explain. Protect.</p>
          <p className="text-muted-foreground text-lg">
            Import a project to start scanning and testing your AI agents
          </p>
        </div>

        {/* Framework badges */}
        <div className="flex flex-wrap justify-center gap-2">
          {frameworks.map((framework) => (
            <Badge key={framework.name} variant="outline" className={framework.color}>
              {framework.name}
            </Badge>
          ))}
        </div>

        {/* Import Options */}
        <Tabs defaultValue="local" className="w-full">
          <TabsList className="grid w-full grid-cols-2 bg-secondary/50">
            <TabsTrigger value="local" className="data-[state=active]:bg-card">
              <FolderOpen className="h-4 w-4 mr-2" />
              Local Folder
            </TabsTrigger>
            <TabsTrigger value="github" className="data-[state=active]:bg-card">
              <Github className="h-4 w-4 mr-2" />
              Clone from GitHub
            </TabsTrigger>
          </TabsList>

          <TabsContent value="local" className="mt-4">
            <Card className="border-border bg-card">
              <CardHeader>
                <CardTitle className="text-lg">Choose Local Folder</CardTitle>
                <CardDescription>Select a folder containing your AI agent project</CardDescription>
              </CardHeader>
              <CardContent>
                <Button 
                  onClick={onProjectSelect} 
                  variant="outline" 
                  className="w-full h-32 border-dashed border-2 hover:border-accent hover:bg-accent/5 transition-colors"
                >
                  <div className="flex flex-col items-center gap-2">
                    <FolderOpen className="h-8 w-8 text-muted-foreground" />
                    <span className="text-muted-foreground">Click to browse or drag and drop</span>
                  </div>
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="github" className="mt-4">
            <Card className="border-border bg-card">
              <CardHeader>
                <CardTitle className="text-lg">Clone from GitHub</CardTitle>
                <CardDescription>Enter a GitHub repository URL to clone</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex gap-2">
                  <Input
                    placeholder="https://github.com/username/repository"
                    value={gitUrl}
                    onChange={(e) => setGitUrl(e.target.value)}
                    className="bg-secondary/50"
                  />
                  <Button onClick={onProjectSelect} disabled={!gitUrl}>Clone</Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Recent Projects */}
        <Card className="border-border bg-card">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-lg">Recent Projects</CardTitle>
              </div>
              <div className="relative w-64">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search projects..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9 bg-secondary/50 h-9"
                />
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="space-y-1">
              {filteredProjects.map((project) => (
                <button
                  key={project.name}
                  onClick={onProjectSelect}
                  className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-secondary/50 transition-colors group text-left"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-secondary rounded-lg">
                      <FolderOpen className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div>
                      <div className="font-medium">{project.name}</div>
                      <div className="text-sm text-muted-foreground">{project.path}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex gap-1.5">
                      {project.frameworks.map((fw) => {
                        const framework = frameworks.find((f) => f.name === fw)
                        return (
                          <Badge key={fw} variant="outline" className={`text-xs ${framework?.color}`}>
                            {fw}
                          </Badge>
                        )
                      })}
                    </div>
                    <span className="text-xs text-muted-foreground w-20 text-right">{project.lastOpened}</span>
                    <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
