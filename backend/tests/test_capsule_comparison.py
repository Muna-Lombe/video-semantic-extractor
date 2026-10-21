"""@type test @purpose Prevent answer leakage, unseen-evidence credit and fabricated comparison measurements."""

import copy
import json

import pytest

from video_semantic_extractor.capsule_comparison import VARIANTS, compare_answers, write_comparison
from video_semantic_extractor.capsule_evaluation import score_answers
from video_semantic_extractor.schema import TranscriptSegment, VideoCapsule
from video_semantic_extractor.summarization import summarize_transcript


def comparison(tmp_path):
    segment = TranscriptSegment(start_sec=0, end_sec=4, text="The valve is closed.")
    capsule = (
        VideoCapsule.model_validate(
            {
                "version": "1.2",
                "metadata": {
                    "duration_sec": 10,
                    "width": 100,
                    "height": 100,
                    "source_file": "fixture.mp4",
                    "source_sha256": "a" * 64,
                    "has_audio": True,
                },
                "transcript": {
                    "summary": summarize_transcript("", [segment]).model_dump(),
                    "segments": [segment.model_dump()],
                },
                "keyframes": [
                    {
                        "id": 0,
                        "timestamp_sec": 8,
                        "features": {"brightness": 100, "edge_density": 0.1},
                        "text_observations": [
                            {"text": "READY", "confidence": 0.9, "region": [0, 0, 50, 20]}
                        ],
                    }
                ],
                "timeline": [],
            }
        )
        .model_dump_json()
        .encode()
    )
    questions = {
        "schema_version": "capsule-question-set.v1",
        "source_sha256": "a" * 64,
        "questions": [
            {
                "id": "valve",
                "question": "What is the valve status?",
                "accepted_answers": ["closed"],
                "start_sec": 0,
                "end_sec": 4,
                "modality": "speech",
            },
            {
                "id": "display",
                "question": "What word is shown on the display?",
                "accepted_answers": ["ready"],
                "start_sec": 7,
                "end_sec": 10,
                "modality": "text",
            },
        ],
    }
    directory = tmp_path / "experiment"
    plan = write_comparison(directory, capsule, questions)
    identity = score_answers(capsule, questions)
    answers = {}
    for variant in VARIANTS:
        answers[variant] = {
            "schema_version": "capsule-answers.v1",
            "capsule_sha256": identity["capsule_sha256"],
            "question_set_sha256": identity["question_set_sha256"],
            "input_sha256": plan["variants"][variant]["input_sha256"],
            "model": "unit-test fixture; not an actual LLM run",
            "run_configuration": {"temperature": 0, "max_output_tokens": 300},
            "answers": [
                {
                    "question_id": "valve",
                    "answer": "closed",
                    "evidence": [
                        "transcript.summary.excerpts[0]"
                        if variant == "summary"
                        else "transcript.segments[0]"
                    ],
                },
                {
                    "question_id": "display",
                    "answer": "ready" if variant == "capsule" else "unknown",
                    "evidence": ["keyframes[0].text_observations[0]"]
                    if variant == "capsule"
                    else [],
                },
            ],
        }
    return directory, capsule, questions, answers


def test_prompts_do_not_include_gold_answers_and_preserve_frozen_inputs(tmp_path):
    directory, capsule, questions, _ = comparison(tmp_path)
    for variant in VARIANTS:
        prompt = json.loads((directory / f"{variant}.input.json").read_bytes())
        assert prompt["questions"] == [
            {"id": q["id"], "question": q["question"]} for q in questions["questions"]
        ]
        assert "accepted_answers" not in json.dumps(prompt)
    with pytest.raises(FileExistsError):
        write_comparison(directory, capsule, questions)


def test_missing_answers_are_pending_and_usage_is_never_inferred_from_bytes(tmp_path):
    directory, capsule, questions, answers = comparison(tmp_path)
    pending = compare_answers(directory, capsule, questions, {"transcript": answers["transcript"]})
    assert (
        pending["status"] == "awaiting_model_answers"
        and pending["differences_from_transcript"] is None
    )
    result = compare_answers(directory, capsule, questions, answers)
    assert result["status"] == "scored"
    assert result["variants"]["capsule"]["supported_answer_accuracy"] == 1
    assert result["variants"]["summary"]["accuracy"] == 0.5
    assert result["variants"]["summary"]["usage"] is None
    assert (
        result["differences_from_transcript"]["summary"]["input_token_reduction_fraction"] is None
    )


def test_cannot_gain_supported_credit_by_citing_visual_evidence_not_supplied(tmp_path):
    directory, capsule, questions, answers = comparison(tmp_path)
    answers["summary"]["answers"][1] = copy.deepcopy(answers["capsule"]["answers"][1])
    result = compare_answers(directory, capsule, questions, answers)
    assert result["variants"]["summary"]["accuracy"] == 1
    assert result["variants"]["summary"]["supported_answer_accuracy"] == 0.5
    assert not result["variants"]["summary"]["results"][1]["evidence_valid"]


def test_untimed_quotes_can_only_support_whole_video_questions(tmp_path):
    _, capsule, questions, answers = comparison(tmp_path)
    payload = json.loads(capsule)
    payload["transcript"]["segments"] = []
    payload["transcript"]["unsegmented_text"] = "The valve is closed."
    payload["transcript"]["summary"] = summarize_transcript("The valve is closed.").model_dump()
    modified = json.dumps(payload).encode()
    response = copy.deepcopy(answers["capsule"])
    response["answers"][0]["evidence"] = ["transcript.summary.excerpts[0]"]
    for end, supported in [(10, True), (4, False)]:
        questions["questions"][0]["end_sec"] = end
        identity = score_answers(modified, questions)
        response.update({key: identity[key] for key in ("capsule_sha256", "question_set_sha256")})
        assert score_answers(modified, questions, response)["results"][0]["evidence_valid"] is supported


@pytest.mark.parametrize("damage", ["input", "model", "settings", "digest", "summary", "abstract"])
def test_rejects_changed_inputs_unfair_runs_and_fabricated_quotes(tmp_path, damage):
    directory, capsule, questions, answers = comparison(tmp_path)
    if damage == "input":
        (directory / "summary.input.json").write_bytes(b"changed")
    if damage == "model":
        answers["summary"]["model"] = "another model"
    if damage == "settings":
        answers["summary"]["run_configuration"]["temperature"] = 1
    if damage == "digest":
        answers["summary"]["input_sha256"] = "b" * 64
    if damage == "summary":
        payload = json.loads(capsule)
        payload["transcript"]["summary"]["excerpts"][0]["text"] = "Invented answer."
        capsule = json.dumps(payload).encode()
    if damage == "abstract":
        payload = json.loads(capsule)
        payload["transcript"]["summary"]["abstract"] = "Invented answer."
        capsule = json.dumps(payload).encode()
    with pytest.raises(ValueError):
        compare_answers(directory, capsule, questions, answers)
