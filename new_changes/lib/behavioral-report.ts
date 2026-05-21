import { z } from "zod"

export const TraceEventSchema = z.object({
  run_id: z.string(),
  case_id: z.string().nullable().optional(),
  suite_id: z.string().nullable().optional(),
  agent_id: z.string().nullable().optional(),
  agent_name: z.string().nullable().optional(),
  model_id: z.string().nullable().optional(),
  model_name: z.string().nullable().optional(),
  model_purpose: z.string().nullable().optional(),
  tool_id: z.string().nullable().optional(),
  tool_name: z.string().nullable().optional(),
  event_type: z.string(),
  start_ms: z.number(),
  end_ms: z.number().nullable().optional(),
  latency_ms: z.number().nullable().optional(),
  input_tokens: z.number().default(0),
  output_tokens: z.number().default(0),
  cost_usd: z.number().default(0),
  status: z.string().default("ok"),
  error: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
})

export const AgentMetricSchema = z.object({
  agent_id: z.string(),
  agent_name: z.string().nullable().optional(),
  total_cases: z.number().default(0),
  passed_cases: z.number().default(0),
  failed_cases: z.number().default(0),
  skipped_cases: z.number().default(0),
  accuracy: z.number().nullable().optional(),
  avg_runtime_ms: z.number().nullable().optional(),
  p50_runtime_ms: z.number().nullable().optional(),
  p95_runtime_ms: z.number().nullable().optional(),
  p99_runtime_ms: z.number().nullable().optional(),
  error_rate: z.number().default(0),
  model_calls: z.number().default(0),
  tool_calls: z.number().default(0),
  approval_events: z.number().default(0),
  input_tokens: z.number().default(0),
  output_tokens: z.number().default(0),
  total_cost_usd: z.number().default(0),
})

export const ModelMetricSchema = z.object({
  agent_id: z.string().nullable().optional(),
  agent_name: z.string().nullable().optional(),
  model_id: z.string(),
  model_name: z.string().nullable().optional(),
  model_purpose: z.string().nullable().optional(),
  calls: z.number().default(0),
  avg_latency_ms: z.number().nullable().optional(),
  p50_latency_ms: z.number().nullable().optional(),
  p95_latency_ms: z.number().nullable().optional(),
  p99_latency_ms: z.number().nullable().optional(),
  input_tokens: z.number().default(0),
  output_tokens: z.number().default(0),
  total_cost_usd: z.number().default(0),
  error_rate: z.number().default(0),
  quality_score: z.number().nullable().optional(),
  quality_label: z.string().nullable().optional(),
})

export const OverallBehavioralMetricsSchema = z.object({
  total_cases: z.number().default(0),
  passed_cases: z.number().default(0),
  failed_cases: z.number().default(0),
  skipped_cases: z.number().default(0),
  accuracy: z.number().nullable().optional(),
  avg_runtime_ms: z.number().nullable().optional(),
  p95_runtime_ms: z.number().nullable().optional(),
  p99_runtime_ms: z.number().nullable().optional(),
  total_model_calls: z.number().default(0),
  total_tool_calls: z.number().default(0),
  total_cost_usd: z.number().default(0),
  error_rate: z.number().default(0),
})

export const BehavioralCaseSchema = z.object({
  suite_id: z.string(),
  case_id: z.string(),
  title: z.string(),
  prompt: z.string().nullable().optional(),
  expected: z.record(z.string(), z.unknown()).default({}),
  target_agent_id: z.string().nullable().optional(),
  target_agent_name: z.string().nullable().optional(),
  target_model_id: z.string().nullable().optional(),
  target_model_name: z.string().nullable().optional(),
  target_model_purpose: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
})

export const BehavioralResultSchema = z.object({
  suite_id: z.string(),
  case_id: z.string(),
  status: z.enum(["pass", "fail", "skip", "error"]),
  title: z.string(),
  reason: z.string(),
  target_agent_id: z.string().nullable().optional(),
  target_agent_name: z.string().nullable().optional(),
  target_model_id: z.string().nullable().optional(),
  target_model_name: z.string().nullable().optional(),
  score: z.number().nullable().optional(),
  runtime_ms: z.number().nullable().optional(),
  error: z.string().nullable().optional(),
  details: z.record(z.string(), z.unknown()).default({}),
})

export const BehavioralReportSchema = z.object({
  run_id: z.string(),
  generated_at: z.string(),
  cases: z.array(BehavioralCaseSchema).default([]),
  results: z.array(BehavioralResultSchema).default([]),
  trace_events: z.array(TraceEventSchema).default([]),
  overall_metrics: OverallBehavioralMetricsSchema.default({}),
  agent_metrics: z.array(AgentMetricSchema).default([]),
  model_metrics: z.array(ModelMetricSchema).default([]),
  harness_status: z.enum(["configured", "auto_detected", "not_configured", "failed"]).default("not_configured"),
  harness_message: z.string().nullable().optional(),
  harness_config_path: z.string().nullable().optional(),
})

export type BehavioralReport = z.infer<typeof BehavioralReportSchema>
export type TraceEvent = z.infer<typeof TraceEventSchema>
export type AgentMetric = z.infer<typeof AgentMetricSchema>
export type ModelMetric = z.infer<typeof ModelMetricSchema>
