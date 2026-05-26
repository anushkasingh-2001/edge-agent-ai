"""Supply-chain + transport analyzers.

Two rules live here, on purpose: they share the same evidence model
(downloads of model/binary artifacts), and they reinforce each other.
TLS verification disabled on a download of `inswapper_128.onnx` is
worse than either signal in isolation, so combining them in one file
lets us elevate severity when both fire on the same call site.

Rules implemented
-----------------
1. ``model-supply-chain-risk``
   A model-like artifact (``.onnx``, ``.pt``, ``.pth``, ``.safetensors``,
   ``.bin``, ``.pkl``, ``.joblib``, ``.h5``, ``.gguf``, ``.ckpt``) is
   downloaded WITHOUT integrity verification, OR from an unpinned
   revision, OR with TLS disabled. The model is later loaded by an
   inference framework (ONNXRuntime / PyTorch / TF / pickle / joblib)
   in the same project — making this a remote-code-load risk.

2. ``tls-verification-disabled``
   ``ssl._create_unverified_context()`` / ``verify=False`` /
   ``InsecureRequestWarning`` suppressed. Severity scales with WHAT is
   being downloaded: a model artifact is medium/high; a generic HTTP
   request is medium; a localhost/example URL is low/info.

Design notes
------------
* Detection is line-oriented over ``ScannedFile.lines`` with a small
  forward window for the per-call follow-up (e.g. checksum check on the
  next line). This matches the style of ``root_causes.py``.
* Findings carry a structured ``confidence_features.metadata`` of
  ``{kind, ext, url, has_checksum, pinned, tls_verified}`` so the AI
  explanation layer can reflect the exact gaps in the dropdown.
* The two rules are deliberately kept on one analyzer entry
  (``analyze_supply_chain``) so ``engine.py`` adds exactly one line.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from edge_agent_scanner.analyzers._utils import make_finding
from edge_agent_scanner.analyzers.confidence import ConfidenceFeatures, is_prod_file
from edge_agent_scanner.analyzers.escalation import annotate_finding
from edge_agent_scanner.ir.models import AgentIR, CodeLocation
from edge_agent_scanner.ir.redact import redact_secrets
from edge_agent_scanner.walker import ScannedFile

RULE_MODEL_SUPPLY_CHAIN = "model-supply-chain-risk"
RULE_TLS_DISABLED = "tls-verification-disabled"

# Model / binary artifact extensions that imply remote code load when
# subsequently fed to an inference framework. Order matters only for
# the URL extractor below (longest first).
_MODEL_EXTS = (
    ".safetensors",
    ".onnx",
    ".gguf",
    ".joblib",
    ".pth",
    ".ckpt",
    ".pkl",
    ".bin",
    ".pt",
    ".h5",
)

# URL pulled out of a download line; we capture both `"...url..."`
# string literals and bare URLs in the line.
_URL_RX = re.compile(
    r"""(?:["']|^|\s)(https?://[^"'<>\s)]+)""", re.I,
)

# Download call shapes we want to inspect. The check below is broad on
# purpose — the model-ext filter is what gates the finding, not this
# regex. Including subprocess `curl/wget` so shell-driven downloads are
# also caught.
_DOWNLOAD_CALL_RX = re.compile(
    r"\b("
    r"urllib\.request\.urlopen|urllib\.request\.urlretrieve|"
    r"requests\.(?:get|post)|httpx\.(?:get|post|stream)|"
    r"hf_hub_download|snapshot_download|huggingface_hub\.\w+|"
    r"torch\.hub\.load|tf\.keras\.utils\.get_file|"
    r"wget\.download|smart_open\.|"
    r"conditional_download|safe_download|download_file|"
    r"subprocess\.\w*\(.*(?:curl|wget)|"
    r"fetch\s*\("
    r")",
    re.I,
)

# Hugging Face hub helpers — special-cased because they expose a
# `revision=` knob that we want to require be pinned to a SHA.
_HF_HUB_RX = re.compile(r"\b(hf_hub_download|snapshot_download)\s*\(", re.I)
_HF_REVISION_KW_RX = re.compile(r"""revision\s*=\s*['"]([^'"]+)['"]""", re.I)
_HF_PINNED_SHA_RX = re.compile(r"^[a-f0-9]{7,40}$", re.I)  # commit-ish

# Integrity verification signals on the same line or within a small
# forward window. Any match counts.
_CHECKSUM_RX = re.compile(
    r"\b("
    r"hashlib\.(?:sha256|sha512|blake2b|md5)|"
    r"sha256\s*=|sha512\s*=|checksum|digest|"
    r"expected_(?:hash|digest|sha256)|"
    r"verify_hash|verify_checksum|"
    r"hmac\.compare_digest"
    r")",
    re.I,
)

# Inference-framework loaders that turn a downloaded artifact into
# executable behaviour. Used to elevate severity when a model file
# downloaded above is referenced by name in one of these calls
# somewhere in the same file.
_MODEL_LOADER_RX = re.compile(
    r"\b("
    r"onnxruntime\.InferenceSession|onnx\.load|"
    r"torch\.load|torch\.jit\.load|"
    r"tf\.keras\.models\.load_model|tensorflow\.keras\.models\.load_model|"
    r"joblib\.load|pickle\.load|pickle\.loads|"
    r"transformers\.AutoModel.*from_pretrained|"
    r"AutoModel\.from_pretrained|AutoTokenizer\.from_pretrained|"
    r"InferenceSession"
    r")",
    re.I,
)

# Patterns that indicate TLS verification is disabled.
_TLS_DISABLED_PATTERNS = [
    re.compile(r"ssl\._create_unverified_context\s*\(", re.I),
    re.compile(r"ssl\.create_default_context\([^)]*verify_mode\s*=\s*ssl\.CERT_NONE", re.I),
    re.compile(r"verify\s*=\s*False", re.I),
    re.compile(r"requests\.packages\.urllib3\.disable_warnings\s*\(", re.I),
    re.compile(r"urllib3\.disable_warnings\s*\(", re.I),
    re.compile(r"CURLOPT_SSL_VERIFYPEER\s*=?\s*(?:0|False)", re.I),
    re.compile(r"\b--no-check-certificate\b", re.I),  # wget
    re.compile(r"\b-k\b\s+(?:https?:/)", re.I),       # curl -k <url>
]

# Test/local origin downgrades for the TLS rule.
_LOCAL_URL_RX = re.compile(
    r"https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|example\.com|test\.example)",
    re.I,
)


@dataclass
class _Hit:
    line_no: int
    text: str
    url: str | None
    ext: str | None


def _loc(sf: ScannedFile, line_no: int) -> CodeLocation:
    return CodeLocation(file=sf.rel_path, start_line=line_no, end_line=line_no)


def _model_url_in(line: str) -> tuple[str | None, str | None]:
    """Return ``(url, ext)`` if the line references a model artifact URL.

    Treats either a fully-qualified ``https://.../foo.onnx`` URL or a
    bare ``"foo.onnx"`` string literal as a match. The bare-literal case
    is critical for HF helpers (``hf_hub_download(repo, "model.bin")``).
    """
    for m in _URL_RX.finditer(line):
        url = m.group(1)
        lower = url.lower()
        for ext in _MODEL_EXTS:
            if lower.endswith(ext) or f"{ext}?" in lower:
                return url, ext
    # Bare quoted artifact name like ``"model.onnx"`` (no URL on the
    # same line — common for HF helpers that build the URL internally).
    ext_alt = "|".join(re.escape(e) for e in _MODEL_EXTS)
    bare = re.search(
        r"""['"][^'"]+(""" + ext_alt + r""")['"]""",
        line,
    )
    if bare:
        return None, bare.group(1)
    return None, None


def _has_checksum_near(lines: list[str], idx: int, forward: int = 12) -> bool:
    """True iff a checksum/verify call appears within ±forward lines."""
    lo = max(0, idx - forward)
    hi = min(len(lines), idx + forward + 1)
    return any(_CHECKSUM_RX.search(l) for l in lines[lo:hi])


def _has_loader_in_file(lines: list[str]) -> bool:
    """True iff the same file later loads a model via a known framework."""
    return any(_MODEL_LOADER_RX.search(l) for l in lines)


def _tls_disabled_on_line(text: str) -> str | None:
    """Return the disabling pattern name when this line disables TLS, else None."""
    for rx in _TLS_DISABLED_PATTERNS:
        if rx.search(text):
            return rx.pattern
    return None


def _detect_model_supply_chain(sf: ScannedFile) -> list:
    out: list = []
    lines = sf.lines
    file_loads_model = _has_loader_in_file(lines)

    for i, raw in enumerate(lines):
        # Hugging Face hub helpers: even without an explicit URL we can
        # decide pinning + checksum here.
        is_hf = bool(_HF_HUB_RX.search(raw))
        is_download = bool(_DOWNLOAD_CALL_RX.search(raw)) or is_hf
        if not is_download:
            continue

        url, ext = _model_url_in(raw)
        # An HF call without a model ext on the same line still counts —
        # it implicitly returns a `.bin`/`.safetensors`. Treat as model.
        if not ext and not is_hf:
            continue

        has_checksum = _has_checksum_near(lines, i)
        tls_off = _tls_disabled_on_line(raw) or _tls_disabled_on_line(
            "\n".join(lines[max(0, i - 4):i])
        )

        # Pinning: HF revision must be a commit-ish; HTTP URL pinning
        # is best-effort (we can't verify immutability of a CDN URL but
        # ``resolve/main`` vs ``resolve/<sha>`` is a strong signal).
        pinned = True
        revision_value: str | None = None
        if is_hf:
            window_text = "\n".join(lines[i:min(len(lines), i + 6)])
            m = _HF_REVISION_KW_RX.search(window_text)
            if m:
                revision_value = m.group(1)
                pinned = bool(_HF_PINNED_SHA_RX.match(revision_value))
            else:
                # No revision kwarg → defaults to "main", which is mutable.
                pinned = False
        elif url:
            if "/resolve/main/" in url or "/blob/main/" in url:
                pinned = False
            else:
                # Detect commit-ish in the path: /<sha>/file.onnx
                pinned = bool(re.search(r"/[a-f0-9]{7,40}/[^/]+\.[a-z0-9]+$", url, re.I))

        # Severity ladder:
        #   * tls_off OR (no checksum AND model later loaded)   → high
        #   * no checksum OR not pinned                          → medium
        #   * everything fine                                    → skip
        if not has_checksum and (file_loads_model or tls_off):
            sev = "high"
            conf = 0.9
        elif not has_checksum or not pinned or tls_off:
            sev = "medium"
            conf = 0.75
        else:
            continue  # download is integrity-checked; no finding

        f = make_finding(
            rule_id=RULE_MODEL_SUPPLY_CHAIN,
            severity=sev,
            category="Supply chain",
            title=(
                "Remote model artifact download without checksum/signature verification"
                if not has_checksum
                else "Remote model artifact pulled from an unpinned/mutable revision"
            ),
            location=_loc(sf, i + 1),
            reason=(
                "A model artifact ("
                + (ext or "binary")
                + ") is downloaded at runtime"
                + (
                    " with TLS certificate verification disabled,"
                    if tls_off
                    else ""
                )
                + (" without a SHA256 / signature check" if not has_checksum else "")
                + (
                    f", from an unpinned revision (revision={revision_value or 'main'})"
                    if not pinned
                    else ""
                )
                + ". An attacker who controls the upstream URL (or the CDN cache, "
                "or your TLS path) can swap the file. Once "
                + (
                    "ONNXRuntime / torch.load / pickle later loads it"
                    if file_loads_model
                    else "any framework loads it"
                )
                + ", that swap becomes remote code load."
            ),
            suggested_fix=(
                "Pin the artifact to an immutable revision (Hugging Face: commit "
                "SHA via ``revision=``; HTTP: a commit-pinned URL). Compute SHA256 "
                "after download and compare against an expected value bundled in "
                "the repo. Keep TLS verification ON. Prefer signed model artifacts "
                "(Sigstore / model signing) when the upstream supports it. Fail "
                "closed on any mismatch."
            ),
            evidence=raw.strip()[:200],
            code=redact_secrets(raw),
            confidence=conf,
        )
        annotate_finding(
            f,
            ConfidenceFeatures(
                sink_impact=sev,
                source_untrusted=True,  # the upstream is external by definition
                unguarded_path_exists=True,
                path_length=2,
                partial_guard=has_checksum or pinned,
                ir_evidence=True,
                exact_sink_match=True,
                prod_file=is_prod_file(sf.rel_path),
            ),
        )
        # Stamp the structured supply-chain context the explanation
        # layer can use to produce a precise message.
        try:
            f.confidence_features = {
                **(f.confidence_features or {}),
                "supply_chain": {
                    "url": url,
                    "ext": ext,
                    "has_checksum": has_checksum,
                    "pinned": pinned,
                    "tls_off": bool(tls_off),
                    "revision": revision_value,
                    "loaded_in_file": file_loads_model,
                },
            }
        except Exception:
            pass
        out.append(f)
    return out


def _detect_tls_disabled(sf: ScannedFile) -> list:
    out: list = []
    lines = sf.lines
    for i, raw in enumerate(lines):
        match = _tls_disabled_on_line(raw)
        if not match:
            continue

        # Severity ladder based on what is being requested.
        nearby = "\n".join(lines[max(0, i - 3): min(len(lines), i + 4)])
        downloads_model = any(
            ext in nearby.lower()
            for ext in _MODEL_EXTS
            + (".dll", ".so", ".dylib", ".sh", ".ps1", ".bat", ".py")
        )
        is_local = bool(_LOCAL_URL_RX.search(nearby))
        if is_local and not downloads_model:
            sev, conf = "low", 0.5
        elif downloads_model:
            sev, conf = "high", 0.9
        else:
            sev, conf = "medium", 0.75

        f = make_finding(
            rule_id=RULE_TLS_DISABLED,
            severity=sev,
            category="Transport security",
            title="TLS certificate verification disabled for outbound request",
            location=_loc(sf, i + 1),
            reason=(
                "This call disables TLS certificate verification — the connection will "
                "trust ANY server certificate, including one presented by an "
                "active-MITM attacker on the path. "
                + (
                    "Because the same code path downloads a model/binary/script, "
                    "the MITM can substitute executable content."
                    if downloads_model
                    else "The data exchanged on this connection is no longer "
                    "authenticated."
                )
            ),
            suggested_fix=(
                "Remove the verification bypass. If you need a non-public CA, ship "
                "the CA bundle and pass it via ``verify=<path>``/``cafile=`` instead "
                "of disabling verification. For internal hostname mismatches, fix "
                "the hostname; don't suppress the check."
            ),
            evidence=raw.strip()[:200],
            code=redact_secrets(raw),
            confidence=conf,
        )
        annotate_finding(
            f,
            ConfidenceFeatures(
                sink_impact=sev,
                source_untrusted=True,
                unguarded_path_exists=True,
                path_length=1,
                partial_guard=False,
                ir_evidence=True,
                exact_sink_match=True,
                prod_file=is_prod_file(sf.rel_path),
            ),
        )
        out.append(f)
    return out


def analyze_supply_chain(ir: AgentIR, files: list[ScannedFile]) -> list:
    """Single analyzer entry point — wired into ``engine.run_scan``.

    The ``ir`` argument is accepted for signature uniformity with the
    other analyzers; this pass is line-oriented over the source.
    """
    findings: list = []
    for sf in files:
        lower = sf.rel_path.lower()
        if lower.endswith((".md", ".txt", ".lock", ".json")):
            continue
        findings.extend(_detect_model_supply_chain(sf))
        findings.extend(_detect_tls_disabled(sf))
    return findings
