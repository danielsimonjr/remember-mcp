"""Unit tests for memvid helpers that do not need FAISS or a video file."""
import json

from remember.video import search_with_scores, sidecar_chunk_count


class _StrRetriever:
    def search(self, query, top_k=5):
        return ["alpha chunk about " + query, "beta chunk"]


class _MetaRetriever:
    def search_with_metadata(self, query, top_k=5):
        return [
            {"text": "alpha " + query, "score": 0.9},
            {"text": "beta", "score": 0.4},
        ]


def test_search_with_scores_does_not_unpack_strings_as_pairs():
    """memvid.search returns List[str]. Unpacking as (chunk, score) is the bug."""
    pairs = search_with_scores(_StrRetriever(), "hello", top_k=2)
    assert pairs[0][0].startswith("alpha chunk")
    assert isinstance(pairs[0][1], float)
    assert pairs[1][0] == "beta chunk"


def test_search_with_scores_prefers_metadata_scores():
    pairs = search_with_scores(_MetaRetriever(), "hello", top_k=2)
    assert pairs == [("alpha hello", 0.9), ("beta", 0.4)]


def test_sidecar_chunk_count_reads_memvid_metadata_list(tmp_path):
    sidecar = tmp_path / "archive.json"
    sidecar.write_text(
        json.dumps({"metadata": [{"id": 0}, {"id": 1}, {"id": 2}], "config": {}}),
        encoding="utf-8",
    )
    assert sidecar_chunk_count(sidecar) == 3
