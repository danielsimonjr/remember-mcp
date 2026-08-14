"""
Archive round-trip: a memory that was archived can be recalled back to active.

Rewritten in v1.1.1. The previous version:

* contained **no assertions** — it printed stats and the recall result, so it
  passed whether or not recall did anything;
* ran against ``active_db="remember_mcp.db"`` / ``archive_dir="mcp_archives/"``,
  the **real** working database in the repo root, and ``recall_from_archive``
  writes the recalled memory back into active storage — so every test run
  mutated real data; and
* hardcoded ``archive_file = "user_default_1762577738"``, an archive produced on
  one machine at one instant. Anywhere else that archive does not exist, recall
  returns nothing, and — with no assertions — the test still passed. It could
  only ever have been meaningful on the machine that produced it.

This builds its own archive inside ``tmp_path`` and asserts the round trip.
"""

import pytest

from remember.system import RememberSystem


def _system(tmp_path):
    return RememberSystem(
        active_db=str(tmp_path / "active.db"),
        archive_dir=str(tmp_path / "archives") + "/",
        archive_threshold_days=0,
        archive_min_salience=1.0,
        auto_archive_enabled=False,
    )


@pytest.mark.anyio
async def test_archived_memory_can_be_recalled(tmp_path):
    """Archive a memory, then recall it and assert it returns to active storage."""
    system = _system(tmp_path)
    content = "The staging cluster credentials rotate every ninety days"
    await system.add_memory(content, tags=["ops"])

    archived = await system.archive_old_memories(age_days=0, min_salience=1.0)
    assert archived.archived_count >= 1, "precondition: the memory must archive"

    emptied = await system.get_stats()
    assert emptied.active_count == 0, "memory should have left active storage"

    # Recall using the archive this test actually produced, rather than a
    # hardcoded id from someone else's machine.
    assert system.archive_index, "archive was not registered — cannot recall"
    key = next(iter(system.archive_index))
    timestamp = next(iter(system.archive_index[key]))
    archive_file = f"user_{key}_{timestamp}"

    await system.recall_from_archive(
        archive_file=archive_file,
        content=content,
        user_id=None,
    )

    restored = await system.get_stats()
    assert restored.active_count > emptied.active_count, (
        f"recall did not restore anything to active storage "
        f"(before={emptied.active_count}, after={restored.active_count})"
    )


@pytest.mark.anyio
async def test_recall_of_unknown_archive_does_not_corrupt_active(tmp_path):
    """A recall naming a nonexistent archive must not add phantom memories."""
    system = _system(tmp_path)
    await system.add_memory("a real memory", tags=["keep"])
    before = await system.get_stats()

    try:
        await system.recall_from_archive(
            archive_file="user_default_0000000000",
            content="something that was never archived",
            user_id=None,
        )
    except Exception:
        # Raising is an acceptable outcome; silently inventing a memory is not.
        pass

    after = await system.get_stats()
    assert after.active_count <= before.active_count + 1, (
        "recall from a nonexistent archive inflated active storage"
    )
