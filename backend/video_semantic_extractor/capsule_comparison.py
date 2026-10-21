"""@type implementation @purpose Freeze prediction-blind comparison inputs and score only evidence visible to each variant."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from .capsule_evaluation import _evidence, score_answers
from .schema import VideoCapsule

VARIANTS = ("transcript", "summary", "capsule")
INSTRUCTIONS = (
    "Answer every question using only this input. Return a short answer and evidence paths "
    "chosen from reference_paths. If the input is insufficient, answer unknown with an empty "
    "evidence list. Do not use outside knowledge or tools. Preserve negation and uncertainty. "
    "Return JSON with answers: [{question_id, answer, evidence}]."
)


def canonical(value: object) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode("utf-8")


def comparison_inputs(capsule_bytes: bytes, questions: dict) -> tuple[dict, dict[str, bytes]]:
    identity = score_answers(capsule_bytes, questions)
    capsule = VideoCapsule.model_validate_json(capsule_bytes)
    transcript_refs = [
        f"transcript.segments[{index}]" for index in range(len(capsule.transcript.segments))
    ]
    if capsule.transcript.unsegmented_text:
        transcript_refs.append("transcript.unsegmented_text")
    summary_refs = [
        f"transcript.summary.excerpts[{index}]"
        for index in range(len(capsule.transcript.summary.excerpts))
    ]
    if any(_evidence(capsule, ref) is None for ref in summary_refs):
        raise ValueError(
            "Summary quotes must retain their original text, timestamps and source references"
        )
    if capsule.transcript.summary.abstract and not summary_refs:
        raise ValueError(
            "Legacy summaries need regenerated evidence-linked excerpts before comparison"
        )
    quotes = [
        re.escape(" ".join(excerpt.text.split())) for excerpt in capsule.transcript.summary.excerpts
    ]
    if not re.fullmatch(r"(?: | … )".join(quotes), capsule.transcript.summary.abstract):
        raise ValueError(
            "Summary abstract must contain only its cited quotes and omission separators"
        )
    visual_refs = [
        f"keyframes[{index}].{kind}[{item}]"
        for index, frame in enumerate(capsule.keyframes)
        for kind in ("objects", "text_observations")
        for item in range(len(getattr(frame, kind)))
    ]
    views = {
        "transcript": (
            {
                "language": capsule.transcript.language,
                "segments": [segment.model_dump() for segment in capsule.transcript.segments],
                "unsegmented_text": capsule.transcript.unsegmented_text,
            },
            transcript_refs,
        ),
        "summary": (
            {
                "method": capsule.transcript.summary.method,
                "excerpts": [
                    excerpt.model_dump() for excerpt in capsule.transcript.summary.excerpts
                ],
                "truncated": capsule.transcript.summary.truncated,
                "omitted_units": capsule.transcript.summary.omitted_units,
            },
            summary_refs,
        ),
        "capsule": (capsule.model_dump(), transcript_refs + summary_refs + visual_refs),
    }
    base = {
        key: identity[key] for key in ("source_sha256", "capsule_sha256", "question_set_sha256")
    }
    files: dict[str, bytes] = {}
    variants = {}
    for name, (view, references) in views.items():
        prompt = {
            "schema_version": "capsule-comparison-input.v1",
            "variant": name,
            **base,
            "instructions": INSTRUCTIONS,
            "input": view,
            "reference_paths": references,
            "questions": [
                {"id": question["id"], "question": question["question"]}
                for question in questions["questions"]
            ],
        }
        payload = canonical(prompt)
        files[name] = payload
        variants[name] = {
            "input_file": f"{name}.input.json",
            "input_sha256": hashlib.sha256(payload).hexdigest(),
            "input_bytes": len(payload),
        }
    return {"schema_version": "capsule-comparison-plan.v1", **base, "variants": variants}, files


def write_comparison(directory: Path, capsule_bytes: bytes, questions: dict) -> dict:
    plan, inputs = comparison_inputs(capsule_bytes, questions)
    # Never overwrite a frozen input directory or a previous run's evidence.
    directory.mkdir(parents=True, exist_ok=False)
    for variant, payload in inputs.items():
        (directory / plan["variants"][variant]["input_file"]).write_bytes(payload)
    (directory / "plan.json").write_bytes(canonical(plan))
    return plan


def compare_answers(
    directory: Path, capsule_bytes: bytes, questions: dict, answers: dict[str, dict]
) -> dict:
    expected, inputs = comparison_inputs(capsule_bytes, questions)
    plan = json.loads((directory / "plan.json").read_bytes())
    if plan != expected:
        raise ValueError("Frozen comparison plan does not match the source capsule and questions")
    if set(answers) - set(VARIANTS):
        raise ValueError("Unsupported comparison variant")
    for variant in VARIANTS:
        if (directory / expected["variants"][variant]["input_file"]).read_bytes() != inputs[
            variant
        ]:
            raise ValueError("A frozen comparison input has changed")
    reports = {}
    configurations = []
    for variant, response in answers.items():
        if response.get("input_sha256") != expected["variants"][variant]["input_sha256"]:
            raise ValueError("Answers must bind the exact input shown for their variant")
        configuration = response.get("run_configuration")
        if not isinstance(configuration, dict) or not configuration:
            raise ValueError("Comparison answers require the recorded run_configuration")
        configurations.append(
            canonical({"model": response.get("model"), "run_configuration": configuration})
        )
        visible = set(json.loads(inputs[variant])["reference_paths"])
        reports[variant] = score_answers(
            capsule_bytes, questions, response, allowed_evidence=visible
        )
        reports[variant].update(expected["variants"][variant])
        reports[variant]["run_configuration"] = configuration
    if len(set(configurations)) > 1:
        raise ValueError(
            "Fair comparison requires identical model and run configuration for every variant"
        )
    missing = [variant for variant in VARIANTS if variant not in reports]
    result = {
        "schema_version": "capsule-comparison-report.v1",
        "source_sha256": expected["source_sha256"],
        "capsule_sha256": expected["capsule_sha256"],
        "question_set_sha256": expected["question_set_sha256"],
        "status": "awaiting_model_answers" if missing else "scored",
        "missing_variants": missing,
        "variants": reports,
        "differences_from_transcript": None,
    }
    if not missing:
        baseline = reports["transcript"]
        differences = {}
        for variant in ("summary", "capsule"):
            report = reports[variant]
            measured = baseline["usage"] is not None and report["usage"] is not None
            differences[variant] = {
                "accuracy_difference": report["accuracy"] - baseline["accuracy"],
                "supported_answer_accuracy_difference": report["supported_answer_accuracy"]
                - baseline["supported_answer_accuracy"],
                "input_byte_reduction_fraction": 1
                - report["input_bytes"] / baseline["input_bytes"],
                "input_token_reduction_fraction": 1
                - report["usage"]["input_tokens"] / baseline["usage"]["input_tokens"]
                if measured and baseline["usage"]["input_tokens"]
                else None,
                "latency_difference_ms": report["usage"]["elapsed_ms"]
                - baseline["usage"]["elapsed_ms"]
                if measured
                else None,
            }
        result["differences_from_transcript"] = differences
    return result
