"""@type test @purpose Reject misleading capsule QA scores from mismatched evidence or fabricated completion."""

import copy

import pytest

from video_semantic_extractor.capsule_evaluation import score_answers
from video_semantic_extractor.schema import VideoCapsule


def fixture():
    capsule = (
        VideoCapsule.model_validate(
            {
                "metadata": {
                    "duration_sec": 10,
                    "width": 100,
                    "height": 100,
                    "source_file": "fixture.mp4",
                    "source_sha256": "a" * 64,
                    "has_audio": False,
                },
                "transcript": {
                    "summary": {"abstract": "", "method": "extractive_prefix"},
                    "segments": [],
                },
                "keyframes": [
                    {
                        "id": 0,
                        "timestamp_sec": 8,
                        "features": {"brightness": 100, "edge_density": 0.1},
                        "text_observations": [
                            {"text": "CLOSED", "confidence": 0.9, "region": [0, 0, 50, 20]}
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
                "question": "What valve status is displayed near the end?",
                "accepted_answers": ["closed"],
                "start_sec": 7,
                "end_sec": 10,
                "modality": "text",
            }
        ],
    }
    awaiting = score_answers(capsule, questions)
    answers = {
        "schema_version": "capsule-answers.v1",
        "model": "unit-test responder, not a real LLM run",
        "capsule_sha256": awaiting["capsule_sha256"],
        "question_set_sha256": awaiting["question_set_sha256"],
        "answers": [
            {
                "question_id": "valve",
                "answer": "CLOSED.",
                "evidence": ["keyframes[0].text_observations[0]"],
            }
        ],
    }
    return capsule, questions, answers


def test_unanswered_questions_have_no_fabricated_accuracy_or_usage():
    capsule, questions, _ = fixture()
    result = score_answers(capsule, questions)
    assert result["status"] == "awaiting_model_answers"
    assert result["accuracy"] is None and result["usage"] is None


def test_answers_need_correct_content_and_valid_timed_evidence():
    capsule, questions, answers = fixture()
    good = score_answers(capsule, questions, answers)
    assert good["accuracy"] == good["supported_answer_accuracy"] == 1
    changed = copy.deepcopy(answers)
    changed["answers"][0]["answer"] = "open"
    assert score_answers(capsule, questions, changed)["accuracy"] == 0
    changed = copy.deepcopy(answers)
    changed["answers"][0]["evidence"] = ["keyframes[999].text_observations[0]"]
    assert score_answers(capsule, questions, changed)["supported_answer_accuracy"] == 0
    changed = copy.deepcopy(questions)
    changed["questions"][0]["end_sec"] = 6
    changed["questions"][0]["start_sec"] = 0
    rebound = copy.deepcopy(answers)
    rebound["question_set_sha256"] = score_answers(capsule, changed)["question_set_sha256"]
    assert score_answers(capsule, changed, rebound)["supported_answer_accuracy"] == 0


@pytest.mark.parametrize("damage", ["source", "capsule", "questions", "duplicates", "usage"])
def test_mismatched_inputs_and_invented_usage_are_rejected(damage):
    capsule, questions, answers = fixture()
    if damage == "source":
        questions["source_sha256"] = "b" * 64
    if damage == "capsule":
        answers["capsule_sha256"] = "b" * 64
    if damage == "questions":
        answers["question_set_sha256"] = "b" * 64
    if damage == "duplicates":
        answers["answers"] *= 2
    if damage == "usage":
        answers["usage"] = {"input_tokens": float("nan"), "output_tokens": 0, "elapsed_ms": 1}
    with pytest.raises(ValueError):
        score_answers(capsule, questions, answers)
