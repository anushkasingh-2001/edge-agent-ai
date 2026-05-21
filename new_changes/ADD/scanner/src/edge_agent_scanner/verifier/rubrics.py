RUBRICS = {
    "dangerous-tools": "True positive only if this is agent-callable and can cause a real side effect.",
    "human-approval": "True positive only if a high-impact tool path can execute without approval/policy guard.",
    "prompt-injection": "True positive only if untrusted content can affect instructions, memory, or tool args.",
    "prompt-contract": "True positive only if an operational prompt lacks necessary constraints.",
    "auth-checks": "True positive only if sensitive action/data is reachable without authz/authn guard.",
}
