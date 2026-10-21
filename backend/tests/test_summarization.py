"""@type test @purpose Verify whole-transcript coverage, bounded quotes and trustworthy summary references."""

import os
import subprocess
import sys

import pytest

from video_semantic_extractor.schema import TranscriptSegment
from video_semantic_extractor.summarization import summarize_transcript


def transcript():
    return [
        TranscriptSegment(
            start_sec=index * 5,
            end_sec=index * 5 + 4,
            text=f"Section {index} records measurement {index + 20} for equipment {index + 100}.",
        )
        for index in range(30)
    ]


def test_summary_reaches_early_middle_and_late_transcript_under_one_budget():
    segments = transcript()
    summary = summarize_transcript("", segments, max_chars=240)
    assert len(summary.abstract) <= 240
    assert summary.truncated
    assert any(excerpt.start_sec < 50 for excerpt in summary.excerpts)
    assert any(50 <= excerpt.start_sec < 100 for excerpt in summary.excerpts)
    assert any(excerpt.start_sec >= 100 for excerpt in summary.excerpts)
    assert summary.omitted_units == summary.source_units - summary.selected_units
    assert summary.implementation_version.startswith("extractive_temporal.v1@sha256:")
    assert summary == summarize_transcript("", segments, max_chars=240)


@pytest.mark.parametrize("budget", [0, 1, 30, 79, 150, 800, 10000])
def test_every_quote_is_a_complete_source_sentence_with_original_timing(budget):
    segments = transcript()
    summary = summarize_transcript(
        "Text absent from the segment evidence.", segments, max_chars=budget
    )
    assert len(summary.abstract) <= budget
    previous = -1
    for excerpt in summary.excerpts:
        index = int(excerpt.evidence.split("[")[1][:-1])
        assert index > previous
        previous = index
        assert excerpt.text == segments[index].text
        assert (excerpt.start_sec, excerpt.end_sec) == (
            segments[index].start_sec,
            segments[index].end_sec,
        )
    assert "Text absent" not in summary.abstract


def test_preserves_negation_numbers_and_changes_without_paraphrasing():
    segments = [
        TranscriptSegment(
            start_sec=0,
            end_sec=2,
            text="Do not open\nthis valve while hot. Keep pressure below 25 psi.",
        ),
        TranscriptSegment(
            start_sec=9, end_sec=12, text="The valve is now open. Pressure is 30 psi."
        ),
    ]
    summary = summarize_transcript("", segments)
    assert "Do not open this valve while hot." in summary.abstract
    assert "25 psi" in summary.abstract and "30 psi" in summary.abstract
    assert len(summary.excerpts) == 4
    assert all(
        excerpt.text in segments[int(excerpt.evidence.split("[")[1][:-1])].text
        for excerpt in summary.excerpts
    )
    assert not summary.truncated
    assert summarize_transcript("Do not open\nthis valve while hot.", max_chars=20).excerpts == []


def test_untimed_text_is_not_given_fabricated_timestamps_and_unicode_is_preserved():
    text = "阀门关闭。不要打开！ 温度正常。"
    summary = summarize_transcript(text)
    assert len(summary.excerpts) == 3
    assert all(
        excerpt.evidence == "transcript.unsegmented_text"
        and excerpt.start_sec is None
        and excerpt.end_sec is None
        for excerpt in summary.excerpts
    )
    assert all(excerpt.text in text for excerpt in summary.excerpts)


def test_empty_and_oversized_sentences_remain_explicit():
    empty = summarize_transcript("")
    assert empty.abstract == "" and not empty.truncated and empty.source_units == 0
    oversized = summarize_transcript("long " * 200, max_chars=80)
    assert oversized.abstract == "" and oversized.truncated and oversized.omitted_units == 1
    with pytest.raises(ValueError):
        summarize_transcript("hello", max_chars=-1)


def test_asr_segment_boundaries_cannot_separate_negation_from_its_claim():
    segments = [
        TranscriptSegment(start_sec=0, end_sec=2, text="Do not"),
        TranscriptSegment(start_sec=2, end_sec=4, text="open the valve while hot."),
        TranscriptSegment(start_sec=4, end_sec=5, text="Ready."),
    ]
    summary = summarize_transcript("", segments, max_chars=30)
    assert summary.abstract == "Ready."
    assert summary.omitted_units == 1
    complete = summarize_transcript("", segments)
    assert complete.abstract.startswith("Do not open the valve while hot.")
    assert complete.excerpts[0].evidence == "transcript.segments[0]"
    assert complete.excerpts[1].evidence == "transcript.segments[1]"
    assert complete.selected_units == 2 and len(complete.excerpts) == 3


def test_summary_selection_is_reproducible_across_python_hash_seeds():
    code = "from video_semantic_extractor.summarization import summarize_transcript; print(summarize_transcript(' '.join(f'Section {i} records measurement {i+20} for equipment {i+100}.' for i in range(30)), max_chars=240).model_dump_json())"
    results = [
        subprocess.check_output(
            [sys.executable, "-c", code], env={**os.environ, "PYTHONHASHSEED": str(seed)}, text=True
        )
        for seed in (1, 77, 123)
    ]
    assert len(set(results)) == 1
