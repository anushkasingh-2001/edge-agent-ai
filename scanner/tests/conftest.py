"""Pytest fixtures."""

from __future__ import annotations

import pytest


@pytest.fixture
def empty_repo(tmp_path):
    """Empty directory as scan root."""
    return tmp_path
