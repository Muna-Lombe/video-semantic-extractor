"""@type implementation @purpose Select traceable whole-sentence excerpts across a transcript without paraphrasing."""

from __future__ import annotations

import hashlib
import math
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from .schema import SummaryExcerpt, TranscriptSegment, TranscriptSummary

SUMMARY_METHOD = "extractive_temporal.v1"


def summary_implementation() -> str:
    return SUMMARY_METHOD + "@sha256:" + hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


@dataclass(frozen=True)
class _Unit:
    excerpts: tuple[SummaryExcerpt, ...]
    position: float
    ordinal: int

    @property
    def normalized(self) -> str:
        return " ".join(" ".join(excerpt.text.split()) for excerpt in self.excerpts)


def _sentences(text: str) -> list[str]:
    # Newlines alone cannot split a negation from the rest of its claim.
    # Every retained quote remains an exact substring of its cited source.
    return [
        part.strip() for part in re.split(r"(?<=[.!?])\s+|(?<=[。！？])\s*", text) if part.strip()
    ]


def summarize_transcript(
    text: str,
    segments: list[TranscriptSegment] | None = None,
    max_chars: int = 800,
) -> TranscriptSummary:
    """Balance early/middle/late excerpts, then fill remaining budget by lexical novelty.

    The budget includes omission separators. Oversized sentences are omitted rather
    than cut into unsupported claims. All dense source segments remain available.
    """
    if isinstance(max_chars, bool) or not isinstance(max_chars, int) or max_chars < 0:
        raise ValueError("summary character budget must be a nonnegative integer")
    units: list[_Unit] = []
    if segments:
        pending: list[SummaryExcerpt] = []
        previous_start = 0.0

        def flush() -> None:
            if pending:
                units.append(
                    _Unit(
                        tuple(pending), (pending[0].start_sec + pending[-1].end_sec) / 2, len(units)
                    )
                )
                pending.clear()

        for index, segment in enumerate(segments):
            if (
                not math.isfinite(segment.start_sec)
                or not math.isfinite(segment.end_sec)
                or segment.end_sec < segment.start_sec
                or segment.start_sec < previous_start
            ):
                raise ValueError("summary evidence requires finite, ordered segment timestamps")
            previous_start = segment.start_sec
            for sentence in _sentences(segment.text):
                pending.append(
                    SummaryExcerpt(
                        text=sentence,
                        evidence=f"transcript.segments[{index}]",
                        start_sec=segment.start_sec,
                        end_sec=segment.end_sec,
                    )
                )
                if re.search(r"[.!?。！？][\"'”’»)]*$", sentence):
                    flush()
        flush()
    else:
        for index, sentence in enumerate(_sentences(text)):
            units.append(
                _Unit(
                    (SummaryExcerpt(text=sentence, evidence="transcript.unsegmented_text"),),
                    float(index),
                    index,
                )
            )

    def render(selected: list[_Unit]) -> str:
        result = ""
        previous = -1
        for unit in sorted(selected, key=lambda item: item.ordinal):
            separator = " " if unit.ordinal == previous + 1 else " … "
            result += (separator if result else "") + unit.normalized
            previous = unit.ordinal
        return result

    selected: list[_Unit] = []
    if len(render(units)) <= max_chars:
        selected = units
    elif units:
        words = [set(re.findall(r"\w+", unit.normalized.casefold())) for unit in units]
        frequency = Counter(word for tokens in words for word in tokens)
        minimum = min(unit.position for unit in units)
        maximum = max(unit.position for unit in units)

        def group(unit: _Unit) -> int:
            fraction = (
                ((unit.position - minimum) / (maximum - minimum))
                if maximum > minimum
                else unit.ordinal / max(1, len(units) - 1)
            )
            return min(2, int(fraction * 3))

        seen_text: set[str] = set()
        seen_words: set[str] = set()

        def priority(unit: _Unit) -> tuple[float, int]:
            tokens = words[unit.ordinal]
            novelty = sum(1 / frequency[word] for word in sorted(tokens) if word not in seen_words)
            return novelty / math.sqrt(max(1, len(tokens))), -unit.ordinal

        def add(unit: _Unit) -> None:
            selected.append(unit)
            seen_text.add(unit.normalized)
            seen_words.update(words[unit.ordinal])

        share = max(0, (max_chars - 6) // 3)
        for bucket in range(3):
            eligible = [
                unit
                for unit in units
                if group(unit) == bucket
                and len(unit.normalized) <= share
                and unit.normalized not in seen_text
            ]
            if eligible:
                add(max(eligible, key=priority))
        # Reserve the worst-case separator cost; rendering can only be shorter.
        remaining = (
            max_chars
            - sum(len(unit.normalized) for unit in selected)
            - max(0, len(selected) - 1) * 3
        )
        while True:
            eligible = [
                unit
                for unit in units
                if unit.normalized not in seen_text
                and len(unit.normalized) + (3 if selected else 0) <= remaining
            ]
            if not eligible:
                break
            chosen = max(eligible, key=priority)
            remaining -= len(chosen.normalized) + (3 if selected else 0)
            add(chosen)

    selected.sort(key=lambda unit: unit.ordinal)
    return TranscriptSummary(
        abstract=render(selected),
        method=SUMMARY_METHOD,
        truncated=len(selected) < len(units),
        excerpts=[excerpt for unit in selected for excerpt in unit.excerpts],
        implementation_version=summary_implementation(),
        budget_chars=max_chars,
        source_units=len(units),
        selected_units=len(selected),
        omitted_units=len(units) - len(selected),
    )
