"use client"

import { useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { 
  Send, 
  Bot, 
  User,
  Sparkles,
  FileCode,
  GitBranch,
  AlertTriangle,
  TestTube,
  ChevronRight,
  Info
} from "lucide-react"

const suggestedQuestions = [
  { icon: AlertTriangle, text: "Why did accuracy drop?", color: "text-orange-400" },
  { icon: GitBranch, text: "Why did the agent call refund_tool?", color: "text-blue-400" },
  { icon: FileCode, text: "Which commit caused this?", color: "text-purple-400" },
  { icon: AlertTriangle, text: "How do I fix this security issue?", color: "text-red-400" },
  { icon: TestTube, text: "Generate tests for this failure.", color: "text-green-400" },
]

const agents = [
  { id: "all", name: "All" },
  { id: "support", name: "SupportAgent" },
  { id: "chat", name: "ChatAgent" },
  { id: "data", name: "DataAgent" },
  { id: "api", name: "APIAgent" },
  { id: "admin", name: "AdminAgent" },
]

interface Message {
  id: number
  role: "user" | "assistant"
  content: string
  timestamp: Date
  codeSnippet?: string
  references?: { file: string; line: number }[]
}

interface ChatAssistantProps {
  currentBranch: string
}

const initialMessages: Message[] = [
  {
    id: 1,
    role: "assistant",
    content: "Hello! I'm your AI security assistant. I can help you understand findings, debug issues, and generate fixes for your AI agents. What would you like to know?",
    timestamp: new Date(Date.now() - 60000),
  },
]

export function ChatAssistant({ currentBranch }: ChatAssistantProps) {
  const [messages, setMessages] = useState<Message[]>(initialMessages)
  const [input, setInput] = useState("")
  const [isTyping, setIsTyping] = useState(false)
  const [selectedAgent, setSelectedAgent] = useState("all")
  const [selectedFinding, setSelectedFinding] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [currentScanRun, setCurrentScanRun] = useState("scan-001")

  const handleSend = () => {
    if (!input.trim()) return

    const userMessage: Message = {
      id: messages.length + 1,
      role: "user",
      content: input,
      timestamp: new Date(),
    }

    setMessages([...messages, userMessage])
    setInput("")
    setIsTyping(true)

    // Simulate assistant response
    setTimeout(() => {
      const assistantMessage: Message = {
        id: messages.length + 2,
        role: "assistant",
        content: getAssistantResponse(input),
        timestamp: new Date(),
        codeSnippet: input.toLowerCase().includes("fix") ? `# Suggested fix for prompt injection
def safe_prompt(user_input: str) -> str:
    # Sanitize user input before including in prompt
    sanitized = escape_special_chars(user_input)
    return f"User says: {sanitized}"` : undefined,
        references: input.toLowerCase().includes("accuracy") ? [
          { file: "agents/chat.py", line: 142 },
          { file: "prompts/system.txt", line: 1 },
        ] : undefined,
      }
      setMessages((prev) => [...prev, assistantMessage])
      setIsTyping(false)
    }, 1500)
  }

  const getAssistantResponse = (query: string): string => {
    const lowerQuery = query.toLowerCase()
    const agentContext = selectedAgent === "all" ? "all agents" : agents.find(a => a.id === selectedAgent)?.name
    
    if (lowerQuery.includes("accuracy")) {
      return `Based on my analysis of ${agentContext}, the accuracy drop is likely caused by changes to the system prompt in \`prompts/system.txt\`. The prompt was made less specific, which may be causing inconsistent responses. I recommend adding explicit guidelines about response format and allowed topics.`
    }
    if (lowerQuery.includes("refund")) {
      return `Looking at the runtime trace for ${agentContext}, the agent called \`refund_tool\` because the user message contained keywords matching the refund intent classifier. However, the tool was called without checking the refund amount threshold. This is flagged as a security issue in finding #3.`
    }
    if (lowerQuery.includes("commit") || lowerQuery.includes("caused")) {
      return "The regression was likely introduced in commit `a1b2c3d` (3 days ago) which modified the error handling prompt. This change removed explicit error details from responses, which may affect debugging capabilities."
    }
    if (lowerQuery.includes("security") || lowerQuery.includes("fix")) {
      return "To fix the prompt injection vulnerability in `agents/chat.py:142`, you should sanitize user input before including it in the system prompt. Here's a suggested fix that uses proper escaping:"
    }
    if (lowerQuery.includes("test")) {
      return `I can generate test cases for this issue. Based on the finding for ${agentContext}, here are the recommended tests:\n\n1. Test that user input with special characters is properly escaped\n2. Test that prompt injection attempts are blocked\n3. Test that valid user input still works correctly\n\nWould you like me to generate the full test code?`
    }
    
    return `I analyzed your query in the context of ${agentContext}. Could you provide more context about what specific aspect you'd like me to investigate? I can help with security issues, performance analysis, or generating fixes and tests.`
  }

  const handleSuggestedQuestion = (question: string) => {
    setInput(question)
  }

  return (
    <div className="p-6 h-[calc(100vh-5.5rem)] flex flex-col">
      {/* Header */}
      <div className="mb-4">
        <h1 className="text-2xl font-semibold">Chat Assistant</h1>
        <p className="text-muted-foreground">Ask questions about your AI agents and findings</p>
      </div>

      <div className="flex-1 flex gap-6 min-h-0">
        {/* Chat Panel */}
        <Card className="flex-1 bg-card border-border flex flex-col">
          <ScrollArea className="flex-1 p-4">
            <div className="space-y-4">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`flex gap-3 ${message.role === "user" ? "justify-end" : ""}`}
                >
                  {message.role === "assistant" && (
                    <div className="p-2 bg-accent/10 rounded-lg border border-accent/20 h-fit">
                      <Bot className="h-4 w-4 text-accent" />
                    </div>
                  )}
                  <div
                    className={`max-w-[80%] ${
                      message.role === "user"
                        ? "bg-primary text-primary-foreground rounded-2xl rounded-tr-md px-4 py-2"
                        : "space-y-3"
                    }`}
                  >
                    {message.role === "assistant" ? (
                      <>
                        <div className="bg-secondary/30 rounded-2xl rounded-tl-md p-4">
                          <p className="text-sm leading-relaxed whitespace-pre-wrap">{message.content}</p>
                        </div>
                        {message.codeSnippet && (
                          <pre className="p-4 rounded-lg bg-[#0d0d0d] dark:bg-[#0d0d0d] border border-border text-sm font-mono overflow-x-auto">
                            <code className="text-green-400">{message.codeSnippet}</code>
                          </pre>
                        )}
                        {message.references && message.references.length > 0 && (
                          <div className="flex flex-wrap gap-2">
                            {message.references.map((ref, i) => (
                              <Badge key={i} variant="outline" className="text-xs bg-secondary/30">
                                <FileCode className="h-3 w-3 mr-1" />
                                {ref.file}:{ref.line}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </>
                    ) : (
                      <p className="text-sm">{message.content}</p>
                    )}
                  </div>
                  {message.role === "user" && (
                    <div className="p-2 bg-secondary rounded-lg h-fit">
                      <User className="h-4 w-4 text-muted-foreground" />
                    </div>
                  )}
                </div>
              ))}
              {isTyping && (
                <div className="flex gap-3">
                  <div className="p-2 bg-accent/10 rounded-lg border border-accent/20 h-fit">
                    <Bot className="h-4 w-4 text-accent" />
                  </div>
                  <div className="bg-secondary/30 rounded-2xl rounded-tl-md p-4">
                    <div className="flex gap-1">
                      <span className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                      <span className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                      <span className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>

          {/* Input */}
          <CardContent className="border-t border-border p-4">
            <div className="flex gap-2">
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSend()}
                placeholder="Ask about your AI agents..."
                className="bg-secondary/50"
              />
              <Button onClick={handleSend} disabled={!input.trim()}>
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Sidebar */}
        <div className="w-80 space-y-4">
          {/* Agent Context Selector */}
          <Card className="bg-card border-border">
            <CardContent className="pt-4">
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Bot className="h-4 w-4 text-accent" />
                  <Label className="text-sm font-medium">Current agent for context</Label>
                </div>
                <Select value={selectedAgent} onValueChange={setSelectedAgent}>
                  <SelectTrigger className="bg-secondary/50">
                    <SelectValue placeholder="Select agent" />
                  </SelectTrigger>
                  <SelectContent>
                    {agents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        {agent.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex items-start gap-2 text-xs text-muted-foreground">
                  <Info className="h-3 w-3 mt-0.5 shrink-0" />
                  <span>Limits chatbot answers to the selected agent context. Default uses all agents.</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Current Context */}
          <Card className="bg-card border-border">
            <CardContent className="pt-4">
              <div className="text-sm font-medium mb-3">Current Context</div>
              <div className="space-y-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Current branch</span>
                  <span className="font-mono text-xs bg-secondary/50 px-2 py-0.5 rounded">{currentBranch}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Agent context</span>
                  <span className="font-mono text-xs bg-secondary/50 px-2 py-0.5 rounded">
                    {agents.find(a => a.id === selectedAgent)?.name || "All"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Selected finding</span>
                  <span className="font-mono text-xs bg-secondary/50 px-2 py-0.5 rounded">
                    {selectedFinding || "None"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Selected file</span>
                  <span className="font-mono text-xs bg-secondary/50 px-2 py-0.5 rounded truncate max-w-[120px]">
                    {selectedFile || "None"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Current scan run</span>
                  <span className="font-mono text-xs bg-secondary/50 px-2 py-0.5 rounded">
                    {currentScanRun}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Suggested Questions */}
          <Card className="bg-card border-border">
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 mb-4">
                <Sparkles className="h-4 w-4 text-accent" />
                <span className="text-sm font-medium">Suggested Questions</span>
              </div>
              <div className="space-y-2">
                {suggestedQuestions.map((q, i) => (
                  <button
                    key={i}
                    onClick={() => handleSuggestedQuestion(q.text)}
                    className="w-full flex items-center gap-3 p-3 rounded-lg bg-secondary/30 hover:bg-secondary/50 transition-colors text-left group"
                  >
                    <q.icon className={`h-4 w-4 ${q.color}`} />
                    <span className="text-sm flex-1">{q.text}</span>
                    <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
