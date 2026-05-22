from __future__ import annotations

"""
Side-effect classification for Edge Agent AI.

This module does NOT try to parse code. Parsers/extractors such as LibCST,
Tree-sitter, OpenAPI parsing, and MCP config extraction should pass tool names,
function calls, route names, operationIds, descriptions, and small code slices
into this module.

This file answers one question:

    "If an agent can call this capability, what real-world side effect could it have?"

Design goals:
- broad enough for diverse agent repos
- deterministic and cheap
- configurable for repo-specific business tools
- backwards compatible with older code that calls:
    classify_side_effect(...)
    impact_for_effect(...)
    is_high_impact_effect(...)
"""

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Literal, Mapping, Any

Severity = Literal["critical", "high", "medium", "low"]


# ---------------------------------------------------------------------------
# Normalization helpers
# ---------------------------------------------------------------------------

_CAMEL_1 = re.compile(r"(.)([A-Z][a-z]+)")
_CAMEL_2 = re.compile(r"([a-z0-9])([A-Z])")
_NON_WORD = re.compile(r"[^A-Za-z0-9]+")


def normalize_identifier(text: str) -> str:
    """Normalize function/tool names and code snippets for semantic matching.

    Examples:
        createCadence       -> create cadence
        add_contactsToList  -> add contacts to list
        stripe.refunds.create -> stripe refunds create
    """
    text = _CAMEL_1.sub(r"\1 \2", text)
    text = _CAMEL_2.sub(r"\1 \2", text)
    text = _NON_WORD.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip().lower()


def token_set(text: str) -> set[str]:
    return set(normalize_identifier(text).split())


def contains_any_token(text: str, words: Iterable[str]) -> bool:
    tokens = token_set(text)
    return any(w.lower() in tokens for w in words)


# ---------------------------------------------------------------------------
# Rule models
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class SideEffectRule:
    """A deterministic side-effect rule.

    A rule can match either by regex patterns OR by verb/target combinations.
    Use verb/target matching for flexible business names like:
        launchCampaign, approveRefund, exportCustomers, deleteWorkspace
    """

    effect: str
    severity: Severity
    description: str
    patterns: tuple[str, ...] = ()
    verbs: tuple[str, ...] = ()
    targets: tuple[str, ...] = ()
    confidence: float = 0.75
    examples: tuple[str, ...] = ()

    def compiled_patterns(self) -> tuple[re.Pattern[str], ...]:
        return tuple(re.compile(p, re.I) for p in self.patterns)


@dataclass(frozen=True)
class SideEffectMatch:
    effect: str
    severity: Severity
    confidence: float
    reason: str
    matched_by: str
    description: str


# ---------------------------------------------------------------------------
# Built-in side-effect ontology
# ---------------------------------------------------------------------------

# Keep these broad. Specific company/repo names should be added through
# .edgeagent/config.json or .edgeagent/config.yaml rather than hardcoded here.
BUILTIN_SIDE_EFFECT_RULES: tuple[SideEffectRule, ...] = (
    # Critical: money movement and arbitrary code execution.
    SideEffectRule(
        effect="payment_or_money_movement",
        severity="critical",
        description="Money movement, billing, charging, refunds, payouts, or invoice approval.",
        patterns=(
            r"\b(stripe|paypal|adyen|checkout|billing|invoice|refunds?)\b",
            r"\b(charge|refund|transfer|payout|payment|pay|debit|credit)\b",
            r"\bapprove[_\s-]*(invoice|payment|refund|payout)\b",
        ),
        verbs=("charge", "refund", "transfer", "payout", "pay", "approve", "debit", "credit"),
        targets=("payment", "refund", "invoice", "subscription", "billing", "payout", "money", "charge"),
        confidence=0.92,
        examples=("refund_customer", "stripe.refunds.create", "approveInvoice"),
    ),
    SideEffectRule(
        effect="code_execution",
        severity="critical",
        description="Arbitrary code, shell, process, script, or dynamic execution.",
        patterns=(
            r"\bos\.system\s*\(",
            r"\bsubprocess\.(run|popen|call|check_output|check_call)\s*\(",
            r"\b(eval|exec)\s*\(",
            r"\bshell\s*=\s*true\b",
            r"\bchild_process\.(exec|execFile|spawn|fork)\s*\(",
            r"\bRuntime\.getRuntime\(\)\.exec\s*\(",
            r"\bProcessBuilder\s*\(",
            r"\bexecSync\s*\(",
        ),
        verbs=("execute", "run", "eval", "exec", "spawn", "shell"),
        targets=("command", "script", "code", "process", "shell", "terminal"),
        confidence=0.96,
        examples=("os.system(user_cmd)", "subprocess.run(..., shell=True)", "eval(input)"),
    ),
    SideEffectRule(
        effect="admin_or_identity_mutation",
        severity="critical",
        description="User, role, permission, tenant, organization, or identity mutation.",
        patterns=(
            r"\b(grant|revoke|assign|remove|set|update)[_\s-]*(admin|role|permission|scope|privilege)\b",
            r"\b(delete|disable|suspend|ban|activate|deactivate)[_\s-]*(user|account|member|tenant|org|organization)\b",
            r"\b(update|reset|rotate)[_\s-]*(password|mfa|2fa|token|api[_\s-]*key)\b",
            r"\biam\b|\bauth0\b|\bokta\b|\bcognito\b",
        ),
        verbs=("grant", "revoke", "assign", "remove", "set", "update", "delete", "disable", "suspend", "reset", "rotate"),
        targets=("admin", "role", "permission", "scope", "privilege", "user", "account", "tenant", "organization", "password", "token", "key"),
        confidence=0.9,
        examples=("grant_admin_access", "setUserRole", "delete_user"),
    ),
    SideEffectRule(
        effect="secret_or_key_management",
        severity="critical",
        description="Creation, rotation, deletion, or exposure of credentials/secrets/keys.",
        patterns=(
            r"\b(create|delete|rotate|revoke|update|read|get|print|export)[_\s-]*(secret|api[_\s-]*key|token|credential|private[_\s-]*key)\b",
            r"\b(kms|vault|secretsmanager|secretmanager|keychain)\b",
        ),
        verbs=("create", "delete", "rotate", "revoke", "update", "read", "get", "print", "export"),
        targets=("secret", "key", "token", "credential", "password", "vault"),
        confidence=0.88,
        examples=("rotate_api_key", "read_secret", "vault.read_secret"),
    ),
    SideEffectRule(
        effect="infrastructure_change",
        severity="critical",
        description="Cloud, deployment, Kubernetes, Terraform, CI/CD, or infrastructure mutation.",
        patterns=(
            r"\b(kubectl|terraform|cloudformation|pulumi|helm|docker|boto3|aws\s+|gcloud\s+|az\s+)\b",
            r"\b(deploy|rollback|scale|provision|destroy|apply|restart)[_\s-]*(service|cluster|deployment|stack|infra|instance|pod)\b",
            r"\bcreate[_\s-]*(bucket|instance|cluster|vm|database|topic|queue)\b",
        ),
        verbs=("deploy", "rollback", "scale", "provision", "destroy", "apply", "restart", "create", "delete"),
        targets=("cluster", "service", "deployment", "stack", "infra", "bucket", "instance", "pod", "database"),
        confidence=0.9,
        examples=("terraform apply", "kubectl delete", "deploy_to_prod"),
    ),

    # High impact: external effects, persistent writes, data export.
    SideEffectRule(
        effect="external_communication",
        severity="high",
        description="Outbound email, SMS, chat, notification, webhook, or external message.",
        patterns=(
            r"\b(send|create|post)[_\s-]*(email|mail|message|sms|notification|alert|webhook)\b",
            r"\b(sendEmail|sendMail|send_sms|sendSlack|postMessage)\b",
            r"\b(smtp|gmail|outlook|sendgrid|mailgun|ses|twilio|slack|discord|teams)\b",
            r"\bchat\.postMessage\b",
        ),
        verbs=("send", "post", "notify", "message", "email", "sms"),
        targets=("email", "mail", "message", "sms", "notification", "alert", "webhook", "slack"),
        confidence=0.86,
        examples=("send_email", "twilio.messages.create", "slack.chat.postMessage"),
    ),
    SideEffectRule(
        effect="crm_or_campaign_write",
        severity="high",
        description="CRM, sales, marketing, cadence, outreach, lead, or campaign mutation.",
        patterns=(
            r"\b(create|update|delete|launch|start|pause|stop|add|remove)[_\s-]*(cadence|campaign|sequence|lead|contact|prospect|account|opportunity)\b",
            r"\b(add|remove)[_\s-]*(contacts?|leads?)[_\s-]*(to|from)?[_\s-]*(cadence|campaign|sequence)?\b",
            r"\b(salesforce|hubspot|marketo|outreach|salesloft|clodura|crm)\b",
        ),
        verbs=("create", "update", "delete", "launch", "start", "pause", "stop", "add", "remove", "enroll"),
        targets=("cadence", "campaign", "sequence", "lead", "contact", "prospect", "account", "opportunity", "crm"),
        confidence=0.86,
        examples=("create_cadence", "add_contacts_to_cadence", "launchCampaign"),
    ),
    SideEffectRule(
        effect="database_mutation",
        severity="high",
        description="Persistent database create/update/delete/write/commit operation.",
        patterns=(
            r"\b(db|database|session|collection|table)\.(insert|update|delete|remove|save|commit|bulk_write|replace)\b",
            r"\b(insertOne|insertMany|updateOne|updateMany|deleteOne|deleteMany|bulkWrite)\b",
            r"\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|TRUNCATE)\b",
            r"\bexecute\s*\(\s*[furbFURB]?[\"']\s*(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)",
        ),
        verbs=("insert", "update", "delete", "remove", "save", "commit", "drop", "alter", "truncate", "merge"),
        targets=("database", "db", "table", "row", "record", "collection", "document"),
        confidence=0.84,
        examples=("db.collection.update_many", "DELETE FROM users", "session.commit"),
    ),
    SideEffectRule(
        effect="file_mutation",
        severity="high",
        description="Filesystem write/delete/move/permission mutation.",
        patterns=(
            r"\b(open\s*\([^)]*[\"'][wa+][\"']|write_text|write_bytes|writeFile|appendFile)\b",
            r"\b(delete|remove|unlink|rmtree|rm|move|rename|chmod|chown)[_\s-]*(file|folder|dir|directory)?\b",
            r"\b(fs\.(writeFile|unlink|rm|rmdir|rename|chmod))\b",
            r"\bshutil\.(rmtree|move)\b",
            r"\bPath\([^)]*\)\.(write_text|write_bytes|unlink|rename)\b",
        ),
        verbs=("write", "delete", "remove", "unlink", "move", "rename", "append", "chmod", "chown"),
        targets=("file", "folder", "directory", "path", "document"),
        confidence=0.84,
        examples=("write_file", "deleteFile", "Path(...).unlink()"),
    ),
    SideEffectRule(
        effect="data_export_or_sharing",
        severity="high",
        description="Exporting, dumping, uploading, publishing, sharing, or syncing sensitive data.",
        patterns=(
            r"\b(export|dump|download|upload|publish|share|sync|replicate)[_\s-]*(data|users?|customers?|leads?|contacts?|records?|database|csv|file|report)?\b",
            r"\b(to_csv|to_excel|dump|dumps|upload_file|put_object|blob\.upload)\b",
            r"\b(s3|gcs|blob|drive|dropbox|sharepoint)\b.*\b(upload|put|write|share|sync)\b",
        ),
        verbs=("export", "dump", "download", "upload", "publish", "share", "sync", "replicate"),
        targets=("data", "user", "customer", "lead", "contact", "record", "database", "csv", "report", "file"),
        confidence=0.82,
        examples=("export_customers", "dump_database", "s3.put_object"),
    ),
    SideEffectRule(
        effect="network_mutation",
        severity="high",
        description="Mutating HTTP/API request to external or internal service.",
        patterns=(
            r"\b(requests|httpx|axios|fetch|superagent)\.(post|put|patch|delete)\b",
            r"\bfetch\s*\([^)]*method\s*:\s*[\"'](POST|PUT|PATCH|DELETE)[\"']",
            r"\b(client|api|http)\.(post|put|patch|delete)\s*\(",
        ),
        verbs=("post", "put", "patch", "delete"),
        targets=("api", "http", "endpoint", "request", "webhook"),
        confidence=0.78,
        examples=("requests.post", "axios.delete", "fetch(...POST...)"),
    ),
    SideEffectRule(
        effect="browser_or_desktop_control",
        severity="high",
        description="Browser automation, UI automation, or desktop control that can perform external actions.",
        patterns=(
            r"\b(playwright|selenium|puppeteer|browser)\b",
            r"\b(click|type|fill|press|goto|navigate|submit)[_\s-]*(button|form|page|field)?\b",
            r"\b(pyautogui|xdotool|osascript)\b",
        ),
        verbs=("click", "type", "fill", "press", "submit", "navigate", "goto"),
        targets=("browser", "page", "form", "button", "desktop", "window"),
        confidence=0.7,
        examples=("page.click", "browser.goto", "pyautogui.click"),
    ),

    # Medium by default: still side-effecting, but severity depends on context.
    SideEffectRule(
        effect="memory_or_vector_db_write",
        severity="medium",
        description="Agent memory, vector database, embedding store, or knowledge base mutation.",
        patterns=(
            r"\b(vector|embedding|memory|knowledge[_\s-]*base|chroma|pinecone|weaviate|qdrant|milvus|faiss)\b.*\b(add|upsert|delete|update|write)\b",
            r"\b(add_documents|upsert|delete_vectors|save_context|memory\.save)\b",
        ),
        verbs=("add", "upsert", "delete", "update", "write", "save"),
        targets=("memory", "vector", "embedding", "document", "knowledge", "index"),
        confidence=0.72,
        examples=("vectorstore.add_documents", "memory.save_context"),
    ),
    SideEffectRule(
        effect="agent_delegation",
        severity="medium",
        description="Delegating work to another agent, worker, task runner, or autonomous workflow.",
        patterns=(
            r"\b(delegate|handoff|spawn|start|enqueue|schedule)[_\s-]*(agent|worker|task|job|workflow|run)\b",
            r"\b(celery|rq|bullmq|temporal|airflow|prefect)\b",
        ),
        verbs=("delegate", "handoff", "spawn", "start", "enqueue", "schedule"),
        targets=("agent", "worker", "task", "job", "workflow", "run"),
        confidence=0.68,
        examples=("delegate_to_agent", "enqueue_job", "start_workflow"),
    ),
    SideEffectRule(
        effect="mcp_tool_execution",
        severity="medium",
        description="MCP tool/resource execution; risk depends on exposed capability.",
        patterns=(
            r"\b(call_tool|tools/call|mcp\.tool|@mcp\.tool|server\.tool|FastMCP)\b",
            r"\bmcpServers\b",
        ),
        verbs=("call", "execute", "run"),
        targets=("tool", "mcp", "resource"),
        confidence=0.68,
        examples=("mcp.call_tool", "@mcp.tool"),
    ),
)


# Backwards-compatible lightweight list for older code that expects
# SIDE_EFFECT_PATTERNS. Prefer BUILTIN_SIDE_EFFECT_RULES for new code.
SIDE_EFFECT_PATTERNS: list[tuple[re.Pattern[str], str, str]] = [
    (rx, rule.effect, rule.severity)
    for rule in BUILTIN_SIDE_EFFECT_RULES
    for rx in rule.compiled_patterns()
]


DEFAULT_SEVERITY_BY_EFFECT: dict[str, Severity] = {
    rule.effect: rule.severity for rule in BUILTIN_SIDE_EFFECT_RULES
}


# ---------------------------------------------------------------------------
# Config extension support
# ---------------------------------------------------------------------------

def _load_json_or_yaml(path: Path) -> Mapping[str, Any]:
    if not path.exists():
        return {}

    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".json":
        return json.loads(text)

    # YAML is optional. If PyYAML is not installed, return empty config rather
    # than making scanning fail.
    if path.suffix.lower() in {".yaml", ".yml"}:
        try:
            import yaml  # type: ignore
        except Exception:
            return {}
        data = yaml.safe_load(text)
        return data if isinstance(data, Mapping) else {}

    return {}


def load_repo_side_effect_rules(repo_root: str | Path) -> tuple[SideEffectRule, ...]:
    """Load repo-specific side-effect rules from .edgeagent config.

    Supported shape:

    side_effects:
      custom_effect:
        severity: high
        patterns:
          - launch_special_workflow
        verbs:
          - launch
        targets:
          - workflow
        description: "Starts an internal workflow."

    Works with:
      .edgeagent/config.yaml
      .edgeagent/config.yml
      .edgeagent/config.json
    """
    root = Path(repo_root)
    candidates = [
        root / ".edgeagent" / "config.yaml",
        root / ".edgeagent" / "config.yml",
        root / ".edgeagent" / "config.json",
    ]

    raw: Mapping[str, Any] = {}
    for p in candidates:
        raw = _load_json_or_yaml(p)
        if raw:
            break

    side_effects = raw.get("side_effects") if isinstance(raw, Mapping) else None
    if not isinstance(side_effects, Mapping):
        return ()

    rules: list[SideEffectRule] = []
    for effect, spec in side_effects.items():
        if not isinstance(effect, str) or not isinstance(spec, Mapping):
            continue

        severity = str(spec.get("severity", "medium")).lower()
        if severity not in {"critical", "high", "medium", "low"}:
            severity = "medium"

        patterns = spec.get("patterns", ())
        verbs = spec.get("verbs", ())
        targets = spec.get("targets", ())
        examples = spec.get("examples", ())

        rules.append(
            SideEffectRule(
                effect=effect,
                severity=severity,  # type: ignore[arg-type]
                description=str(spec.get("description", f"Repo-defined side effect: {effect}")),
                patterns=tuple(str(x) for x in patterns) if isinstance(patterns, list) else (),
                verbs=tuple(str(x) for x in verbs) if isinstance(verbs, list) else (),
                targets=tuple(str(x) for x in targets) if isinstance(targets, list) else (),
                examples=tuple(str(x) for x in examples) if isinstance(examples, list) else (),
                confidence=float(spec.get("confidence", 0.8)),
            )
        )

    return tuple(rules)


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------

def _match_rule(text: str, rule: SideEffectRule) -> list[SideEffectMatch]:
    matches: list[SideEffectMatch] = []
    normalized = normalize_identifier(text)
    tokens = token_set(text)

    for pattern in rule.patterns:
        rx = re.compile(pattern, re.I)
        if rx.search(text) or rx.search(normalized):
            matches.append(
                SideEffectMatch(
                    effect=rule.effect,
                    severity=rule.severity,
                    confidence=rule.confidence,
                    reason=f"Matched pattern /{pattern}/",
                    matched_by="regex",
                    description=rule.description,
                )
            )
            break

    if rule.verbs and rule.targets:
        verb_hit = next((v for v in rule.verbs if v.lower() in tokens), None)
        target_hit = next((t for t in rule.targets if t.lower() in tokens), None)
        if verb_hit and target_hit:
            matches.append(
                SideEffectMatch(
                    effect=rule.effect,
                    severity=rule.severity,
                    confidence=max(0.55, rule.confidence - 0.08),
                    reason=f"Matched action verb '{verb_hit}' with target '{target_hit}'",
                    matched_by="verb_target",
                    description=rule.description,
                )
            )

    return matches


def classify_side_effect_details(
    name_or_code: str,
    extra_rules: Iterable[SideEffectRule] = (),
) -> list[SideEffectMatch]:
    """Return detailed side-effect matches for a tool/function/code snippet."""
    matches: list[SideEffectMatch] = []
    seen: set[tuple[str, str]] = set()

    for rule in tuple(extra_rules) + BUILTIN_SIDE_EFFECT_RULES:
        for match in _match_rule(name_or_code, rule):
            key = (match.effect, match.matched_by)
            if key in seen:
                continue
            seen.add(key)
            matches.append(match)

    # Prefer highest severity/confidence first.
    severity_rank = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    return sorted(matches, key=lambda m: (severity_rank[m.severity], -m.confidence, m.effect))


def classify_side_effect(
    name_or_code: str,
    extra_rules: Iterable[SideEffectRule] = (),
) -> list[str]:
    """Backwards-compatible simple classifier.

    Returns only effect names, sorted by impact/confidence.
    """
    return sorted({m.effect for m in classify_side_effect_details(name_or_code, extra_rules)})


def impact_for_effect(effect: str, extra_rules: Iterable[SideEffectRule] = ()) -> str:
    """Backwards-compatible severity lookup."""
    for rule in tuple(extra_rules) + BUILTIN_SIDE_EFFECT_RULES:
        if rule.effect == effect:
            return rule.severity
    return "medium"


def is_high_impact_effect(effect: str, extra_rules: Iterable[SideEffectRule] = ()) -> bool:
    return impact_for_effect(effect, extra_rules) in {"high", "critical"}


def highest_impact(effects: Iterable[str], extra_rules: Iterable[SideEffectRule] = ()) -> Severity:
    severity_rank: dict[Severity, int] = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    best: Severity = "low"
    for effect in effects:
        sev = impact_for_effect(effect, extra_rules)  # type: ignore[assignment]
        if severity_rank[sev] < severity_rank[best]:  # type: ignore[index]
            best = sev  # type: ignore[assignment]
    return best


def is_likely_safe_read_only(name_or_code: str) -> bool:
    """Heuristic helper for analyzers.

    This does not prove safety. It only helps downgrade obvious read-only tools
    when no side effect was found.
    """
    normalized = normalize_identifier(name_or_code)
    safe_verbs = {"search", "list", "read", "get", "fetch", "lookup", "retrieve", "summarize", "classify", "calculate", "score"}
    unsafe_verbs = {
        "send", "create", "update", "delete", "remove", "write", "refund", "charge",
        "transfer", "deploy", "execute", "run", "grant", "revoke", "export", "upload",
    }
    tokens = set(normalized.split())
    return bool(tokens & safe_verbs) and not bool(tokens & unsafe_verbs)


def explain_side_effects(name_or_code: str, extra_rules: Iterable[SideEffectRule] = ()) -> str:
    matches = classify_side_effect_details(name_or_code, extra_rules)
    if not matches:
        return "No built-in side-effect rule matched."
    return "; ".join(
        f"{m.effect} ({m.severity}, {m.matched_by}: {m.reason})" for m in matches
    )
