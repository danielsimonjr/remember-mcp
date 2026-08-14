"""Package version is a single source of truth: pyproject.toml."""
import tomllib
from pathlib import Path

from remember import __version__

REPO = Path(__file__).resolve().parent.parent


def test_dunder_version_matches_pyproject():
    data = tomllib.loads((REPO / "pyproject.toml").read_text(encoding="utf-8"))
    assert __version__ == data["project"]["version"], (
        f"remember.__version__ ({__version__}) drifted from "
        f"pyproject.toml ({data['project']['version']})"
    )
