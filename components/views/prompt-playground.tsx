"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { 
  Play, 
  Plus,
  Trash2,
  Copy,
  Clock,
  DollarSign,
  Target,
  Zap,
  GitCompare
} from "lucide-react"

const models = [
  { id: "gpt-4o", name: "GPT-4o", provider: "OpenAI" },
  { id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "OpenAI" },
  { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet", provider: "Anthropic" },
  { id: "claude-3-opus", name: "Claude 3 Opus", provider: "Anthropic" },
  { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", provider: "Google" },
  { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro", provider: "Google" },
  { id: "llama-3.3-70b", name: "Llama 3.3 70B", provider: "Local" },
  { id: "custom", name: "Custom API", provider: "Custom" },
]

const testInputs = [
  { id: 1, input: "What is your refund policy?", expected: "Mentions 30-day policy" },
  { id: 2, input: "I want to cancel my subscription", expected: "Provides cancellation steps" },
  { id: 3, input: "My order never arrived", expected: "Offers to track or refund" },
]

const outputResults = [
  { 
    id: 1, 
    modelA: "Our refund policy allows returns within 30 days of purchase. Would you like me to help you initiate a refund?",
    modelB: "We offer a 30-day money-back guarantee on all products. I can help you process a refund if needed.",
    accuracyA: 95,
    accuracyB: 92,
  },
  { 
    id: 2, 
    modelA: "I can help you cancel your subscription. Please go to Settings > Subscription > Cancel. Is there anything I can help with before you go?",
    modelB: "To cancel, visit your account settings and click on the subscription tab. Would you like me to walk you through it?",
    accuracyA: 88,
    accuracyB: 91,
  },
  { 
    id: 3, 
    modelA: "I'm sorry to hear that. Let me look up your order. Could you provide your order number? I can either track it or process a refund.",
    modelB: "That's concerning. I'll need your order ID to investigate. We can track the package or issue a full refund.",
    accuracyA: 94,
    accuracyB: 96,
  },
]

export function PromptPlayground() {
  const [selectedModelA, setSelectedModelA] = useState("gpt-4o")
  const [selectedModelB, setSelectedModelB] = useState("claude-3-5-sonnet")
  const [prompt, setPrompt] = useState(`You are a helpful customer service agent for an e-commerce platform.

Guidelines:
- Be friendly and professional
- Offer solutions proactively
- Mention our 30-day refund policy when relevant
- Never promise things outside policy

Respond concisely and helpfully.`)
  const [viewMode, setViewMode] = useState<"side-by-side" | "diff">("side-by-side")

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Prompt Playground</h1>
          <p className="text-muted-foreground">Test and compare prompts across different models</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline">
            <Copy className="h-4 w-4 mr-2" />
            Save Version
          </Button>
          <Button>
            <Play className="h-4 w-4 mr-2" />
            Run All Tests
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Prompt Editor */}
        <div className="col-span-2 space-y-4">
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">System Prompt</CardTitle>
                <Badge variant="outline" className="text-xs">
                  {prompt.length} chars
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <Textarea 
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                className="min-h-[200px] font-mono text-sm bg-secondary/30 resize-none"
                placeholder="Enter your system prompt..."
              />
            </CardContent>
          </Card>

          {/* Test Inputs */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Test Inputs</CardTitle>
                <Button variant="outline" size="sm">
                  <Plus className="h-4 w-4 mr-2" />
                  Add Input
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="w-12">#</TableHead>
                    <TableHead>User Input</TableHead>
                    <TableHead>Expected Output</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {testInputs.map((test, i) => (
                    <TableRow key={test.id} className="border-border">
                      <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                      <TableCell>
                        <Input 
                          defaultValue={test.input}
                          className="bg-secondary/30 border-0"
                        />
                      </TableCell>
                      <TableCell>
                        <Input 
                          defaultValue={test.expected}
                          className="bg-secondary/30 border-0 text-muted-foreground"
                        />
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>

        {/* Model Selection */}
        <div className="space-y-4">
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Model A</CardTitle>
            </CardHeader>
            <CardContent>
              <Select value={selectedModelA} onValueChange={setSelectedModelA}>
                <SelectTrigger className="bg-secondary/50">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {models.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      <div className="flex items-center gap-2">
                        <span>{model.name}</span>
                        <span className="text-xs text-muted-foreground">({model.provider})</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Model B</CardTitle>
            </CardHeader>
            <CardContent>
              <Select value={selectedModelB} onValueChange={setSelectedModelB}>
                <SelectTrigger className="bg-secondary/50">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {models.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      <div className="flex items-center gap-2">
                        <span>{model.name}</span>
                        <span className="text-xs text-muted-foreground">({model.provider})</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          {/* Metrics Summary */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Metrics</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground flex items-center gap-1">
                    <Target className="h-3 w-3" />
                    Accuracy
                  </div>
                  <div className="flex gap-2">
                    <Badge variant="outline" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
                      A: 92%
                    </Badge>
                    <Badge variant="outline" className="bg-blue-500/10 text-blue-400 border-blue-500/20">
                      B: 93%
                    </Badge>
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    Latency
                  </div>
                  <div className="flex gap-2">
                    <Badge variant="outline">A: 1.2s</Badge>
                    <Badge variant="outline">B: 0.8s</Badge>
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground flex items-center gap-1">
                    <DollarSign className="h-3 w-3" />
                    Cost
                  </div>
                  <div className="flex gap-2">
                    <Badge variant="outline">A: $0.02</Badge>
                    <Badge variant="outline">B: $0.03</Badge>
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground flex items-center gap-1">
                    <Zap className="h-3 w-3" />
                    Tool Selected
                  </div>
                  <div className="flex gap-2">
                    <Badge variant="outline" className="text-green-400">3/3</Badge>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Output Comparison */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Output Comparison</CardTitle>
            <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as "side-by-side" | "diff")}>
              <TabsList className="bg-secondary/50">
                <TabsTrigger value="side-by-side" className="text-xs">Side by Side</TabsTrigger>
                <TabsTrigger value="diff" className="text-xs">
                  <GitCompare className="h-3 w-3 mr-1" />
                  Diff
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {outputResults.map((result, i) => (
              <div key={result.id} className="p-4 rounded-lg bg-secondary/20 border border-border">
                <div className="text-sm font-medium mb-3 flex items-center gap-2">
                  <Badge variant="outline" className="text-xs">Test {i + 1}</Badge>
                  <span className="text-muted-foreground">{testInputs[i]?.input}</span>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-emerald-400">Model A (GPT-4o)</span>
                      <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
                        {result.accuracyA}% match
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground p-3 rounded bg-secondary/30">
                      {result.modelA}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-blue-400">Model B (Claude 3.5)</span>
                      <Badge variant="outline" className="text-xs bg-blue-500/10 text-blue-400 border-blue-500/20">
                        {result.accuracyB}% match
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground p-3 rounded bg-secondary/30">
                      {result.modelB}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
