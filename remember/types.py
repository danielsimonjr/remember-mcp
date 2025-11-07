"""
Type definitions for remember-mcp
"""
from dataclasses import dataclass
from typing import List, Optional, Dict, Any
from enum import Enum


class MemoryLocation(str, Enum):
    """Where a memory is stored"""
    ACTIVE = "active"
    ARCHIVE = "archive"


@dataclass
class HybridMemoryResult:
    """Query result with location info"""
    id: str
    content: str
    score: float
    location: MemoryLocation
    sectors: List[str]
    primary_sector: str
    salience: float
    last_seen_at: int
    archived_at: Optional[int] = None
    archive_file: Optional[str] = None


@dataclass
class ArchiveStats:
    """Archive operation statistics"""
    archived_count: int
    active_remaining: int
    archive_size_bytes: int
    compression_ratio: float


@dataclass
class SystemStats:
    """Overall system statistics"""
    active_count: int
    archive_count: int
    total_memories: int
    active_db_size: int
    archive_size: int
    total_size: int
    compression_ratio: float
    avg_salience: float
