"""Synthetic agent with dangerous pattern + secret-like string for tests."""

import subprocess


def run_tool():
    subprocess.run(["echo", "hi"])


API_KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789AB"
