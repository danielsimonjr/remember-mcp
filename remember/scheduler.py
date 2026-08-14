"""
Automatic archival scheduler for remember-mcp
Runs background task to archive old/decayed memories
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Optional

logger = logging.getLogger(__name__)


class ArchivalScheduler:
    """
    Background scheduler for automatic memory archival.

    Periodically checks for memories eligible for archival based on:
    - Age (days since creation)
    - Salience (decay level)
    - Last access time
    """

    def __init__(
        self,
        remember_system,
        interval_seconds: int = 86400,  # Default: 24 hours
        enabled: bool = True
    ):
        """
        Initialize archival scheduler.

        Args:
            remember_system: RememberSystem instance
            interval_seconds: Interval between archival checks (default: 24h)
            enabled: Whether scheduler is enabled
        """
        if interval_seconds < 1:
            raise ValueError("interval_seconds must be >= 1")
        self.system = remember_system
        self.interval = interval_seconds
        self.enabled = enabled
        self.running = False
        self.task: Optional[asyncio.Task] = None
        self.last_run: Optional[int] = None
        self.total_archived = 0
        self.last_error: Optional[str] = None

    async def start(self) -> None:
        """Start the scheduler"""
        if self.running:
            logger.info("Scheduler already running")
            return

        self.enabled = True
        self.running = True
        self.task = asyncio.create_task(self._run_loop())
        logger.info("Scheduler started (interval: %ss)", self.interval)

    async def stop(self) -> None:
        """Stop the scheduler"""
        if not self.running:
            return

        self.running = False
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
            self.task = None

        logger.info("Scheduler stopped")

    async def _run_loop(self) -> None:
        """Main scheduler loop"""
        while self.running:
            try:
                await self._run_archival()
                await asyncio.sleep(self.interval)
            except asyncio.CancelledError:
                break
            except Exception:
                logger.exception("Scheduler loop error")
                await asyncio.sleep(60)  # Wait 1 minute before retry

    async def _run_archival(self) -> None:
        """Run archival process"""
        if not self.enabled:
            return

        start_time = time.time()
        logger.info("Running archival")

        try:
            stats = await self.system.archive_old_memories(
                age_days=self.system.archive_threshold_days,
                min_salience=self.system.archive_min_salience
            )

            self.last_run = int(time.time() * 1000)
            self.total_archived += stats.archived_count
            self.last_error = None

            elapsed = time.time() - start_time

            if stats.archived_count > 0:
                logger.info(
                    "Archived %s memories (%s bytes, %.2fx) in %.2fs; lifetime total %s",
                    stats.archived_count,
                    stats.archive_size_bytes,
                    stats.compression_ratio,
                    elapsed,
                    self.total_archived,
                )
            else:
                logger.info(
                    "No memories eligible for archival (%.2fs)", elapsed
                )

        except Exception as exc:
            self.last_error = str(exc)
            logger.exception("Archival failed")

    async def run_now(self) -> None:
        """Manually trigger archival immediately"""
        logger.info("Manual archival triggered")
        await self._run_archival()

    def get_status(self) -> dict[str, Any]:
        """Get scheduler status"""
        return {
            "running": self.running,
            "enabled": self.enabled,
            "interval_seconds": self.interval,
            "last_run": self.last_run,
            "total_archived": self.total_archived,
            "next_run_in": self._time_until_next_run(),
            "last_error": self.last_error,
        }

    def _time_until_next_run(self) -> Optional[int]:
        """Calculate seconds until next run"""
        if not self.running or self.last_run is None:
            return None

        elapsed = int(time.time() * 1000) - self.last_run
        remaining = (self.interval * 1000) - elapsed

        return max(0, remaining // 1000)
