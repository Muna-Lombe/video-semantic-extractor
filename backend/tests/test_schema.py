"""@type test
@purpose Verify deterministic compression and strict capsule validation.
"""

import pytest
from pydantic import ValidationError

from video_semantic_extractor.pipeline import summarize
from video_semantic_extractor.schema import Metadata


def test_summary_normalizes_and_marks_truncation() -> None:
    summary = summarize("  alpha\n beta gamma ", max_chars=10)

    assert summary.abstract == "alpha beta…"
    assert summary.truncated is True
    assert summary.method == "extractive_prefix"


def test_schema_rejects_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        Metadata(
            duration_sec=1,
            width=100,
            height=100,
            source_file="x.mp4",
            has_audio=True,
            unexpected=True,
        )
