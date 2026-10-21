"""@type implementation @purpose Score source-bound video questions against recorded LLM answers and capsule evidence."""

from __future__ import annotations

import hashlib
import json
import math
import re
import unicodedata

from .schema import VideoCapsule


def normalize(value: str) -> str:
    return " ".join(re.findall(r"\w+", unicodedata.normalize("NFKC", value).casefold()))


def _evidence(capsule: VideoCapsule, path: str):
    if path == "transcript.unsegmented_text" and capsule.transcript.unsegmented_text:
        return None, None, "speech", capsule.transcript.unsegmented_text
    excerpt_path = re.fullmatch(r"transcript\.summary\.excerpts\[(\d+)\]", path)
    if excerpt_path:
        try:
            excerpt = capsule.transcript.summary.excerpts[int(excerpt_path[1])]
            parent = (
                _evidence(capsule, excerpt.evidence)
                if not excerpt.evidence.startswith("transcript.summary.")
                else None
            )
            if (
                not excerpt.text.strip()
                or not parent
                or parent[2] != "speech"
                or excerpt.text not in parent[3]
                or (excerpt.start_sec, excerpt.end_sec) != parent[:2]
            ):
                return None
            return excerpt.start_sec, excerpt.end_sec, "speech", excerpt.text
        except IndexError:
            return None
    match = re.fullmatch(
        r"(keyframes|transcript\.segments)\[(\d+)\](?:\.(objects|text_observations)\[(\d+)\])?",
        path,
    )
    if not match:
        return None
    collection, index, field, item = match.groups()
    try:
        if collection == "transcript.segments":
            if field:
                return None
            segment = capsule.transcript.segments[int(index)]
            return segment.start_sec, segment.end_sec, "speech", segment.text
        frame = capsule.keyframes[int(index)]
        if field == "objects":
            value = frame.objects[int(item)].label
            modality = "object"
        elif field == "text_observations":
            value = frame.text_observations[int(item)].text
            modality = "text"
        else:
            return None
        return frame.timestamp_sec, frame.timestamp_sec, modality, value
    except IndexError:
        return None


def score_answers(
    capsule_bytes: bytes,
    questions: dict,
    answers: dict | None = None,
    *,
    allowed_evidence: set[str] | None = None,
) -> dict:
    """Exact normalized answers use predeclared aliases; no model judges or gate changes."""
    capsule = VideoCapsule.model_validate_json(capsule_bytes)
    source_sha = capsule.metadata.source_sha256
    if (
        not source_sha
        or questions.get("schema_version") != "capsule-question-set.v1"
        or questions.get("source_sha256") != source_sha
    ):
        raise ValueError("Questions must bind the capsule's source SHA-256")
    items = questions.get("questions")
    if not isinstance(items, list) or not items:
        raise ValueError("At least one independently authored question is required")
    identifiers = []
    for question in items:
        aliases = question.get("accepted_answers")
        start, end = question.get("start_sec"), question.get("end_sec")
        if (
            not isinstance(question.get("id"), str)
            or not question["id"]
            or not isinstance(question.get("question"), str)
            or not question["question"].strip()
            or not isinstance(aliases, list)
            or not aliases
            or any(not isinstance(answer, str) or not normalize(answer) for answer in aliases)
        ):
            raise ValueError("Questions require an ID, prompt and nonempty accepted answers")
        if (
            any(
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
                for value in (start, end)
            )
            or not 0 <= start <= end <= capsule.metadata.duration_sec
            or question.get("modality") not in ("speech", "text", "object")
        ):
            raise ValueError("Questions require a valid source-time window and modality")
        identifiers.append(question["id"])
    if len(set(identifiers)) != len(identifiers):
        raise ValueError("Question IDs must be unique")
    digest = hashlib.sha256(capsule_bytes).hexdigest()
    report = {
        "schema_version": "capsule-usefulness-report.v1",
        "source_sha256": source_sha,
        "capsule_sha256": digest,
        "question_set_sha256": hashlib.sha256(
            json.dumps(questions, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest(),
        "question_count": len(items),
        "capsule_bytes": len(capsule_bytes),
        "status": "awaiting_model_answers",
        "accuracy": None,
        "supported_answer_accuracy": None,
        "usage": None,
        "results": [],
    }
    if answers is None:
        return report
    if (
        answers.get("schema_version") != "capsule-answers.v1"
        or answers.get("capsule_sha256") != digest
        or answers.get("question_set_sha256") != report["question_set_sha256"]
        or not isinstance(answers.get("model"), str)
        or not answers["model"].strip()
    ):
        raise ValueError(
            "Answers must identify their model, exact capsule and question-set digests"
        )
    responses = answers.get("answers")
    if (
        not isinstance(responses, list)
        or len(responses) != len(items)
        or {row.get("question_id") for row in responses} != set(identifiers)
    ):
        raise ValueError("Answers must cover each question exactly once")
    usage = answers.get("usage")
    if usage is not None and (
        not isinstance(usage, dict)
        or set(usage) != {"input_tokens", "output_tokens", "elapsed_ms"}
        or any(
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
            or value < 0
            for value in usage.values()
        )
        or any(not isinstance(usage[key], int) for key in ("input_tokens", "output_tokens"))
    ):
        raise ValueError(
            "Usage must contain recorded nonnegative input/output token counts and elapsed_ms"
        )
    for question in items:
        response = next(row for row in responses if row["question_id"] == question["id"])
        if (
            not isinstance(response.get("answer"), str)
            or not response["answer"].strip()
            or not isinstance(response.get("evidence"), list)
            or any(not isinstance(path, str) for path in response["evidence"])
        ):
            raise ValueError(
                "Each answer requires text and an evidence list; unknown answers may cite no evidence"
            )
        correct = normalize(response["answer"]) in {
            normalize(alias) for alias in question["accepted_answers"]
        }
        observed = [
            _evidence(capsule, path)
            if allowed_evidence is None or path in allowed_evidence
            else None
            for path in response["evidence"]
        ]
        evidence_valid = bool(observed) and all(
            value is not None
            and value[2] == question["modality"]
            and (
                (
                    value[0] is None
                    and value[1] is None
                    and question["start_sec"] == 0
                    and question["end_sec"] == capsule.metadata.duration_sec
                )
                or (
                    value[0] is not None
                    and value[1] is not None
                    and value[1] >= question["start_sec"]
                    and value[0] <= question["end_sec"]
                )
            )
            for value in observed
        )
        evidence_text = " ".join(value[3] for value in observed if value is not None)
        supported = evidence_valid and any(
            " " + normalize(alias) + " " in " " + normalize(evidence_text) + " "
            for alias in question["accepted_answers"]
        )
        report["results"].append(
            {
                "question_id": question["id"],
                "correct": correct,
                "evidence_valid": evidence_valid,
                "answer_supported": correct and supported,
            }
        )
    report.update(
        status="scored",
        accuracy=sum(row["correct"] for row in report["results"]) / len(items),
        supported_answer_accuracy=sum(row["answer_supported"] for row in report["results"])
        / len(items),
        model=answers["model"],
        usage=usage,
    )
    return report
