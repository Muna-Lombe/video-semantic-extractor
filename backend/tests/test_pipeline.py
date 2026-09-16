"""@type test
@purpose Verify media extraction commands, hybrid sampling, and timestamp behavior.
"""

from itertools import pairwise
from pathlib import Path
import shutil
import subprocess

import pytest

from video_semantic_extractor import pipeline


def candidate(
    tmp_path: Path, timestamp: float, *reasons: pipeline.SamplingReason
) -> pipeline.FrameCandidate:
    """Create a candidate without requiring decoded image content."""
    return pipeline.FrameCandidate(
        tmp_path / f"frame_{round(timestamp * 1_000_000)}.jpg",
        timestamp,
        reasons,
    )


def test_extract_candidates_preserves_time_base_and_numeric_order(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Normalize source PTS and sort numeric filename tokens across ten seconds."""
    observed_command: list[str] = []

    def fake_run(command: list[str]) -> None:
        observed_command.extend(command)
        output_pattern = Path(command[-1])
        output_pattern.parent.mkdir(parents=True, exist_ok=True)
        (output_pattern.parent / "frame_000000_0000000000000.jpg").touch()
        (output_pattern.parent / "frame_16166667_0000016166667.jpg").touch()
        (output_pattern.parent / "frame_1633333_0000001633333.jpg").touch()

    monkeypatch.setattr(pipeline, "_run", fake_run)

    frames = pipeline._extract_frame_candidates(
        tmp_path / "input.mp4", tmp_path / "frames", "eq(n,0)", "scene_change"
    )

    assert observed_command[observed_command.index("-enc_time_base") + 1] == "filter"
    filter_expression = observed_command[observed_command.index("-vf") + 1]
    assert filter_expression.startswith("setpts=PTS-STARTPTS")
    assert [frame.timestamp_sec for frame in frames] == [0.0, 1.633333, 16.166667]
    assert frames[0].sampling_reasons == ("first",)


def test_deduplicates_candidates_and_combines_provenance(tmp_path: Path) -> None:
    """Merge candidates at the same effective timestamp without losing their origin."""
    selected = pipeline.select_frame_candidates(
        [
            candidate(tmp_path, 0.0, "first"),
            candidate(tmp_path, 5.0, "scene_change"),
            candidate(tmp_path, 5.0005, "interval"),
            candidate(tmp_path, 9.8, "near_final"),
        ],
        max_keyframes=4,
    )

    assert [frame.timestamp_sec for frame in selected] == [0.0, 5.0, 9.8]
    assert selected[1].sampling_reasons == ("scene_change", "interval")


@pytest.mark.parametrize(
    ("duration", "interval_timestamps", "final_timestamp"),
    [
        (12.3, [0.0, 5.0, 10.0], 12.0),  # final partial interval
        (2.0, [0.0], 1.8),  # duration shorter than the interval
    ],
)
def test_static_video_retains_first_intervals_and_near_final(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    duration: float,
    interval_timestamps: list[float],
    final_timestamp: float,
) -> None:
    """Cover static videos, short videos, and final partial intervals."""

    def fake_extract(
        _input: Path,
        output: Path,
        _expression: str,
        reason: pipeline.SamplingReason,
    ) -> list[pipeline.FrameCandidate]:
        if reason == "scene_change":
            return [candidate(output, 0.0, "first")]
        if reason == "interval":
            return [
                candidate(output, timestamp, "first" if timestamp == 0 else "interval")
                for timestamp in interval_timestamps
            ]
        return [candidate(output, final_timestamp, "near_final")]

    monkeypatch.setattr(pipeline, "_extract_frame_candidates", fake_extract)

    selected = pipeline.extract_keyframes(
        tmp_path / "static.mp4",
        tmp_path / "frames",
        scene_threshold=0.3,
        max_keyframes=10,
        sampling_interval_sec=5.0,
        duration_sec=duration,
    )

    assert selected[0].timestamp_sec == 0.0
    assert selected[-1].timestamp_sec == final_timestamp
    assert "near_final" in selected[-1].sampling_reasons
    assert (
        max(right.timestamp_sec - left.timestamp_sec for left, right in pairwise(selected)) <= 5.0
    )


def test_max_keyframes_keeps_coverage_before_optional_scenes(tmp_path: Path) -> None:
    """Drop optional scenes before temporal-coverage candidates."""
    selected = pipeline.select_frame_candidates(
        [
            candidate(tmp_path, 0.0, "first"),
            candidate(tmp_path, 1.0, "scene_change"),
            candidate(tmp_path, 2.0, "scene_change"),
            candidate(tmp_path, 5.0, "interval"),
            candidate(tmp_path, 9.8, "near_final"),
        ],
        max_keyframes=4,
    )

    assert len(selected) == 4
    assert selected[0].timestamp_sec == 0.0
    assert selected[-1].timestamp_sec == 9.8
    assert sum("scene_change" in frame.sampling_reasons for frame in selected) == 1


def test_max_keyframes_rejects_impossible_coverage(tmp_path: Path) -> None:
    """Do not silently violate the configured gap when the cap is too small."""
    with pytest.raises(pipeline.ExtractionError, match="required for configured temporal coverage"):
        pipeline.select_frame_candidates(
            [
                candidate(tmp_path, 0.0, "first"),
                candidate(tmp_path, 5.0, "interval"),
                candidate(tmp_path, 10.0, "interval"),
                candidate(tmp_path, 12.0, "near_final"),
            ],
            max_keyframes=3,
        )


def test_capsule_builder_rejects_invalid_sampling_interval() -> None:
    """Require a positive interval for hybrid frame sampling."""
    with pytest.raises(ValueError, match="sampling_interval_sec must be positive"):
        pipeline.CapsuleBuilder(sampling_interval_sec=0)


@pytest.mark.parametrize("timing", ["constant", "variable", "non_zero_start"])
def test_real_media_timing_variants_retain_first_and_final(tmp_path: Path, timing: str) -> None:
    """Verify CFR, VFR, and non-zero-start inputs through the real FFmpeg path."""
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        pytest.skip("FFmpeg and FFprobe are required for media integration tests")
    output = tmp_path / f"{timing}.mp4"
    command = [
        "ffmpeg",
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=s=160x90:r=10:d=2.3",
    ]
    if timing == "variable":
        command.extend(
            [
                "-vf",
                "select='eq(n,0)+eq(n,1)+eq(n,5)+eq(n,13)+eq(n,22)'",
                "-fps_mode",
                "vfr",
            ]
        )
    elif timing == "non_zero_start":
        command.extend(["-vf", "setpts=PTS+5/TB"])
    command.extend(["-c:v", "libx264", "-pix_fmt", "yuv420p", str(output)])
    subprocess.run(command, check=True)

    frames = pipeline.extract_keyframes(
        output,
        tmp_path / f"{timing}-frames",
        scene_threshold=1.0,
        max_keyframes=10,
        sampling_interval_sec=1.0,
        duration_sec=2.3,
    )

    timestamps = [frame.timestamp_sec for frame in frames]
    assert timestamps == sorted(timestamps)
    assert timestamps[0] == 0.0
    assert timestamps[-1] == pytest.approx(2.2)
    assert "near_final" in frames[-1].sampling_reasons
