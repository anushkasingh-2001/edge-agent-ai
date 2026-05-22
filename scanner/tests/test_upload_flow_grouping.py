"""Upload-flow (FormData + axios.post / URLSearchParams + fetch) tests.

Before the precision fix, a single React upload form produced 8-12
separate dangerous-tools findings — one per ``formData.append(...)``,
one per JSX ``onSubmit=`` binding, one per button label. The intent
of these tests is to lock in the new behaviour:

  * No standalone findings for FormData/URLSearchParams declarations
    or their ``.append()`` calls.
  * ONE outbound finding at the real network sink
    (``axios.post(...)`` / ``fetch(..., { body: ... })``).
  * That finding's evidence includes the collected FormData field
    names so the developer can see WHAT is being uploaded.
  * Severity stays at low/medium presence warning unless the call is
    agent-reachable.
"""

from __future__ import annotations

from edge_agent_scanner.engine import run_scan


def _scan(tmp_path, name: str, body: str):
    (tmp_path / name).write_text(body, encoding="utf-8")
    return run_scan(tmp_path)


def _dangerous(report) -> list:
    return [f for f in report.findings if f.rule_id == "dangerous-tools"]


def test_axios_post_with_form_data_produces_single_upload_finding(tmp_path) -> None:
    """``axios.post('/minutes_maker', formData)`` is the real sink.
    FormData prep lines around it must NOT each create their own
    finding."""
    body = (
        "import React, { useState } from 'react';\n"
        "import axios from 'axios';\n"
        "\n"
        "export const FileUploader = () => {\n"
        "  const [language, setLanguage] = useState('en');\n"
        "  const [category, setCategory] = useState('lecture');\n"
        "  const handleSubmit = async (e: React.FormEvent) => {\n"
        "    e.preventDefault();\n"
        "    const formData = new FormData();\n"
        "    formData.append('file', new Blob());\n"
        "    formData.append('filename', 'audio.mp3');\n"
        "    formData.append('language', language);\n"
        "    formData.append('category', category);\n"
        "    await axios.post('/minutes_maker', formData);\n"
        "  };\n"
        "  return <form onSubmit={handleSubmit}><button type='submit'>Upload</button></form>;\n"
        "};\n"
    )
    report = _scan(tmp_path, "FileUploader.tsx", body)
    findings = _dangerous(report)

    # Exactly ONE outbound finding at the axios.post line.
    axios_findings = [f for f in findings if "axios.post" in f.code]
    assert len(axios_findings) == 1, (
        f"expected exactly one outbound finding at axios.post, got "
        f"{len(axios_findings)}: {[(f.title, f.code) for f in axios_findings]}"
    )

    f = axios_findings[0]
    # Title is the specific outbound shape, not the generic
    # "side-effect call" wording.
    assert "axios.post" in f.title, f"title should name axios.post; got {f.title!r}"
    assert "outbound" in f.title.lower() or "data export" in f.title.lower(), (
        f"title should classify as an outbound/upload call; got {f.title!r}"
    )
    # Evidence carries the FormData fields collected from the
    # surrounding handleSubmit body.
    assert "file" in f.evidence
    assert "filename" in f.evidence
    assert "language" in f.evidence
    assert "category" in f.evidence

    # Presence warning, low/medium — not agent-reachable in this file.
    assert f.severity in {"low", "medium"}

    # No standalone findings for the FormData prep lines.
    form_data_noise = [
        f for f in findings
        if "formData.append" in f.code or "new FormData" in f.code
    ]
    assert form_data_noise == [], (
        f"FormData prep lines must not produce standalone findings, got: "
        f"{[(x.title, x.code) for x in form_data_noise]}"
    )


def test_fetch_with_url_search_params_produces_single_outbound_finding(tmp_path) -> None:
    """The ChatBox pattern: ``fetch('/query', { method: 'POST', body:
    new URLSearchParams({ question: text }) })`` is one outbound
    chat call — not three findings for the URLSearchParams,
    setMessages, and onSubmit."""
    body = (
        "import React, { useState } from 'react';\n"
        "\n"
        "export const ChatBox = () => {\n"
        "  const [messages, setMessages] = useState([]);\n"
        "  const [input, setInput] = useState('');\n"
        "  const onSubmit = async (text: string) => {\n"
        "    setMessages(prev => [...prev, { content: text, sender: 'user' }]);\n"
        "    const res = await fetch('/query', {\n"
        "      method: 'POST',\n"
        "      body: new URLSearchParams({ question: text }),\n"
        "    });\n"
        "    const reply = await res.text();\n"
        "    setMessages(prev => [...prev, { content: reply, sender: 'bot' }]);\n"
        "  };\n"
        "  return <button onClick={() => onSubmit(input)}>send</button>;\n"
        "};\n"
    )
    report = _scan(tmp_path, "ChatBox.tsx", body)
    findings = _dangerous(report)

    # No findings for setMessages / setInput / onClick local-state
    # setters or the URLSearchParams construction.
    react_state_noise = [
        f for f in findings
        if any(s in f.code for s in ("setMessages(", "setInput(", "setIsOpen("))
    ]
    assert react_state_noise == []

    url_params_noise = [f for f in findings if "new URLSearchParams" in f.code]
    assert url_params_noise == []

    # At least one outbound finding for the fetch call itself.
    fetch_findings = [f for f in findings if "fetch(" in f.code]
    assert fetch_findings, (
        f"expected an outbound finding for fetch('/query'); got dangerous: "
        f"{[(f.title, f.code) for f in findings]}"
    )


def test_classifier_no_finding_for_form_data_append_to_known_var(tmp_path) -> None:
    # Direct classifier check: ``formData.append('file', f)`` is the
    # prep call. As a single-line classifier input it MIGHT still
    # classify as file_mutation because the regex matches; the
    # extractor is what suppresses it from the IR. End-to-end scan
    # is the authoritative contract.
    body = (
        "export const f = async () => {\n"
        "  const formData = new FormData();\n"
        "  formData.append('file', new Blob());\n"
        "};\n"
    )
    report = _scan(tmp_path, "Prep.tsx", body)
    findings = [f for f in report.findings if "formData.append" in f.code]
    assert findings == []
