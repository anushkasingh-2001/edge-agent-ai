VERIFY_FINDING_PROMPT = """You are verifying an AI-agent static-analysis finding.
Return JSON only with keys:
true_positive, confidence, severity, reason, patch_strategy.

Finding:
{finding}

Code/evidence:
{evidence}

Rubric:
{rubric}
"""
