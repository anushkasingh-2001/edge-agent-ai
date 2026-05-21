from __future__ import annotations

import json
import urllib.request
from pydantic import BaseModel


class EndpointProbeResult(BaseModel):
    url: str
    ok: bool
    status_code: int | None = None
    request_template: dict | None = None
    output_path: str | None = None
    error: str | None = None


def probe_chat_endpoint(url: str, timeout_seconds: float = 3.0) -> EndpointProbeResult:
    templates = [
        {"message": "hello"},
        {"prompt": "hello"},
        {"input": "hello"},
        {"messages": [{"role": "user", "content": "hello"}]},
    ]

    last_error = "probe failed"
    for body in templates:
        try:
            req = urllib.request.Request(
                url,
                data=json.dumps(body).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
                return EndpointProbeResult(
                    url=url,
                    ok=True,
                    status_code=resp.status,
                    request_template=body,
                    output_path=_guess_output_path(raw),
                )
        except Exception as exc:
            last_error = str(exc)

    return EndpointProbeResult(url=url, ok=False, error=last_error)


def _guess_output_path(raw: str) -> str | None:
    try:
        data = json.loads(raw)
    except Exception:
        return None
    for key in ["response", "answer", "output", "content", "message"]:
        if key in data:
            return key
    return None
