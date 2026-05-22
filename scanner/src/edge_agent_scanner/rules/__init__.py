"""Legacy inventory helpers.

Security finding rules moved to ``edge_agent_scanner.analyzers``. This package
now exports only the inventory/framework detection helpers that the new IR
extractors do not yet replace, plus the old `mask_credential` (still used by
tests) is imported lazily via ``edge_agent_scanner.rules.secrets``.

Importing the runner symbols is wrapped in try/except so a partial removal of
legacy rule files does not break ``import edge_agent_scanner.rules``.
"""

from __future__ import annotations

try:
    from edge_agent_scanner.rules.agents_inventory import (
        attribute_tools_to_agents,
        detect_agents,
    )
except Exception:  # pragma: no cover - legacy file may be removed in the future
    detect_agents = None  # type: ignore[assignment]
    attribute_tools_to_agents = None  # type: ignore[assignment]

try:
    from edge_agent_scanner.rules.tools_inventory import detect_tools
except Exception:  # pragma: no cover
    detect_tools = None  # type: ignore[assignment]

try:
    from edge_agent_scanner.rules.frameworks import detect_frameworks
except Exception:  # pragma: no cover
    detect_frameworks = None  # type: ignore[assignment]

__all__ = [
    "detect_agents",
    "attribute_tools_to_agents",
    "detect_tools",
    "detect_frameworks",
]
