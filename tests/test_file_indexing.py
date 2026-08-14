"""
FileIndexer tests.

Replaces the previous ``async def main()`` script, which pytest never
collected and which asserted nothing. Security checks (allow-list, dotfiles,
glob confinement) run without memvid. The one encode/search test exercises
the real indexer against ``tmp_path``.
"""
from pathlib import Path

import pytest

from remember.file_indexer import FileIndexer, _chunk_code_with_lines


def _indexer(tmp_path, **overrides):
    kwargs = dict(
        index_dir=str(tmp_path / "index"),
        allowed_roots=[str(tmp_path)],
    )
    kwargs.update(overrides)
    return FileIndexer(**kwargs)


def test_refuses_path_outside_allowed_roots(tmp_path):
    indexer = _indexer(tmp_path)
    outside = Path("/etc/passwd")
    if not outside.exists():
        outside = Path(__file__).resolve()
        indexer = _indexer(tmp_path)  # allowed_roots is tmp_path, __file__ is not inside it
    with pytest.raises(PermissionError, match="allowed roots"):
        indexer.index_file(str(outside))


def test_refuses_dotfiles_by_default(tmp_path):
    indexer = _indexer(tmp_path)
    secret = tmp_path / ".env"
    secret.write_text("SECRET=1\n", encoding="utf-8")
    with pytest.raises(PermissionError, match="dotfile"):
        indexer.index_file(str(secret))


def test_index_directory_does_not_mutate_caller_exclude_list(tmp_path):
    indexer = _indexer(tmp_path)
    src = tmp_path / "src"
    src.mkdir()
    (src / "a.py").write_text("print(1)\n", encoding="utf-8")
    exclude = ["custom_exclude"]
    indexer.index_file = lambda *args, **kwargs: {"status": "indexed", "file_path": args[0]}
    indexer.index_directory(str(src), pattern="**/*.py", exclude=exclude)
    assert exclude == ["custom_exclude"], "index_directory mutated the caller's exclude list"


def test_glob_cannot_escape_requested_directory(tmp_path):
    indexer = _indexer(tmp_path)
    inside = tmp_path / "project"
    inside.mkdir()
    (inside / "ok.py").write_text("x = 1\n", encoding="utf-8")
    secret = tmp_path / "secret.txt"
    secret.write_text("should not be indexed via glob escape\n", encoding="utf-8")

    seen: list[str] = []

    def _fake_index(path, **kwargs):
        seen.append(str(Path(path).resolve()))
        return {"status": "indexed", "file_path": path}

    indexer.index_file = _fake_index
    indexer.index_directory(str(inside), pattern="../**/*")
    assert not any(Path(p).resolve() == secret.resolve() for p in seen), (
        "glob of '../**/*' indexed a file outside the requested directory"
    )


def test_refuses_binary_as_text(tmp_path):
    indexer = _indexer(tmp_path)
    blob = tmp_path / "blob.bin"
    blob.write_bytes(b"hello\x00world")
    with pytest.raises(PermissionError, match="binary"):
        indexer.index_file(str(blob))


def test_refuses_oversized_file(tmp_path):
    indexer = _indexer(tmp_path, max_file_bytes=16)
    big = tmp_path / "big.txt"
    big.write_text("x" * 64, encoding="utf-8")
    with pytest.raises(PermissionError, match="larger than"):
        indexer.index_file(str(big))


def test_chunk_code_with_lines_is_linear_and_preserves_offsets():
    lines = [f"line {i}" for i in range(20)]
    content = "\n".join(lines)
    chunks, meta = _chunk_code_with_lines(content, "mod.py", chunk_size=200)
    assert chunks
    assert len(chunks) == len(meta)
    assert meta[0]["char_start"] == 0
    assert meta[-1]["end_line"] == 20
    # offsets[i+1] = offsets[i] + len(line) + 1, including a +1 after the last line.
    # That's the same convention as the previous implementation.
    assert meta[0]["start_line"] == 1
    assert all(chunk.startswith("[mod.py:") for chunk in chunks)


def test_get_file_info_looks_up_by_path_without_hashing_missing_file(tmp_path):
    indexer = _indexer(tmp_path)
    indexer.metadata["deadbeef"] = {
        "file_path": str(tmp_path / "gone.py"),
        "file_name": "gone.py",
        "file_type": "python",
        "file_size": 1,
        "chunk_count": 1,
        "indexed_at": "now",
    }
    info = indexer.get_file_info(str(tmp_path / "gone.py"))
    assert info is not None
    assert info["file_name"] == "gone.py"


def test_corrupt_metadata_is_quarantined(tmp_path):
    index_dir = tmp_path / "index"
    index_dir.mkdir()
    meta = index_dir / "file_metadata.json"
    meta.write_text("{not json", encoding="utf-8")
    indexer = FileIndexer(index_dir=str(index_dir), allowed_roots=[str(tmp_path)])
    assert indexer.metadata == {}
    assert (index_dir / "file_metadata.json.corrupt").exists()


@pytest.mark.anyio
async def test_index_and_search_round_trip(tmp_path):
    indexer = _indexer(tmp_path)
    src = tmp_path / "notes.txt"
    src.write_text(
        "Authentication logic lives in the session middleware.\n"
        "Rate limiting is applied at the edge.\n",
        encoding="utf-8",
    )
    result = indexer.index_file(str(src), preserve_lines=False)
    assert result["status"] == "indexed"
    assert result["chunk_count"] >= 1

    listed = indexer.list_indexed_files()
    assert len(listed) == 1
    assert listed[0]["file_name"] == "notes.txt"

    hits = indexer.search("authentication middleware", top_k=3)
    assert hits, "search returned no hits against a just-indexed file"
    assert hits[0]["file_name"] == "notes.txt"
    assert "score" in hits[0]

    stats = indexer.get_stats()
    assert stats["total_files"] == 1
    indexer.close()
