from __future__ import annotations

from pydantic import BaseModel, Field


class VerificationResult(BaseModel):
    true_positive: bool
    confidence: float = Field(ge=0.0, le=1.0)
    severity: str | None = None
    reason: str
    patch_strategy: str | None = None
