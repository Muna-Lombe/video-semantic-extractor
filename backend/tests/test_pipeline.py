"""@type test
@purpose Verify media extraction commands and timestamp recovery behavior.
"""

from pathlib import Path

from video_semantic_extractor import pipeline


def test_extract_keyframes_preserves_filter_time_base(
    monkeypatch, tmp_path: Path
) -> None:
    """Use filter time-base PTS so filename tokens remain microseconds."""
    observed_command: list[str] = []

    def fake_run(command: list[str]) -> None:
        observed_command.extend(command)
        output_pattern = Path(command[-1])
        output_pattern.parent.mkdir(parents=True, exist_ok=True)
        (output_pattern.parent / "frame_000000_0000000000000.jpg").touch()
        # Lexicographic ordering puts 16.166667 before 1.633333 because the
        # first timestamp token exceeds its minimum field width.
        (output_pattern.parent / "frame_16166667_0000016166667.jpg").touch()
        (output_pattern.parent / "frame_1633333_0000001633333.jpg").touch()
        (output_pattern.parent / "frame_3000000_0000003000000.jpg").touch()

    monkeypatch.setattr(pipeline, "_run", fake_run)

    frames = pipeline.extract_keyframes(
        tmp_path / "input.mp4",
        tmp_path / "frames",
        scene_threshold=0.3,
        max_keyframes=10,
    )

    assert observed_command[observed_command.index("-enc_time_base") + 1] == "filter"
    assert [timestamp for _path, timestamp in frames] == [
        0.0,
        1.633333,
        3.0,
        16.166667,
    ]
