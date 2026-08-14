"""
Shared memvid helpers.

Memvid prints to stdout at import and while encoding (``print("FRAMES: ...")``,
ffmpeg summaries). This server speaks MCP over stdio, so those bytes would
corrupt JSON-RPC framing. Every import and encode is therefore wrapped in
``redirect_stdout(sys.stderr)``.

Retriever construction uses memvid's real parameter names (``video_file`` /
``index_file``). Passing ``video_path`` / ``index_path`` raises TypeError —
which is what the archive-query path used to do, silently dropping every
archived hit.
"""
from __future__ import annotations

import contextlib
import logging
import sys
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

logger = logging.getLogger(__name__)

_MAX_RETRIEVERS = 32
_memvid_lock = threading.Lock()
_memvid_modules: Optional[Tuple[Any, Any]] = None


def import_memvid() -> Tuple[Any, Any]:
    """Import ``MemvidEncoder`` and ``MemvidRetriever`` with stdout isolated."""
    global _memvid_modules
    if _memvid_modules is not None:
        return _memvid_modules
    with _memvid_lock:
        if _memvid_modules is not None:
            return _memvid_modules
        try:
            with contextlib.redirect_stdout(sys.stderr):
                from memvid import MemvidEncoder, MemvidRetriever
        except ImportError as exc:
            raise ImportError(
                "Memvid not found. Install with: pip install memvid"
            ) from exc
        _memvid_modules = (MemvidEncoder, MemvidRetriever)
        return _memvid_modules


def make_encoder() -> Any:
    """A MemvidEncoder that will not try to talk to Docker."""
    MemvidEncoder, _ = import_memvid()
    with contextlib.redirect_stdout(sys.stderr):
        return MemvidEncoder(enable_docker=False)


def search_with_scores(retriever: Any, query: str, top_k: int) -> List[Tuple[str, float]]:
    """Return ``(text, score)`` pairs from a retriever.

    memvid's ``search()`` returns ``List[str]`` — not ``(chunk, score)``
    tuples. Unpacking that as ``for chunk, score in hits`` either raises or
    splits each string into characters. Prefer ``search_with_metadata`` when
    present; otherwise rank-estimate.
    """
    if hasattr(retriever, "search_with_metadata"):
        hits = retriever.search_with_metadata(query, top_k=top_k)
        results: List[Tuple[str, float]] = []
        for hit in hits:
            if isinstance(hit, dict):
                text = hit.get("text") or hit.get("content") or ""
                score = hit.get("score")
                if score is None:
                    distance = hit.get("distance")
                    score = (1.0 / (1.0 + float(distance))) if distance is not None else 0.0
                results.append((str(text), float(score)))
            elif isinstance(hit, (tuple, list)) and len(hit) >= 1:
                results.append((str(hit[0]), float(hit[1]) if len(hit) > 1 else 0.0))
        return results

    hits = retriever.search(query, top_k=top_k)
    if not hits:
        return []
    first = hits[0]
    if isinstance(first, str):
        return [(chunk, max(0.0, 1.0 - (idx * 0.1))) for idx, chunk in enumerate(hits)]
    if isinstance(first, (tuple, list)) and len(first) >= 2:
        return [(str(chunk), float(score)) for chunk, score in hits]
    return [(str(chunk), max(0.0, 1.0 - (idx * 0.1))) for idx, chunk in enumerate(hits)]


def remove_memvid_outputs(video_path: Path, index_path: Path) -> None:
    """Best-effort delete of a failed encode's video + sidecars."""
    stem_index = index_path.with_suffix("")
    candidates = [
        video_path,
        index_path,
        video_path.with_suffix(".json"),
        video_path.with_suffix(".faiss"),
        index_path.with_suffix(".faiss"),
        Path(str(stem_index) + ".json"),
        Path(str(stem_index) + ".faiss"),
    ]
    seen: set[str] = set()
    for path in candidates:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        try:
            path.unlink(missing_ok=True)
        except OSError as exc:
            logger.warning("Could not remove leftover encode file %s: %s", path, exc)


def sidecar_chunk_count(index_path: Path) -> int:
    """Best-effort count of chunks recorded in a memvid JSON sidecar."""
    import json

    candidates = [index_path, index_path.with_suffix(".json")]
    stem = index_path.with_suffix("")
    if stem != index_path:
        candidates.append(Path(str(stem) + ".json"))

    for path in candidates:
        if not path.exists() or path.suffix != ".json":
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            continue
        count = _count_from_sidecar(data)
        if count:
            return count
    return 0


def _count_from_sidecar(data: Any) -> int:
    if isinstance(data, list):
        return len(data)
    if not isinstance(data, dict):
        return 0
    for key in ("chunks", "metadata", "items"):
        value = data.get(key)
        if isinstance(value, list):
            return len(value)
    for nested_key in ("stats", "index_stats"):
        nested = data.get(nested_key)
        if isinstance(nested, dict):
            for count_key in ("total_chunks", "chunk_count", "total"):
                if count_key in nested:
                    try:
                        return int(nested[count_key])
                    except (TypeError, ValueError):
                        continue
    for count_key in ("total_chunks", "chunk_count", "total"):
        if count_key in data:
            try:
                return int(data[count_key])
            except (TypeError, ValueError):
                continue
    return 0


def close_retriever(retriever: Any, key: Any = None) -> None:
    close_fn = getattr(retriever, "close", None)
    try:
        if callable(close_fn):
            close_fn()
            return
        clear_fn = getattr(retriever, "clear_cache", None)
        if callable(clear_fn):
            clear_fn()
    except Exception as exc:  # noqa: BLE001 — defensive cleanup
        logger.warning("Error closing retriever %s: %s", key, exc)


class RetrieverCache:
    """Bounded LRU of MemvidRetriever instances, keyed by (video, index)."""

    def __init__(self, maxsize: int = _MAX_RETRIEVERS):
        self._maxsize = maxsize
        self._cache: "OrderedDict[Tuple[str, str], Any]" = OrderedDict()
        self._lock = threading.Lock()

    def get(self, video_path: str, index_path: str) -> Any:
        key = (video_path, index_path)
        with self._lock:
            retriever = self._cache.get(key)
            if retriever is not None:
                self._cache.move_to_end(key)
                return retriever

        _, MemvidRetriever = import_memvid()
        with contextlib.redirect_stdout(sys.stderr):
            created = MemvidRetriever(video_file=video_path, index_file=index_path)

        evicted: List[Tuple[Any, Any]] = []
        with self._lock:
            existing = self._cache.get(key)
            if existing is not None:
                close_retriever(created, key)
                self._cache.move_to_end(key)
                return existing
            while len(self._cache) >= self._maxsize:
                evicted.append(self._cache.popitem(last=False))
            self._cache[key] = created

        for old_key, old in evicted:
            close_retriever(old, old_key)
        return created

    def close(self) -> None:
        with self._lock:
            items = list(self._cache.items())
            self._cache.clear()
        for key, retriever in items:
            close_retriever(retriever, key)


def encode_chunks(
    chunks: Iterable[str],
    video_path: Path,
    index_path: Path,
) -> Dict[str, Any]:
    """Encode ``chunks`` to a memvid video, isolating stdout. Cleans up on failure."""
    chunk_list = list(chunks)
    if not chunk_list:
        raise ValueError("No chunks to encode")
    encoder = make_encoder()
    try:
        with contextlib.redirect_stdout(sys.stderr):
            encoder.add_chunks(chunk_list)
            return encoder.build_video(
                str(video_path),
                str(index_path),
                show_progress=False,
            )
    except Exception:
        remove_memvid_outputs(video_path, index_path)
        raise
