"""
Scheduler behaviour, isolated to tmp_path.

Replaces tests/test_complete.py, which pytest collected as ``test_phase2``
(zero assertions) and which wrote ``test_phase2.db`` into the working
directory.
"""
import pytest

from remember.scheduler import ArchivalScheduler
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
async def test_scheduler_start_stop_and_run_now(tmp_path):
    system = _system(tmp_path)
    await system.add_memory("old enough to archive", tags=["t"])

    scheduler = ArchivalScheduler(system, interval_seconds=3600, enabled=True)
    status = scheduler.get_status()
    assert status["running"] is False
    assert status["total_archived"] == 0
    assert status["last_error"] is None

    await scheduler.start()
    try:
        running = scheduler.get_status()
        assert running["running"] is True
        assert running["enabled"] is True

        await scheduler.run_now()
        after = scheduler.get_status()
        assert after["total_archived"] >= 1
        assert after["last_run"] is not None
        assert after["last_error"] is None
    finally:
        await scheduler.stop()

    stopped = scheduler.get_status()
    assert stopped["running"] is False

    stats = await system.get_stats()
    assert stats.active_count == 0
    assert stats.archive_count >= 1
    system.close()


@pytest.mark.anyio
async def test_scheduler_rejects_nonpositive_interval(tmp_path):
    system = _system(tmp_path)
    with pytest.raises(ValueError, match="interval_seconds"):
        ArchivalScheduler(system, interval_seconds=0)
