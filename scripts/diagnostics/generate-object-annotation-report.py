#!/usr/bin/env python3
"""Generate a reproducible object-review audit report for diagnostics and investigations."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCRIPT = Path(__file__).with_name("validate-object-annotations.py")
SPEC = importlib.util.spec_from_file_location("validate_object_annotations", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
VALIDATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATOR)
COMPARISON_SCRIPT = Path(__file__).with_name("compare-object-reviews.py")
COMPARISON_SPEC = importlib.util.spec_from_file_location("compare_object_reviews", COMPARISON_SCRIPT)
assert COMPARISON_SPEC is not None and COMPARISON_SPEC.loader is not None
COMPARISON = importlib.util.module_from_spec(COMPARISON_SPEC)
COMPARISON_SPEC.loader.exec_module(COMPARISON)


def _read(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _review_summary(payload: dict[str, Any]) -> dict[str, Any]:
    review = payload.get("review", {})
    return {
        "independent_passes": review.get("independent_passes"),
        "reviewed_frames": len(review.get("reviewed_frames", [])),
        "manual_pass": review.get("manual_pass"),
        "assisted_review": review.get("assisted_review"),
        "adjudication_status": review.get("adjudication_status"),
        "adjudication_entries": len(review.get("adjudication_log", [])),
    }


def _markdown(report: dict[str, Any]) -> str:
    validation = report["validation"]
    gates = validation["corpus_adequacy_gates"]
    lines = [
        "# Multi-video object annotation report",
        "",
        f"Generated: `{report['generated_at']}`",
        f"Merged fixture: `{report['merged_fixture']['path']}`",
        f"Merged fixture SHA-256: `{report['merged_fixture']['sha256']}`",
        "",
        "## Review state",
        "",
        f"- Independent passes: **{report['review']['independent_passes']}**",
        f"- Reviewed frame markers: **{report['review']['reviewed_frames']}**",
        f"- Adjudication status: **{report['review']['adjudication_status']}**",
        f"- Adjudication entries: **{report['review']['adjudication_entries']}**",
        f"- Structural validation: **{'pass' if validation['valid'] else 'fail'}**",
        f"- Corpus adequacy: **{'pass' if validation['adequate'] else 'fail'}**",
        "",
        "## Corpus counts",
        "",
        f"- Sources: {validation['counts']['sources']}",
        f"- Frames: {validation['counts']['frames']}",
        f"- Objects: {validation['counts']['objects']}",
        f"- Non-person objects: {validation['counts']['non_person_objects']}",
        "",
        "## Adequacy gates",
        "",
    ]
    lines.extend(f"- {'PASS' if value else 'FAIL'}: `{name}`" for name, value in gates.items())
    if validation["errors"]:
        lines.extend(["", "## Validation errors", ""])
        lines.extend(f"- {error}" for error in validation["errors"])
    if report["reviewers"]:
        lines.extend(["", "## Reviewer inputs", ""])
        for reviewer in report["reviewers"]:
            lines.append(f"- `{reviewer['path']}` ({reviewer['sha256']})")
            lines.append(f"  - Independent passes: {reviewer['review']['independent_passes']}")
            lines.append(f"  - Reviewed frames: {reviewer['review']['reviewed_frames']}")
    if report["review_comparison"] is not None:
        comparison = report["review_comparison"]
        lines.extend(
            [
                "",
                "## Reviewer comparison",
                "",
                f"- Frames compared: {comparison['frames_compared']}",
                f"- Agreement: **{'yes' if comparison['agree'] else 'no'}**",
                f"- Disagreements: {len(comparison['disagreements'])}",
            ]
        )
    lines.extend(
        [
            "",
            "## Interpretation",
            "",
            "This report is generated from saved annotation metadata and the checksum-bound "
            "sampling evidence. It is the diagnostic/investigation handoff artifact. "
            "Detector scoring remains blocked unless structural validation and every "
            "adequacy gate pass.",
            "",
        ]
    )
    return "\n".join(lines)


def generate_report(
    merged_fixture: Path,
    sampling_root: Path,
    reviewer_paths: list[Path],
) -> tuple[dict[str, Any], str]:
    payload = _read(merged_fixture)
    validation = VALIDATOR.validate_annotations(payload, sampling_root)
    report: dict[str, Any] = {
        "report_version": "1.0",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "merged_fixture": {"path": str(merged_fixture), "sha256": _sha256(merged_fixture)},
        "review": _review_summary(payload),
        "reviewers": [],
        "review_comparison": None,
        "adjudication_log": payload.get("review", {}).get("adjudication_log", []),
        "validation": validation,
    }
    for reviewer_path in reviewer_paths:
        reviewer = _read(reviewer_path)
        report["reviewers"].append(
            {
                "path": str(reviewer_path),
                "sha256": _sha256(reviewer_path),
                "review": _review_summary(reviewer),
            }
        )
    if len(reviewer_paths) == 2:
        report["review_comparison"] = COMPARISON.compare_reviews(
            _read(reviewer_paths[0]), _read(reviewer_paths[1])
        )
    return report, _markdown(report)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate object annotation diagnostic and investigation reports")
    parser.add_argument("merged_fixture", type=Path)
    parser.add_argument("sampling_root", type=Path)
    parser.add_argument("output_json", type=Path)
    parser.add_argument("output_markdown", type=Path)
    parser.add_argument("--reviewer", action="append", type=Path, default=[])
    parser.add_argument("--allow-incomplete", action="store_true")
    args = parser.parse_args()
    report, markdown = generate_report(args.merged_fixture, args.sampling_root, args.reviewer)
    args.output_json.parent.mkdir(parents=True, exist_ok=True)
    args.output_markdown.parent.mkdir(parents=True, exist_ok=True)
    args.output_json.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    args.output_markdown.write_text(markdown, encoding="utf-8")
    print(f"Wrote annotation report to {args.output_json}")
    print(f"Wrote investigation record to {args.output_markdown}")
    if not args.allow_incomplete and not report["validation"]["adequate"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()