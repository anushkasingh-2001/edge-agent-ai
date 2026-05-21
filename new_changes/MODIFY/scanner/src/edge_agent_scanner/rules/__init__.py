"""Legacy inventory helpers.

Security finding rules moved to `edge_agent_scanner.analyzers`.
Keep only inventory helpers here during migration.
"""

try:
    from edge_agent_scanner.rules.agents_inventory import detect_agents, attribute_tools_to_agents
except Exception:
    detect_agents = None
    attribute_tools_to_agents = None

try:
    from edge_agent_scanner.rules.tools_inventory import detect_tools
except Exception:
    detect_tools = None

try:
    from edge_agent_scanner.rules.frameworks import detect_frameworks
except Exception:
    detect_frameworks = None

__all__ = ["detect_agents", "attribute_tools_to_agents", "detect_tools", "detect_frameworks"]
