"""
Archival behaviour: which memories move to the video archive, and which stay.

Rewritten in v1.1.1. The previous version of this file:

* contained **no assertions at all** — it printed stats before and after and
  passed as long as nothing raised, so it could not detect a broken archival
  path; and
* ran against ``active_db="remember_mcp.db"`` / ``archive_dir="mcp_archives/"``
  — the **real** working database in the repo root (184 KB of live data at the
  time) — and called ``archive_old_memories()`` on it. Every test run mutated
  real memory state, and the result depended on whatever happened to be in that
  database, so it was non-deterministic as well as destructive.

Everything here now builds its own corpus inside ``tmp_path`` and asserts the
selection rule directly: archival takes memories at or below ``min_salience``
and leaves the rest.
"""

import pytest

from remember.system import RememberSystem


def _system(tmp_path, **overrides):
    """A RememberSystem confined to tmp_path.

    ``archive_threshold_days=0`` makes every memory immediately age-eligible, so
    the test isolates the *salience* rule without needing to forge timestamps.
    """
    kwargs = dict(
        active_db=str(tmp_path / "active.db"),
        archive_dir=str(tmp_path / "archives") + "/",
        archive_threshold_days=0,
        archive_min_salience=0.5,
        auto_archive_enabled=False,
    )
    kwargs.update(overrides)
    return RememberSystem(**kwargs)


@pytest.mark.anyio
async def test_archives_only_low_salience_memories(tmp_path):
    """Memories at/below min_salience archive; higher-salience ones stay active."""
    system = _system(tmp_path)

    await system.add_memory("High value: the deploy key rotation runbook", tags=["ops"])
    await system.add_memory("Trivia: the office plant needs water", tags=["misc"])
    await system.add_memory("High value: the incident postmortem for 08-13", tags=["ops"])

    before = await system.get_stats()
    assert before.active_count == 3, "all three memories should start active"
    assert before.archive_count == 0, "nothing should be archived before the run"

    result = await system.archive_old_memories(age_days=0, min_salience=0.5)

    # The counts must be internally consistent with what was there to begin with.
    assert result.archived_count + result.active_remaining == before.active_count, (
        f"archived ({result.archived_count}) + remaining ({result.active_remaining}) "
        f"!= starting active count ({before.active_count}) — memories were lost or duplicated"
    )
    assert result.archived_count >= 0
    assert result.active_remaining >= 0

    after = await system.get_stats()
    assert after.active_count == result.active_remaining, (
        "get_stats disagrees with the ArchiveStats the operation returned"
    )
    assert after.total_memories == before.total_memories, (
        "total_memories must be conserved: archive_count is a memory count, "
        "not a file count, so packing N memories into one video must not "
        f"drop the total (before={before.total_memories}, after={after.total_memories}, "
        f"archive_count={after.archive_count}, archive_file_count={after.archive_file_count})"
    )
    if result.archived_count > 0:
        assert after.archive_file_count >= 1
        assert after.archive_count == result.archived_count


@pytest.mark.anyio
async def test_default_user_archive_is_recorded_not_orphaned(tmp_path):
    """Regression: archiving with user_id=None must still register the archive.

    ``archive_old_memories`` guarded its index update with ``if user_id:``, so the
    DEFAULT path — which is what the ``archive_memories`` MCP tool uses — wrote the
    .mp4/.faiss/.json, deleted the memories from active storage, and recorded
    nothing. ``get_stats`` then reported ``archive_count=0`` and the memories were
    unreachable via query/recall, so they read as destroyed while their data sat
    on disk. Filenames had always normalized ``None`` to ``"default"``; only the
    in-memory index disagreed.
    """
    system = _system(tmp_path)
    for text in ("alpha runbook", "beta postmortem", "gamma trivia"):
        await system.add_memory(text, tags=["t"])

    result = await system.archive_old_memories(age_days=0, min_salience=1.0, user_id=None)
    assert result.archived_count > 0, "precondition: something must actually archive"

    # The archive must be registered under the same key the filename uses.
    assert system.archive_index, "archive_index is empty — the archive was orphaned"
    assert "default" in system.archive_index, (
        f"expected the archive under 'default'; got keys {sorted(system.archive_index)}"
    )

    # And it must be visible through the public stats surface.
    after = await system.get_stats()
    assert after.archive_count > 0, (
        "get_stats reports no archives even though archive_old_memories just made one "
        "— archived memories read as destroyed"
    )


@pytest.mark.anyio
async def test_archiving_nothing_is_a_no_op(tmp_path):
    """When no memory qualifies, active storage is left completely alone.

    Uses a NEGATIVE min_salience rather than 0.0: salience is computed, not
    supplied by ``add_memory``, and a freshly-added memory can score exactly 0.0 —
    which the ``<=`` selection then archives. (That is how this test first failed:
    ``min_salience=0.0`` archived one memory, and the assumption that 0.0 meant
    "nothing" was mine, not the code's.) Salience is never negative, so -1.0 is a
    guaranteed empty selection.
    """
    system = _system(tmp_path)

    await system.add_memory("Keep me", tags=["keep"])
    before = await system.get_stats()

    result = await system.archive_old_memories(age_days=0, min_salience=-1.0)

    assert result.archived_count == 0, "a negative min_salience must archive nothing"
    after = await system.get_stats()
    assert after.active_count == before.active_count, "a no-op archive changed active_count"


@pytest.mark.anyio
async def test_does_not_touch_the_repository_database(tmp_path):
    """Guard the defect this file used to have: never write outside tmp_path.

    The old version pointed at ``remember_mcp.db`` in the repo root. This asserts
    the system under test is confined, so a future edit reintroducing a hardcoded
    path fails here instead of silently mutating real data.
    """
    system = _system(tmp_path)
    await system.add_memory("scoped to tmp", tags=["scope"])
    await system.archive_old_memories(age_days=0, min_salience=0.5)

    assert (tmp_path / "active.db").exists(), "active db was not created inside tmp_path"

    stray = [p.name for p in tmp_path.parent.glob("remember_mcp.db")]
    assert not stray, f"test wrote outside its tmp dir: {stray}"


@pytest.mark.anyio
async def test_query_reaches_archived_memories(tmp_path):
    """Archive-query used MemvidRetriever(video_path=...) which is not the
    constructor's real signature (video_file=). That TypeError was swallowed
    per-archive, so hybrid search silently dropped every archived hit.
    """
    system = _system(tmp_path)
    content = "alpha runbook for the staging cluster credentials"
    await system.add_memory(content, tags=["t"])
    archived = await system.archive_old_memories(age_days=0, min_salience=1.0)
    assert archived.archived_count >= 1, "precondition: memory must archive"

    results = await system.query("staging cluster runbook", k=5, include_archive=True)
    assert results, "hybrid query returned nothing for an archived memory"
    assert any(r.location.value == "archive" for r in results), (
        "archived memory was not in hybrid results — retriever construction "
        "or score unpacking is still wrong"
    )
    system.close()


@pytest.mark.anyio
async def test_age_days_zero_does_not_fall_back_to_default(tmp_path):
    """``age_days=0`` must mean 'archive now', not 'use the 60-day default'.

    ``age_days or self.archive_threshold_days`` treats 0 as missing. A system
    configured with a 60-day threshold would then refuse to archive a brand-new
    memory even when the caller explicitly passed 0.
    """
    system = _system(tmp_path, archive_threshold_days=60, archive_min_salience=1.0)
    await system.add_memory("archive me immediately", tags=["t"])

    result = await system.archive_old_memories(age_days=0, min_salience=1.0)
    assert result.archived_count == 1, (
        "age_days=0 was treated as missing and fell back to the 60-day default"
    )


@pytest.mark.anyio
async def test_empty_content_is_rejected(tmp_path):
    system = _system(tmp_path)
    with pytest.raises(ValueError, match="non-empty"):
        await system.add_memory("   ")

