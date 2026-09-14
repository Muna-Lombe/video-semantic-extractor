"""@type test
@purpose Verify API liveness and SSRF-resistant URL validation.
"""

import socket

import pytest
from fastapi.testclient import TestClient

from video_semantic_extractor.api import create_app, validate_public_url


def test_health_endpoint() -> None:
    response = TestClient(create_app()).get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.parametrize(
    "url",
    ["file:///etc/passwd", "http://user:pass@example.com/a.mp4", "not-a-url"],
)
def test_url_validation_rejects_unsafe_shapes(url: str) -> None:
    with pytest.raises(ValueError):
        validate_public_url(url)


def test_url_validation_rejects_private_resolution(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 80))],
    )

    with pytest.raises(ValueError, match="public"):
        validate_public_url("http://example.test/video.mp4")
