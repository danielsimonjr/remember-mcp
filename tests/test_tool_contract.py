"""
Tool-registration contract for the MCP surface.

Replaces ``tests/test_tools.py`` and ``tests/test_tools_async.py``, which were
near-identical copies of each other and enforced nothing:

* Neither contained a single ``assert`` — both only ``print``\\ ed, and both
  wrapped the call in ``try/except`` that swallowed the failure and printed a
  traceback. They could not fail even when run by hand.
* Neither was collectable by pytest. Each defined ``async def main()`` inside an
  ``if __name__ == "__main__"`` block, so despite the ``test_`` filenames pytest
  collected **zero** tests from them.
* Both called ``app.get_tools()`` — the **fastmcp 2.x** API. This project
  requires ``fastmcp>=3.2.0``, where it is ``list_tools()``. So they were also
  broken against the installed dependency, and nothing reported it.

Registration is the thing worth pinning here: a tool that silently stops being
registered is invisible to every other test in this suite, because the rest
exercise ``RememberSystem``/``FileIndexer`` directly and never go through the
MCP layer at all.
"""

import pytest

from server import app

# The full advertised surface. Update deliberately: removing a name here is a
# breaking change for any client that calls it.
EXPECTED_TOOLS = {
    # memory
    "add_memory",
    "query_memory",
    "archive_memories",
    "recall_memory",
    "get_stats",
    # scheduler
    "scheduler_status",
    "scheduler_control",
    # file index
    "index_file",
    "index_directory",
    "search_files",
    "list_indexed_files",
    "get_file_info",
    "get_file_stats",
}


async def _registered():
    return {tool.name: tool for tool in await app.list_tools()}


@pytest.mark.anyio
async def test_registers_exactly_the_expected_tools():
    """The advertised surface is exactly EXPECTED_TOOLS - no more, no fewer.

    Asserted as a set equality rather than a count so the failure message names
    which tool went missing or appeared unannounced.
    """
    actual = set(await _registered())

    assert actual == EXPECTED_TOOLS, (
        f"MCP tool surface drifted.\n"
        f"  missing (registered before, gone now): {sorted(EXPECTED_TOOLS - actual)}\n"
        f"  unexpected (new, not pinned here):     {sorted(actual - EXPECTED_TOOLS)}"
    )


@pytest.mark.anyio
async def test_every_tool_has_a_description():
    """A tool with no description is unusable by a model choosing between tools."""
    undescribed = [
        name
        for name, tool in (await _registered()).items()
        if not (tool.description or "").strip()
    ]

    assert not undescribed, f"tools registered with no description: {sorted(undescribed)}"
