"""@type test
@purpose Verify independent object-review comparison and disagreement reporting.
"""

import importlib.util
import sys
from pathlib import Path


SCRIPT = Path(__file__).parents[2] / "scripts" / "diagnostics" / "compare-object-reviews.py"
SPEC = importlib.util.spec_from_file_location("compare_object_reviews", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
comparator = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = comparator
SPEC.loader.exec_module(comparator)


def review_payload(region: list[int] | None = None) -> dict[str, object]:
    return {
        "policy_version": "2026-09-18",
        "sources": [
            {
                "source": "sample_1.mp4",
                "frames": [
                    {
                        "filename": "frame.jpg",
                        "objects": [
                            {
                                "id": "object-1",
                                "label": "person",
                                "subset": "live",
                                "region": region or [10, 10, 40, 50],
                            }
                        ],
                        "out_of_taxonomy": [],
                    }
                ],
            }
        ],
    }


def test_identical_reviews_agree() -> None:
    report = comparator.compare_reviews(review_payload(), review_payload())

    assert report == {"agree": True, "frames_compared": 1, "disagreements": []}


def test_independent_ids_do_not_create_a_false_disagreement() -> None:
    right = review_payload()
    right["sources"][0]["frames"][0]["objects"][0]["id"] = "reviewer-b-1"

    report = comparator.compare_reviews(review_payload(), right)

    assert report["agree"] is True


def test_box_disagreement_is_reported_below_review_iou_threshold() -> None:
    report = comparator.compare_reviews(
        review_payload(), review_payload([80, 10, 40, 50])
    )

    assert report["agree"] is False
    assert {item["type"] for item in report["disagreements"]} == {
        "left_unmatched",
        "right_unmatched",
    }


def test_missing_frame_is_reported_as_coverage_disagreement() -> None:
    empty_review = {"policy_version": "2026-09-18", "sources": []}

    report = comparator.compare_reviews(review_payload(), empty_review)

    assert report["frames_compared"] == 0
    assert report["disagreements"] == [
        {"source": "sample_1.mp4", "filename": "frame.jpg", "type": "frame_coverage"}
    ]