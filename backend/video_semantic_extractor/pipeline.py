"""@type implementation
@purpose Extract the three semantic streams and assemble a validated VideoCapsule.
@dependencies schema.py
"""

from __future__ import annotations

import importlib
import json
import subprocess
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Protocol

import cv2
import numpy as np

from .schema import (
    Keyframe,
    Metadata,
    SceneGraph,
    TimelineEvent,
    Transcript,
    TranscriptSegment,
    TranscriptSummary,
    VideoCapsule,
    VisualFeatures,
)


class ExtractionError(RuntimeError):
    """Raised when media probing or extraction cannot produce a capsule."""


class Transcriber(Protocol):
    def __call__(self, audio_path: Path) -> dict[str, object]: ...


def _run(command: list[str]) -> subprocess.CompletedProcess[str]:
    """Run a media command without a shell and return captured text output."""
    try:
        return subprocess.run(command, check=True, capture_output=True, text=True)
    except (OSError, subprocess.CalledProcessError) as exc:
        detail = getattr(exc, "stderr", "") or str(exc)
        raise ExtractionError(detail.strip()) from exc


def probe_video(input_path: Path) -> Metadata:
    """Read duration, dimensions, and audio presence with ffprobe."""
    result = _run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            str(input_path),
        ]
    )
    payload = json.loads(result.stdout)
    streams = payload.get("streams", [])
    video = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    if video is None:
        raise ExtractionError("input contains no video stream")
    duration = float(payload.get("format", {}).get("duration") or video.get("duration") or 0)
    return Metadata(
        duration_sec=round(duration, 3),
        width=int(video["width"]),
        height=int(video["height"]),
        source_file=input_path.name,
        has_audio=any(stream.get("codec_type") == "audio" for stream in streams),
    )


def extract_audio(input_path: Path, output_path: Path) -> None:
    """Create the 16 kHz mono WAV expected by speech recognition models."""
    _run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-i",
            str(input_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            str(output_path),
        ]
    )


def extract_keyframes(
    input_path: Path, output_dir: Path, scene_threshold: float, max_keyframes: int
) -> list[tuple[Path, float]]:
    """Extract scene changes and recover exact timestamps from ffmpeg filenames."""
    output_dir.mkdir(parents=True, exist_ok=True)
    pattern = output_dir / "frame_%06d_%013d.jpg"
    # The second filename token is presentation time in microseconds.
    filter_expr = f"select='eq(n,0)+gt(scene,{scene_threshold})',settb=AVTB"
    _run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-i",
            str(input_path),
            "-vf",
            filter_expr,
            "-fps_mode",
            "vfr",
            "-frame_pts",
            "1",
            str(pattern),
        ]
    )
    frames = sorted(output_dir.glob("frame_*.jpg"))
    if len(frames) > max_keyframes:
        indexes = np.linspace(0, len(frames) - 1, max_keyframes, dtype=int)
        frames = [frames[index] for index in indexes]
    output: list[tuple[Path, float]] = []
    for frame in frames:
        timestamp_us = int(frame.stem.rsplit("_", 1)[1])
        output.append((frame, timestamp_us / 1_000_000))
    return output


def analyze_frame(frame_path: Path, frame_id: int, timestamp: float) -> Keyframe:
    """Calculate inexpensive and explicitly identified visual features."""
    image = cv2.imread(str(frame_path))
    if image is None:
        raise ExtractionError(f"could not decode keyframe {frame_path.name}")
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 100, 200)
    return Keyframe(
        id=frame_id,
        timestamp_sec=round(timestamp, 3),
        features=VisualFeatures(
            brightness=round(float(np.mean(gray)), 2),
            edge_density=round(float(np.mean(edges > 0)), 4),
        ),
    )


def whisper_transcriber(model_name: str) -> Transcriber:
    """Return a lazy Whisper transcriber so base tooling need not load PyTorch."""
    model: object | None = None

    def transcribe(audio_path: Path) -> dict[str, object]:
        nonlocal model
        if model is None:
            whisper = importlib.import_module("whisper")
            model = whisper.load_model(model_name)
        return model.transcribe(str(audio_path))  # type: ignore[attr-defined,no-any-return]

    return transcribe


def summarize(text: str, max_chars: int = 800) -> TranscriptSummary:
    """Apply deterministic extractive compression without inventing semantics."""
    normalized = " ".join(text.split())
    truncated = len(normalized) > max_chars
    abstract = normalized[:max_chars].rstrip()
    if truncated:
        abstract += "…"
    return TranscriptSummary(
        abstract=abstract,
        keywords=[],
        method="extractive_prefix",
        truncated=truncated,
    )


def _segments(result: dict[str, object]) -> list[TranscriptSegment]:
    raw_segments = result.get("segments", [])
    if not isinstance(raw_segments, list):
        raise ExtractionError("transcriber returned invalid segments")
    segments: list[TranscriptSegment] = []
    for value in raw_segments:
        if not isinstance(value, dict):
            continue
        start = max(0.0, float(value.get("start", 0)))
        end = max(start, float(value.get("end", start)))
        text = str(value.get("text", "")).strip()
        if text:
            segments.append(TranscriptSegment(start_sec=start, end_sec=end, text=text))
    return segments


class CapsuleBuilder:
    """Orchestrate media tools while allowing model-backed stages to be replaced."""

    def __init__(
        self,
        transcriber: Transcriber | None = None,
        frame_analyzer: Callable[[Path, int, float], Keyframe] = analyze_frame,
        scene_threshold: float = 0.3,
        max_keyframes: int = 80,
    ) -> None:
        if not 0 <= scene_threshold <= 1 or max_keyframes < 1:
            raise ValueError("scene_threshold must be 0..1 and max_keyframes must be positive")
        self.transcriber = transcriber or whisper_transcriber("tiny")
        self.frame_analyzer = frame_analyzer
        self.scene_threshold = scene_threshold
        self.max_keyframes = max_keyframes

    def build(self, input_path: str | Path) -> VideoCapsule:
        """Build a capsule from a readable local video file."""
        source = Path(input_path)
        if not source.is_file():
            raise ExtractionError(f"video does not exist: {source}")
        with tempfile.TemporaryDirectory(prefix="video-capsule-") as temp:
            temp_path = Path(temp)
            metadata = probe_video(source)
            keyframe_files = extract_keyframes(
                source, temp_path / "frames", self.scene_threshold, self.max_keyframes
            )
            keyframes = [
                self.frame_analyzer(path, index, min(timestamp, metadata.duration_sec))
                for index, (path, timestamp) in enumerate(keyframe_files)
            ]
            warnings: list[str] = []
            result: dict[str, object] = {"text": "", "segments": []}
            if metadata.has_audio:
                audio_path = temp_path / "audio.wav"
                extract_audio(source, audio_path)
                result = self.transcriber(audio_path)
            else:
                warnings.append("No audio stream; transcript is empty.")
            segments = _segments(result)
            full_text = str(result.get("text", "")).strip() or " ".join(
                segment.text for segment in segments
            )
            language = result.get("language")
            transcript = Transcript(
                language=str(language) if language else None,
                summary=summarize(full_text),
                segments=segments,
            )
            timeline = [
                TimelineEvent(
                    start_sec=segment.start_sec,
                    end_sec=segment.end_sec,
                    event_type="speech",
                    description=segment.text,
                    evidence=[f"transcript.segments[{index}]"],
                )
                for index, segment in enumerate(segments)
            ]
            if not keyframes:
                warnings.append("No keyframes were extracted.")
            return VideoCapsule(
                metadata=metadata,
                transcript=transcript,
                keyframes=keyframes,
                timeline=timeline,
                scene_graph=SceneGraph(),
                warnings=warnings,
            )


def build_video_capsule(input_path: str | Path) -> VideoCapsule:
    """Build a capsule with the default local models."""
    return CapsuleBuilder().build(input_path)
