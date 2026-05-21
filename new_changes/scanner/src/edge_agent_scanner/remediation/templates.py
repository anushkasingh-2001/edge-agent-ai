APPROVAL_GATE_TEMPLATE = """if not confirm_before_execute(action={action!r}, args={args}):
    raise PermissionError("User approval required before executing high-impact action")
"""
