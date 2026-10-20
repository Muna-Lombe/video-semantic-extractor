"""@type implementation @purpose Resolve approved release snapshots and verify model bytes before Product inference."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit

import cv2
import requests

from .engine_identity import evaluation_implementation
from .pipeline import CapsuleBuilder, ExtractionError
from .visual import VisualAnalyzer


class ProductNotReady(ExtractionError):
    """The configured Product execution path has no compatible approved release."""


def _read(session: requests.Session, origin: str, path: str, maximum: int) -> bytes:
    with session.get(
        origin + path, timeout=(5, 60), stream=True, allow_redirects=False
    ) as response:
        if response.status_code != 200:
            raise ProductNotReady(
                f"Product release input is unavailable (HTTP {response.status_code})"
            )
        chunks = []
        size = 0
        for chunk in response.iter_content(64 * 1024):
            size += len(chunk)
            if size > maximum:
                raise ProductNotReady("Product release input exceeds its byte budget")
            chunks.append(chunk)
        return b"".join(chunks)


@contextmanager
def configured_builder(**options) -> Iterator[CapsuleBuilder]:
    """Select a server-configured mode; incoming requests cannot choose model inputs."""
    mode = os.getenv("CAPSULE_VISUAL_MODE", "basic")
    if mode == "basic":
        yield CapsuleBuilder(**options)
        return
    if mode == "ocr":
        analyzer = VisualAnalyzer()
        builder = CapsuleBuilder(frame_analyzer=analyzer, **options)
        builder.execution = {
            "mode": "ocr",
            "ocr_engine": analyzer.ocr_version,
            "ocr_psm": 11,
            "ocr_minimum_confidence": 0.5,
        }
        yield builder
        return
    if mode != "governed":
        raise ProductNotReady("CAPSULE_VISUAL_MODE must be basic, ocr, or governed")
    origin = os.getenv("CAPSULE_CONTROL_PLANE_URL", "").rstrip("/")
    parsed = urlsplit(origin)
    token = os.getenv("CAPSULE_CONTROL_PLANE_TOKEN", "")
    service_binding = origin == "http://product-control.internal" and token == "service-binding"
    if (
        (parsed.scheme != "https" and not service_binding)
        or not parsed.hostname
        or parsed.path
        or parsed.query
        or parsed.fragment
        or parsed.username
        or parsed.password
        or not token
    ):
        raise ProductNotReady(
            "Governed extraction requires an HTTPS control-plane origin and a service credential"
        )
    try:
        with (
            requests.Session() as session,
            tempfile.TemporaryDirectory(prefix="capsule-model-") as directory,
        ):
            session.headers.update({"authorization": f"Bearer {token}"})
            plan = json.loads(
                _read(session, origin, "/api/internal/v1/releases/active/execution", 64 * 1024)
            )["data"]
            if plan["schema_version"] != "product-execution.v1" or not re.fullmatch(
                r"release_[a-f0-9]{32}", plan["release_id"]
            ):
                raise ProductNotReady("Unsupported Product execution manifest")
            configuration = plan["configuration_json"]
            if hashlib.sha256(configuration.encode()).hexdigest() != plan["configuration_sha256"]:
                raise ProductNotReady("Release configuration checksum mismatch")
            config = json.loads(configuration)
            model = plan["model"]
            package = Path(__file__).parent
            sampler_sha = hashlib.sha256(
                b"pipeline.py\0"
                + (package / "pipeline.py").read_bytes()
                + b"sampling_runner.py\0"
                + (package / "sampling_runner.py").read_bytes()
            ).hexdigest()
            script = Path(
                os.getenv(
                    "CAPSULE_EVALUATOR_PATH",
                    str(package.parents[1] / "scripts/diagnostics/evaluate-frame-objects.py"),
                )
            )
            expected = {
                "sampler": f"video-semantic-extractor@1.0.0@sha256:{sampler_sha}",
                "evaluator": evaluation_implementation(script),
                "annotation_schema": "object-annotations.v1",
            }
            if (
                config["components"] != expected
                or config["schema_version"] != "pipeline-release.v1"
            ):
                raise ProductNotReady("Active release does not match this Product engine build")
            if (
                not re.fullmatch(r"mv_[a-f0-9]{32}", model["id"])
                or config["model_version_id"] != model["id"]
                or model["architecture"] != "nanodet-plus-1.5x-416"
                or model["download_path"] != f"/api/internal/v1/models/{model['id']}/artifact"
            ):
                raise ProductNotReady("Release model identity or download path is invalid")
            payload = _read(session, origin, model["download_path"], 16 * 1024 * 1024)
            if (
                len(payload) != model["size_bytes"]
                or hashlib.sha256(payload).hexdigest() != model["sha256"]
            ):
                raise ProductNotReady("Release model checksum or size mismatch")
            model_path = Path(directory) / "model.onnx"
            model_path.write_bytes(payload)
            thresholds = config["thresholds"]
            for key in ("minimum_confidence", "nms_threshold", "minimum_iou"):
                value = thresholds[key]
                if (
                    isinstance(value, bool)
                    or not isinstance(value, (int, float))
                    or not 0 <= value <= 1
                ):
                    raise ProductNotReady("Release thresholds are invalid")
            analyzer = VisualAnalyzer(
                model_path,
                confidence=thresholds["minimum_confidence"],
                nms=thresholds["nms_threshold"],
            )
            builder = CapsuleBuilder(frame_analyzer=analyzer, **options)
            builder.execution = {
                "mode": "governed",
                "release_id": plan["release_id"],
                "release_revision": plan["release_revision"],
                "configuration_sha256": plan["configuration_sha256"],
                "evaluation_run_id": plan["evaluation_run_id"],
                "model_sha256": model["sha256"],
                "ocr_engine": analyzer.ocr_version,
                "opencv_version": cv2.__version__,
                "ocr_psm": 11,
                "ocr_minimum_confidence": 0.5,
                "minimum_confidence": thresholds["minimum_confidence"],
                "nms_threshold": thresholds["nms_threshold"],
            }
            yield builder
    except ProductNotReady:
        raise
    except (requests.RequestException, OSError, KeyError, TypeError, ValueError, cv2.error) as exc:
        raise ProductNotReady("Could not verify the approved Product execution inputs") from exc
