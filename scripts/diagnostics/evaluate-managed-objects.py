#!/usr/bin/env python3
"""@type script @purpose Reproduce a managed evaluation from exported, checksum-bound inputs."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
from pathlib import Path


def evaluate(plan: dict, inputs_dir: Path) -> dict:
    """Run the same engine as the hosted runner without changing the frozen plan."""
    root = inputs_dir.resolve()

    def verified(item: dict) -> Path:
        artifact_id = item.get("id", item.get("artifact_id"))
        if not isinstance(artifact_id, str) or not artifact_id or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for char in artifact_id):
            raise ValueError("invalid artifact identifier")
        path = (root / artifact_id).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise ValueError(f"input artifact is missing: {artifact_id}")
        if path.stat().st_size != item["size_bytes"] or hashlib.sha256(path.read_bytes()).hexdigest() != item["sha256"]:
            raise ValueError(f"input artifact checksum or size mismatch: {artifact_id}")
        return path

    script = Path(__file__).with_name("evaluate-frame-objects.py")
    implementation = "managed-object-evaluation.v1@sha256:" + hashlib.sha256(script.read_bytes()).hexdigest()
    if plan.get("implementation_version") != implementation:
        raise ValueError("engine source does not match the frozen implementation; use the matching source revision")
    spec = importlib.util.spec_from_file_location("managed_cli_object_engine", script)
    assert spec and spec.loader
    engine = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = engine
    spec.loader.exec_module(engine)
    model = verified(plan["model"])
    truth = json.loads(verified(plan["ground_truth"]).read_text(encoding="utf-8"))
    frames = [{"source_id": item["source_id"], "frame_id": item["frame_id"], "timestamp_sec": item["timestamp_seconds"], "path": str(verified(item)), "sha256": item["sha256"]} for item in plan["frames"]]
    config = plan["configuration"]
    metrics = engine.evaluate_managed_ground_truth(model, frames, truth, config["minimum_confidence"], config["nms_threshold"], config["minimum_iou"])
    return {"schema_version": "managed-evaluation-report.v1", "evaluation_run_id": plan["evaluation_run_id"], "input_sha256": plan["input_sha256"], "implementation_version": plan["implementation_version"], "model_sha256": plan["model"]["sha256"], "ground_truth_sha256": plan["ground_truth"]["sha256"], "metrics": metrics, "logs": [{"event": "evaluation.cli_reproduction"}]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--inputs-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        plan = json.loads(args.plan.read_text(encoding="utf-8"))
        if not isinstance(plan, dict):
            parser.error("plan must be an object")
        report = evaluate(plan.get("data", plan), args.inputs_dir)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("x", encoding="utf-8") as output:
            json.dump(report, output, indent=2, allow_nan=False)
            output.write("\n")
    except (ValueError, OSError, KeyError) as error:
        parser.error(str(error))
    print(f"Wrote reproduced evaluation to {args.output}")


if __name__ == "__main__":
    main()
