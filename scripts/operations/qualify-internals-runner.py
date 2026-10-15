#!/usr/bin/env python3
"""@type script @purpose Measure local sampling/inference resource use without approving a corpus or release."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import resource
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from video_semantic_extractor.pipeline import probe_video
from video_semantic_extractor.sampling_runner import _source_frame_limit, _candidates


def qualify(model: Path) -> dict:
    checksum = hashlib.sha256(model.read_bytes()).hexdigest()
    if checksum != "4b82da9944b88577175ee23a459dce2e26e6e4be573def65b1055dc2d9720186":
        raise ValueError("qualification requires the documented pinned OpenCV Zoo model")
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="internals-qualification-") as directory:
        root = Path(directory)
        source = root / "synthetic.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=12", "-c:v", "libx264", "-threads", "1", str(source)], check=True)
        metadata = probe_video(source)
        frames = _candidates(source, root / "frames", {"method": "hybrid", "scene_threshold": 1.0, "max_frames": 24, "interval_seconds": 1.0, "include_final_frame": True}, metadata.duration_sec)
        if not 2 <= len(frames) <= 24 or frames[0].timestamp_sec != 0 or "near_final" not in frames[-1].sampling_reasons:
            raise RuntimeError("sampling coverage qualification failed")
        if sum(_source_frame_limit(250, 500 - index * 100, 5 - index) for index in range(5)) != 500:
            raise RuntimeError("multi-source budget qualification failed")
        spec = importlib.util.spec_from_file_location("qualification_object_engine", Path(__file__).resolve().parents[1] / "diagnostics" / "evaluate-frame-objects.py")
        assert spec and spec.loader
        engine = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = engine
        spec.loader.exec_module(engine)
        records = [{"source_id": "src_synthetic", "frame_id": f"frame_{index}", "timestamp_sec": frame.timestamp_sec, "path": str(frame.path), "sha256": hashlib.sha256(frame.path.read_bytes()).hexdigest()} for index, frame in enumerate(frames)]
        truth = {"sources": [{"source": "src_synthetic", "frames": [{"frame_id": record["frame_id"], "objects": []} for record in records]}]}
        metrics = engine.evaluate_managed_ground_truth(model, records, truth)
        if metrics["frame_count"] != len(frames) or metrics["p95_inference_ms"] is None:
            raise RuntimeError("inference qualification failed")
        disk_bytes = sum(path.stat().st_size for path in root.rglob("*") if path.is_file())
        try:
            engine.evaluate_managed_ground_truth(model, records, truth, should_abort=lambda: True)
        except RuntimeError as error:
            if "cancelled" not in str(error):
                raise
        else:
            raise RuntimeError("evaluation ignored cancellation")
    cgroup = {}
    for name in ["memory.max", "memory.peak", "cpu.max"]:
        path = Path("/sys/fs/cgroup") / name
        if path.is_file():
            cgroup[name] = path.read_text().strip()
    return {"schema_version": "runner-qualification.v1", "scope": "local synthetic workload; no production qualification or accuracy claim", "model_sha256": checksum, "frame_count": len(frames), "source_dimensions": [metadata.width, metadata.height], "wall_seconds": round(time.monotonic() - started, 3), "peak_process_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss, "peak_child_rss_kib": resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss, "temporary_bytes": disk_bytes, "p95_inference_ms": metrics["p95_inference_ms"], "coverage_and_cancellation": "passed", "cgroup": cgroup}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    report = qualify(args.model)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
