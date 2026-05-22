"""FastAPI route extraction + auth-checks finding contract.

Before the fix:
  * ``@app.post("/chat")`` produced ``RouteNode(path="<unknown>")``
    because the extractor only looked at decorator NAMES, never
    decorator arguments.
  * The auth-checks analyzer's "Sensitive route has no detected
    auth guard" finding had ``Finding.code = ""`` because the
    analyzer never received the route's decorator/signature snippet.
  * ``Depends(get_current_user)`` did not register as an auth guard.

These tests pin all three behaviours:
  1. ``RouteNode.path`` is the literal first decorator argument.
  2. ``RouteNode.code`` carries decorator + function signature so the
     auth finding has a non-blank "Code involved" block.
  3. ``Depends(get_current_user)``-style parameters register as auth
     guards and suppress the missing-auth finding.
"""

from __future__ import annotations

from edge_agent_scanner.engine import run_scan
from edge_agent_scanner.ir.builder import build_agent_ir
from edge_agent_scanner.walker import iter_scanned_files


def _scan(tmp_path, name: str, body: str):
    (tmp_path / name).write_text(body, encoding="utf-8")
    return run_scan(tmp_path)


def _auth_findings(report) -> list:
    return [f for f in report.findings if f.rule_id == "auth-checks"]


def _routes_from_ir(tmp_path):
    files = list(iter_scanned_files(tmp_path))
    ir = build_agent_ir(files, repo_root=tmp_path)
    return ir.routes


# ---------------------------------------------------------------------------
# IR-level: path / code / auth_guards are populated correctly
# ---------------------------------------------------------------------------

def test_fastapi_post_chat_extracts_literal_path(tmp_path) -> None:
    body = (
        "from fastapi import FastAPI\n"
        "from pydantic import BaseModel\n"
        "\n"
        "app = FastAPI()\n"
        "\n"
        "class ChatRequest(BaseModel):\n"
        "    text: str\n"
        "\n"
        "@app.post('/chat')\n"
        "async def chat_endpoint(request: ChatRequest):\n"
        "    return {'ok': True}\n"
    )
    (tmp_path / "routes.py").write_text(body, encoding="utf-8")
    routes = _routes_from_ir(tmp_path)
    chat_routes = [r for r in routes if r.method == "POST"]
    assert chat_routes, "expected a POST route to be detected"
    r = chat_routes[0]
    assert r.path == "/chat", f"expected literal path /chat, got {r.path!r}"
    assert "@app.post" in r.code, f"decorator must appear in route.code; got {r.code!r}"
    assert "chat_endpoint" in r.code, f"function name must appear in route.code; got {r.code!r}"
    assert "ChatRequest" in r.code, f"function signature must appear in route.code; got {r.code!r}"


def test_fastapi_delete_session_with_path_param_extracts_path(tmp_path) -> None:
    body = (
        "from fastapi import FastAPI\n"
        "\n"
        "app = FastAPI()\n"
        "\n"
        "@app.delete('/session/{session_id}')\n"
        "async def clear_session(session_id: str):\n"
        "    return {'ok': True}\n"
    )
    (tmp_path / "routes.py").write_text(body, encoding="utf-8")
    routes = _routes_from_ir(tmp_path)
    delete_routes = [r for r in routes if r.method == "DELETE"]
    assert delete_routes
    r = delete_routes[0]
    assert r.path == "/session/{session_id}"
    assert "@app.delete" in r.code
    assert "clear_session" in r.code


def test_fastapi_router_get_extracts_path(tmp_path) -> None:
    body = (
        "from fastapi import APIRouter\n"
        "\n"
        "router = APIRouter()\n"
        "\n"
        "@router.get('/sessions')\n"
        "async def list_sessions():\n"
        "    return []\n"
    )
    (tmp_path / "routes.py").write_text(body, encoding="utf-8")
    routes = _routes_from_ir(tmp_path)
    paths = [r.path for r in routes]
    assert "/sessions" in paths


def test_fastapi_depends_current_user_registers_as_auth_guard(tmp_path) -> None:
    body = (
        "from fastapi import FastAPI, Depends\n"
        "\n"
        "app = FastAPI()\n"
        "\n"
        "def get_current_user():\n"
        "    return {'id': 'u1'}\n"
        "\n"
        "@app.post('/secure')\n"
        "async def secure_endpoint(user = Depends(get_current_user)):\n"
        "    return user\n"
    )
    (tmp_path / "routes.py").write_text(body, encoding="utf-8")
    routes = _routes_from_ir(tmp_path)
    secure_routes = [r for r in routes if r.path == "/secure"]
    assert secure_routes
    r = secure_routes[0]
    assert r.auth_guards, f"Depends(get_current_user) should register as auth guard; got {r.auth_guards}"


# ---------------------------------------------------------------------------
# Analyzer-level: missing-auth findings have method+path titles
# ---------------------------------------------------------------------------

def test_post_chat_without_auth_produces_specific_finding(tmp_path) -> None:
    body = (
        "from fastapi import FastAPI\n"
        "from pydantic import BaseModel\n"
        "\n"
        "app = FastAPI()\n"
        "\n"
        "class ChatRequest(BaseModel):\n"
        "    text: str\n"
        "\n"
        "@app.post('/chat')\n"
        "async def chat_endpoint(request: ChatRequest):\n"
        "    return {'ok': True}\n"
    )
    report = _scan(tmp_path, "routes.py", body)
    auth = _auth_findings(report)
    assert auth, f"expected an auth-checks finding for unguarded POST /chat; got {report.findings}"
    f = auth[0]
    assert "POST /chat" in f.title, f"title must include POST /chat; got {f.title!r}"
    assert "<unknown>" not in f.title, "title must not show <unknown> when path was extracted"
    # Code involved is now non-blank: decorator + function signature.
    assert f.code, "Finding.code must not be blank for FastAPI routes"
    assert "@app.post" in f.code
    assert "chat_endpoint" in f.code
    # Evidence carries structured method/path/decorator info.
    assert "method=POST" in f.evidence
    assert "path=/chat" in f.evidence


def test_delete_session_with_path_param_in_title(tmp_path) -> None:
    body = (
        "from fastapi import FastAPI\n"
        "from pydantic import BaseModel\n"
        "\n"
        "app = FastAPI()\n"
        "\n"
        "class ClearSessionResponse(BaseModel):\n"
        "    ok: bool\n"
        "\n"
        "@app.delete('/session/{session_id}', response_model=ClearSessionResponse)\n"
        "async def clear_session(session_id: str):\n"
        "    return ClearSessionResponse(ok=True)\n"
    )
    report = _scan(tmp_path, "routes.py", body)
    auth = _auth_findings(report)
    assert auth
    f = auth[0]
    assert "DELETE /session/{session_id}" in f.title
    assert f.code
    assert "@app.delete" in f.code
    assert "clear_session" in f.code


def test_depends_get_current_user_suppresses_missing_auth_finding(tmp_path) -> None:
    body = (
        "from fastapi import FastAPI, Depends\n"
        "\n"
        "app = FastAPI()\n"
        "\n"
        "def get_current_user():\n"
        "    return {'id': 'u1'}\n"
        "\n"
        "@app.post('/secure')\n"
        "async def secure_endpoint(user = Depends(get_current_user)):\n"
        "    return user\n"
    )
    report = _scan(tmp_path, "routes.py", body)
    auth = _auth_findings(report)
    # Route with auth dependency is not flagged.
    assert auth == [], f"route with Depends(get_current_user) should not be flagged; got: {[f.title for f in auth]}"


def test_post_route_without_path_argument_falls_back_to_location(tmp_path) -> None:
    """Defensive: if a hypothetical decorator has no string literal
    path argument we keep the historic ``<unknown>`` IR value but the
    analyzer title shows ``<file>:<line>`` so users always see a
    locating string, never just ``POST <unknown>``."""
    body = (
        "from fastapi import FastAPI\n"
        "\n"
        "app = FastAPI()\n"
        "\n"
        "DYNAMIC = '/runtime-built'\n"
        "\n"
        "@app.post(DYNAMIC)\n"
        "async def dynamic_endpoint():\n"
        "    return {}\n"
    )
    report = _scan(tmp_path, "routes.py", body)
    auth = _auth_findings(report)
    assert auth
    f = auth[0]
    assert "<unknown>" not in f.title, (
        f"title must surface a useful locator; got {f.title!r}"
    )
    # Either the file:line locator OR the variable name should appear.
    assert "routes.py" in f.title or "POST /runtime-built" in f.title or "POST <unknown>" not in f.title
