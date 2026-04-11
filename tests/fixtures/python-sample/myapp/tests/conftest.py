"""pytest fixtures."""

import pytest


@pytest.fixture
def db():
    return {"users": []}
