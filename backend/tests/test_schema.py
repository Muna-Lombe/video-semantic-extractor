"""@type test
@purpose Verify deterministic compression and strict capsule validation.
"""

import pytest
from pydantic import ValidationError

from video_semantic_extractor.pipeline import summarize
from video_semantic_extractor.schema import Keyframe, Metadata, VisualFeatures


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


def test_keyframe_sampling_reasons_are_constrained() -> None:
    """Accept known sampling provenance and reject silently drifting values."""
    keyframe = Keyframe(
        id=0,
        timestamp_sec=0,
        features=VisualFeatures(brightness=0, edge_density=0),
        sampling_reasons=["first", "near_final"],
    )

    assert keyframe.sampling_reasons == ["first", "near_final"]
    with pytest.raises(ValidationError):
        Keyframe(
            id=0,
            timestamp_sec=0,
            features=VisualFeatures(brightness=0, edge_density=0),
            sampling_reasons=["unknown"],
        )
