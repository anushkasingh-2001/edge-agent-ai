"""TS/React extractor/classifier regression tests for the precision fix.

These tests pin the semantic classification of inert TS/React syntax —
comments, type-only TS, module exports, React local state setters,
JSX event bindings, JSX text content, MUI ``sx`` style props, JSX
attribute object literals, FormData prep — so future TS projects
don't reintroduce the same noise that was observed in
``Smart-Multilingual-Meetings-Lectures-Assistant`` and
``Sales-dev-assistant``.

The contract: a dangerous-tools finding is ONLY emitted for actual
runtime calls / new-expressions to known side-effect APIs. Anything
that is purely declarative or local-state mutation must not classify.
"""

from __future__ import annotations

from edge_agent_scanner.engine import run_scan
from edge_agent_scanner.ir.builder import build_agent_ir
from edge_agent_scanner.ir.sinks import classify_side_effect
from edge_agent_scanner.walker import iter_scanned_files


def _dangerous(report) -> list:
    return [f for f in report.findings if f.rule_id == "dangerous-tools"]


def _scan(tmp_path, name: str, body: str):
    (tmp_path / name).write_text(body, encoding="utf-8")
    return run_scan(tmp_path)


# ---------------------------------------------------------------------------
# Classifier-level (unit) — these stay cheap and confirm the gates
# ---------------------------------------------------------------------------

def test_comment_line_with_export_keyword_does_not_classify() -> None:
    # `// Create a type for the API response data` produced a
    # `data_export_or_sharing` finding because of the loose
    # `(export|...|upload|...)` regex. Comments must short-circuit.
    assert classify_side_effect("// Create a type for the API response data") == []
    assert classify_side_effect("// upload the lecture file to s3 later") == []
    assert classify_side_effect("/* TODO: refactor sendEmail() */") == []
    assert classify_side_effect(" * publish to slack — side-effect call") == []


def test_jsx_text_string_literal_line_does_not_classify() -> None:
    # JSX text content like `"1. Upload audio or video file"` used to
    # fire the data-export regex. A plain string literal on its own
    # line is data, not a call.
    assert classify_side_effect('"1. Upload audio or video file"') == []
    assert classify_side_effect("'Submit'") == []


def test_object_property_with_non_call_rhs_does_not_classify() -> None:
    # ``message: msg.content`` and MUI sx props ``mt: 0.1`` triggered
    # outbound-message / browser-control findings via verb_target
    # matching. They are declarative data, not callables.
    assert classify_side_effect("message: msg.content,") == []
    assert classify_side_effect("mt: 0.1,") == []
    assert classify_side_effect("padding: 16,") == []
    assert classify_side_effect("backgroundColor: 'white',") == []


def test_parenthesised_english_text_does_not_classify() -> None:
    # ``Submit! (to know the summary of this content and ask questions)``
    # contains a paren but no callable. Must not classify.
    assert classify_side_effect("Submit! (to know the summary of this content and ask questions)") == []


def test_natural_language_with_upload_keyword_does_not_classify() -> None:
    # JSX text content that mentions ``upload`` / ``export`` words
    # without a callable.
    assert classify_side_effect("1. Upload audio or video file") == []
    assert classify_side_effect("Export the meeting summary") == []


def test_genuine_send_email_call_still_classifies() -> None:
    # The runtime-call gate must NOT silence real sends.
    effects = classify_side_effect("await sendEmail(payload)")
    assert "external_communication" in effects


def test_genuine_subprocess_still_classifies() -> None:
    effects = classify_side_effect("subprocess.check_output(['ffmpeg', '-i', input_path, out])")
    assert "code_execution" in effects


def test_axios_post_with_form_data_still_classifies_as_outbound() -> None:
    effects = classify_side_effect("axios.post('/minutes_maker', formData)")
    assert "network_mutation" in effects


def test_bare_tool_identifier_still_classifies() -> None:
    # ``refund_payment`` is a tool NAME passed by the Python extractor
    # to classify_side_effect — it has no call shape but must still
    # classify as a payment effect via regex.
    effects = classify_side_effect("refund_payment")
    assert "payment_or_money_movement" in effects


# ---------------------------------------------------------------------------
# End-to-end TS/React: scan a synthetic fixture and assert no FPs
# ---------------------------------------------------------------------------

def test_tsx_comments_do_not_produce_dangerous_findings(tmp_path) -> None:
    report = _scan(
        tmp_path,
        "Comments.tsx",
        "// Create a type for the API response data\n"
        "// upload the lecture file to s3 later\n"
        "/* TODO: sendEmail() */\n"
        "export const Comments = () => null;\n",
    )
    assert _dangerous(report) == [], (
        f"comments must never produce dangerous-tools findings, got: "
        f"{[(f.title, f.code) for f in _dangerous(report)]}"
    )


def test_typescript_type_aliases_do_not_produce_findings(tmp_path) -> None:
    report = _scan(
        tmp_path,
        "types.ts",
        "export type ApiResponseDataSchema = { id: string; data: unknown };\n"
        "export interface UploadRequest { file: File; category: string }\n"
        "export type { ApiResponseDataSchema };\n",
    )
    assert _dangerous(report) == []


def test_react_functional_component_export_does_not_produce_finding(tmp_path) -> None:
    # ``export const ChatBox: React.FC = () => {}`` had `()` so the old
    # declaration filter missed it and the loose `(export|...)` regex
    # fired. The new arrow-function declaration pattern catches it.
    report = _scan(
        tmp_path,
        "ChatBox.tsx",
        "import React from 'react';\n"
        "export const ChatBox: React.FC = () => {\n"
        "  return <div>chat</div>;\n"
        "};\n"
        "export default ChatBox;\n",
    )
    assert _dangerous(report) == []


def test_react_use_state_destructure_does_not_produce_finding(tmp_path) -> None:
    report = _scan(
        tmp_path,
        "Chat.tsx",
        "import React, { useState } from 'react';\n"
        "export const Chat = () => {\n"
        "  const [messages, setMessages] = useState([]);\n"
        "  const [input, setInput] = useState('');\n"
        "  const [isOpen, setIsOpen] = useState(false);\n"
        "  return null;\n"
        "};\n",
    )
    assert _dangerous(report) == []


def test_react_set_state_call_does_not_produce_finding(tmp_path) -> None:
    # Standalone `setMessages(...)` and `setIsOpen(...)` calls must be
    # recognised as React local state, not outbound side effects.
    report = _scan(
        tmp_path,
        "Chat.tsx",
        "import React, { useState } from 'react';\n"
        "export const Chat = () => {\n"
        "  const [messages, setMessages] = useState([]);\n"
        "  const [isOpen, setIsOpen] = useState(false);\n"
        "  const onSend = (text: string) => {\n"
        "    setMessages(prev => [...prev, { content: text, sender: 'user' }]);\n"
        "    setIsOpen(true);\n"
        "  };\n"
        "  return null;\n"
        "};\n",
    )
    assert _dangerous(report) == []


def test_jsx_onclick_local_setter_does_not_produce_finding(tmp_path) -> None:
    report = _scan(
        tmp_path,
        "Modal.tsx",
        "import React, { useState } from 'react';\n"
        "export const Modal = () => {\n"
        "  const [isOpen, setIsOpen] = useState(false);\n"
        "  return (\n"
        "    <div>\n"
        "      <button onClick={() => setIsOpen(true)}>open</button>\n"
        "      <button onClick={() => setIsOpen(false)}>close</button>\n"
        "    </div>\n"
        "  );\n"
        "};\n",
    )
    assert _dangerous(report) == []


def test_jsx_text_and_button_labels_do_not_produce_finding(tmp_path) -> None:
    # The strings inside <Typography>, <Button>, <FormLabel>,
    # helperText, placeholder etc. must not classify even when they
    # mention "Upload", "Submit", "Export", "Message".
    report = _scan(
        tmp_path,
        "Upload.tsx",
        "import React from 'react';\n"
        "import { Typography, Button, TextField } from '@mui/material';\n"
        "export const Upload = () => {\n"
        "  return (\n"
        "    <div>\n"
        "      <Typography>1. Upload audio or video file</Typography>\n"
        "      <Typography>Submit! (to know the summary of this content)</Typography>\n"
        "      <TextField helperText=\"e.g. mp3, mp4\" placeholder=\"choose file\" />\n"
        "      <Button>Export results</Button>\n"
        "    </div>\n"
        "  );\n"
        "};\n",
    )
    bad = _dangerous(report)
    assert bad == [], f"JSX text labels must not classify, got: {[f.title for f in bad]}"


def test_mui_sx_style_props_do_not_produce_finding(tmp_path) -> None:
    report = _scan(
        tmp_path,
        "Styled.tsx",
        "import React from 'react';\n"
        "import { Box } from '@mui/material';\n"
        "export const Styled = () => (\n"
        "  <Box sx={{\n"
        "    mt: 0.1,\n"
        "    mb: 2,\n"
        "    padding: 16,\n"
        "    backgroundColor: 'white',\n"
        "    boxShadow: 1,\n"
        "  }} />\n"
        ");\n",
    )
    assert _dangerous(report) == []


def test_jsx_props_object_literal_does_not_produce_finding(tmp_path) -> None:
    # `message: msg.content` triggered outbound-message via verb_target.
    # As a JSX prop object literal it has no callable.
    report = _scan(
        tmp_path,
        "MessageList.tsx",
        "import React from 'react';\n"
        "export const MessageList = ({ messages }) => (\n"
        "  <ul>\n"
        "    {messages.map(msg => (\n"
        "      <li key={msg.id}>\n"
        "        <Message message={{ content: msg.content, sender: msg.sender }} />\n"
        "      </li>\n"
        "    ))}\n"
        "  </ul>\n"
        ");\n",
    )
    # Allowed: nothing dangerous in this file.
    assert _dangerous(report) == []


def test_bare_jsx_component_does_not_produce_outbound_or_crm(tmp_path) -> None:
    # ``<MessageList />`` used to fire outbound-message via verb_target.
    report = _scan(
        tmp_path,
        "Wrap.tsx",
        "import React from 'react';\n"
        "import { MessageList } from './MessageList';\n"
        "export const Wrap = () => <MessageList />;\n",
    )
    bad = [
        f for f in _dangerous(report)
        if "outbound" in f.title.lower() or "crm" in f.title.lower()
    ]
    assert bad == []


def test_form_data_decl_and_append_do_not_produce_findings(tmp_path) -> None:
    # FormData creation + .append() preparation must be suppressed —
    # only the axios.post sink should fire. Tested separately below.
    report = _scan(
        tmp_path,
        "FormPrep.tsx",
        "import React from 'react';\n"
        "export const FormPrep = () => {\n"
        "  const handleSubmit = async (e: React.FormEvent) => {\n"
        "    const formData = new FormData();\n"
        "    formData.append('file', new Blob());\n"
        "    formData.append('filename', 'audio.mp3');\n"
        "    formData.append('category', 'lecture');\n"
        "  };\n"
        "  return null;\n"
        "};\n",
    )
    # No call to axios/fetch ⇒ no dangerous finding at all.
    assert _dangerous(report) == []


# ---------------------------------------------------------------------------
# Tree-sitter parsing should not introduce extra noise
# ---------------------------------------------------------------------------

def test_ir_build_collects_react_setters_per_file(tmp_path) -> None:
    """Smoke test the extractor's first-pass collection so the
    suppression of setMessages/setIsOpen is provably tied to a
    useState binding in the same file.
    """
    body = (
        "import React, { useState } from 'react';\n"
        "const [messages, setMessages] = useState([]);\n"
        "const [_, setOther] = useState(0);\n"
        "setMessages(prev => prev);\n"
        "setOther(1);\n"
    )
    (tmp_path / "x.tsx").write_text(body, encoding="utf-8")
    files = list(iter_scanned_files(tmp_path))
    ir = build_agent_ir(files, repo_root=tmp_path)
    # The fixture has no real outbound calls; setters are suppressed.
    assert all(s.kind != "external_communication" for s in ir.sinks)
    assert all(s.kind != "crm_or_campaign_write" for s in ir.sinks)
