"""Shared types for rules."""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from edge_agent_scanner.report import Finding
    from edge_agent_scanner.walker import ScannedFile


class RuleFunc(Protocol):
    def __call__(self, files: list[ScannedFile]) -> list[Finding]: ...
