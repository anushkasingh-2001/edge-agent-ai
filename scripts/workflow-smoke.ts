/**
 * One-shot smoke test for the workflow analyzer. Not registered as a package
 * script — invoked manually with `./node_modules/.bin/tsx scripts/workflow-smoke.ts <path>`.
 */
import { analyzeWorkflow } from "../lib/server-workflow"

const projectPath = process.argv[2]
if (!projectPath) {
  console.error("Usage: tsx scripts/workflow-smoke.ts <projectPath>")
  process.exit(2)
}

const r = analyzeWorkflow(projectPath)

console.log("=== SUMMARY ===")
console.log(r.summary)
console.log()
console.log("=== STATS ===")
console.log(r.stats)
console.log()
console.log("=== ENTRYPOINTS ===")
console.log(r.entrypoints)
console.log()
console.log("=== COMPONENTS (first 10) ===")
console.log(r.components.slice(0, 10))
console.log()
console.log("=== PROMPTS ===")
console.log(r.prompts)
console.log()
console.log("=== TOOLS ===")
console.log(r.tools)
console.log()
console.log("=== MODEL CALLS ===")
console.log(r.modelCalls)
console.log()
console.log("=== EDGES (first 10) ===")
console.log(r.edges.slice(0, 10))
console.log()
console.log("=== MCP / OPENAPI ===")
console.log(r.mcpConfigs, r.openApiSpecs)
console.log()
console.log("=== MERMAID ===")
console.log(r.mermaid)
console.log()
console.log("=== WARNINGS ===")
console.log(r.warnings)
