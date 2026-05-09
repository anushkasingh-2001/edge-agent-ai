"""Rule modules for edge_agent_scanner."""

from edge_agent_scanner.rules.agents_inventory import (
    attribute_tools_to_agents,
    detect_agents,
)
from edge_agent_scanner.rules.approval_gates import run_approval_gate_rule
from edge_agent_scanner.rules.dangerous_tools import run_dangerous_tools_rule
from edge_agent_scanner.rules.frameworks import detect_frameworks
from edge_agent_scanner.rules.mcp_openapi import run_mcp_openapi_rules
from edge_agent_scanner.rules.prompt_injection import run_prompt_injection_rule
from edge_agent_scanner.rules.secrets import run_secrets_rule
from edge_agent_scanner.rules.tools_inventory import detect_tools
from edge_agent_scanner.rules.vague_prompts import run_vague_prompts_rule

__all__ = [
    "attribute_tools_to_agents",
    "detect_agents",
    "detect_frameworks",
    "detect_tools",
    "run_dangerous_tools_rule",
    "run_approval_gate_rule",
    "run_secrets_rule",
    "run_prompt_injection_rule",
    "run_vague_prompts_rule",
    "run_mcp_openapi_rules",
]
