"""@type schema
@purpose Define the stable, validated VideoCapsule ingestion contract.
"""

from pydantic import BaseModel, ConfigDict, Field


class StrictModel(BaseModel):
    """Reject unknown fields so producers cannot silently drift the contract."""

    model_config = ConfigDict(extra="forbid")


class Metadata(StrictModel):
    duration_sec: float = Field(ge=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    source_file: str
    has_audio: bool


class TranscriptSegment(StrictModel):
    start_sec: float = Field(ge=0)
    end_sec: float = Field(ge=0)
    text: str
    speaker: str | None = None
    intent: str | None = None


class TranscriptSummary(StrictModel):
    abstract: str
    keywords: list[str] = Field(default_factory=list)
    method: str
    truncated: bool = False


class Transcript(StrictModel):
    language: str | None = None
    summary: TranscriptSummary
    segments: list[TranscriptSegment]


class ObjectObservation(StrictModel):
    label: str
    confidence: float = Field(ge=0, le=1)


class VisualFeatures(StrictModel):
    brightness: float = Field(ge=0, le=255)
    edge_density: float = Field(ge=0, le=1)


class Keyframe(StrictModel):
    id: int = Field(ge=0)
    timestamp_sec: float = Field(ge=0)
    features: VisualFeatures
    objects: list[ObjectObservation] = Field(default_factory=list)
    actions: list[str] = Field(default_factory=list)
    text_in_frame: list[str] = Field(default_factory=list)
    analyzer: str = "basic_cv"
    embedding_int8: list[int] | None = None


class TimelineEvent(StrictModel):
    start_sec: float = Field(ge=0)
    end_sec: float = Field(ge=0)
    event_type: str
    description: str
    evidence: list[str] = Field(default_factory=list)


class Entity(StrictModel):
    id: str
    label: str
    attributes: dict[str, str] = Field(default_factory=dict)


class Relation(StrictModel):
    subject: str
    predicate: str
    object: str
    start_sec: float | None = Field(default=None, ge=0)
    end_sec: float | None = Field(default=None, ge=0)


class SceneGraph(StrictModel):
    entities: list[Entity] = Field(default_factory=list)
    relations: list[Relation] = Field(default_factory=list)


class VideoCapsule(StrictModel):
    version: str = "1.0"
    metadata: Metadata
    transcript: Transcript
    keyframes: list[Keyframe]
    timeline: list[TimelineEvent]
    scene_graph: SceneGraph = Field(default_factory=SceneGraph)
    warnings: list[str] = Field(default_factory=list)
