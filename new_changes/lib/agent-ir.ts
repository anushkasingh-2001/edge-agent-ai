export type Location = { file: string; start_line: number; end_line: number; symbol?: string | null }

export type AgentIRNode =
  | { kind: "agent"; id: string; name: string; framework?: string | null; location: Location }
  | { kind: "tool"; id: string; name: string; side_effects: string[]; callable_from_agent: boolean; location: Location }
  | { kind: "model"; id: string; provider?: string | null; model_name?: string | null; purpose?: string | null; location: Location }
  | { kind: "prompt"; id: string; name: string; text_preview: string; location: Location }
  | { kind: "route"; id: string; method: string; path: string; auth_guards: string[]; location: Location }

export type AgentIREdge = {
  src: string
  dst: string
  kind: "calls" | "uses_tool" | "uses_model" | "uses_prompt" | "flows_to" | "guarded_by" | "reads" | "writes"
}
