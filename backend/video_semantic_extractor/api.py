"""@type implementation
@purpose Expose secure remote-video capsule generation through FastAPI.
@dependencies pipeline.py
"""

from __future__ import annotations

import ipaddress
import os
import socket
import tempfile
from pathlib import Path
from urllib.parse import urlparse

import requests
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .pipeline import CapsuleBuilder, ExtractionError
from .schema import VideoCapsule


class CapsuleRequest(BaseModel):
    """Validated request body for remote extraction."""

    model_config = ConfigDict(extra="forbid")
    video_url: str = Field(min_length=8, max_length=2048)


def _setting_int(name: str, default: int) -> int:
    """Read a positive integer environment setting."""
    value = int(os.getenv(name, str(default)))
    if value <= 0:
        raise ValueError(f"{name} must be positive")
    return value


def validate_public_url(url: str, allow_private: bool = False) -> str:
    """Reject credentials and non-public destinations that could enable SSRF."""
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("video_url must be an absolute HTTP(S) URL")
    if parsed.username or parsed.password:
        raise ValueError("video_url must not contain credentials")
    if allow_private:
        return url
    try:
        addresses = socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ValueError("video_url hostname could not be resolved") from exc
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if not ip.is_global:
            raise ValueError("video_url must resolve only to public addresses")
    return url


def download_video(url: str, destination: Path, max_bytes: int, timeout_sec: int) -> None:
    """Stream a public video to disk while enforcing a hard byte limit."""
    allow_private = os.getenv("CAPSULE_ALLOW_PRIVATE_URLS") == "1"
    validated = validate_public_url(url, allow_private)
    total = 0
    with requests.get(
        validated, stream=True, timeout=(5, timeout_sec), allow_redirects=False
    ) as response:
        if 300 <= response.status_code < 400:
            raise ValueError("redirect responses are not accepted")
        response.raise_for_status()
        declared = int(response.headers.get("content-length", "0"))
        if declared > max_bytes:
            raise ValueError("video exceeds download size limit")
        with destination.open("wb") as output:
            for chunk in response.iter_content(chunk_size=64 * 1024):
                total += len(chunk)
                if total > max_bytes:
                    raise ValueError("video exceeds download size limit")
                output.write(chunk)
    if total == 0:
        raise ValueError("downloaded video is empty")


def create_app(builder: CapsuleBuilder | None = None) -> FastAPI:
    """Create an API application, optionally injecting an extractor for tests."""
    app = FastAPI(title="Video Semantic Capsule API", version="1.0.0")
    capsule_builder = builder or CapsuleBuilder()

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/capsule", response_model=VideoCapsule)
    def capsule_endpoint(payload: CapsuleRequest) -> VideoCapsule:
        max_bytes = _setting_int("CAPSULE_MAX_DOWNLOAD_BYTES", 500_000_000)
        timeout_sec = _setting_int("CAPSULE_DOWNLOAD_TIMEOUT_SEC", 120)
        try:
            with tempfile.TemporaryDirectory(prefix="capsule-download-") as directory:
                local_path = Path(directory) / "input.video"
                download_video(payload.video_url, local_path, max_bytes, timeout_sec)
                return capsule_builder.build(local_path)
        except (ValueError, requests.RequestException) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except ExtractionError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    return app


app = create_app()
