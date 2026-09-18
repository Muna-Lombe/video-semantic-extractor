#!/usr/bin/env python3
"""Serve a local prediction-blind object annotation review workspace."""

from __future__ import annotations

import argparse
import hmac
import json
import mimetypes
import os
import re
import subprocess
import sys
import tempfile
from http.cookies import SimpleCookie
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


class ReviewServer(ThreadingHTTPServer):
    def __init__(
        self,
        address: tuple[str, int],
        handler: type[BaseHTTPRequestHandler],
        root: Path,
        annotations: Path,
        sampling: Path,
        access_token: str | None = None,
    ):
        super().__init__(address, handler)
        self.review_root = root
        self.annotation_path = annotations.resolve()
        self.sampling_root = sampling.resolve()
        self.bundle_root = (
            self.annotation_path.parent / "agent-bundles" / self.annotation_path.stem
        )
        self.access_token = access_token


class ReviewHandler(BaseHTTPRequestHandler):
    server: ReviewServer

    def _authorized(self, query: dict[str, list[str]] | None = None) -> bool:
        """Accept the configured token from a bearer header, cookie, or bootstrap URL."""
        expected = self.server.access_token
        if expected is None:
            return True
        authorization = self.headers.get("Authorization", "")
        if authorization.startswith("Bearer ") and hmac.compare_digest(
            authorization.removeprefix("Bearer "), expected
        ):
            return True
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        if "annotation_review_token" in cookie and hmac.compare_digest(
            cookie["annotation_review_token"].value, expected
        ):
            return True
        supplied = (query or {}).get("token", [""])[0]
        return bool(supplied) and hmac.compare_digest(supplied, expected)

    def _require_authorization(self) -> bool:
        """Bootstrap an authenticated browser session or reject the request."""
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        if not self._authorized(query):
            self._send_json(
                {"error": "authorization required"}, HTTPStatus.UNAUTHORIZED
            )
            return False
        if self.server.access_token is not None and query.get("token"):
            secure = (
                "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
            )
            self.send_response(HTTPStatus.SEE_OTHER)
            self.send_header("Location", parsed.path or "/")
            self.send_header(
                "Set-Cookie",
                "annotation_review_token="
                f"{self.server.access_token}; Path=/; HttpOnly; SameSite=Strict{secure}",
            )
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return False
        return True

    def _send_json(self, payload: object, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _payload(self) -> dict[str, object]:
        return json.loads(self.server.annotation_path.read_text(encoding="utf-8"))

    def do_GET(self) -> None:  # noqa: N802
        if not self._require_authorization():
            return
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self._send_file(self.server.review_root / "index.html", "text/html")
        elif parsed.path == "/app.js":
            self._send_file(self.server.review_root / "app.js", "text/javascript")
        elif parsed.path == "/style.css":
            self._send_file(self.server.review_root / "style.css", "text/css")
        elif parsed.path == "/api/state":
            self._send_json({"annotations": self._payload()})
        elif parsed.path == "/api/frame":
            self._send_frame(parse_qs(parsed.query))
        elif parsed.path == "/api/bundles":
            self._send_json({"bundles": self._bundles()})
        elif parsed.path.startswith("/api/bundles/"):
            self._send_bundle(parsed.path.removeprefix("/api/bundles/"))
        else:
            self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def _bundles(self) -> list[dict[str, str]]:
        return [
            {"name": path.name, "url": f"/api/bundles/{path.name}"}
            for path in sorted(self.server.bundle_root.glob("*.zip"))
            if path.is_file()
        ]

    def _send_bundle(self, filename: str) -> None:
        bundle_root = self.server.bundle_root.resolve()
        bundle_path = (bundle_root / filename).resolve()
        if not bundle_path.is_relative_to(bundle_root) or bundle_path.suffix != ".zip":
            self._send_json({"error": "invalid bundle path"}, HTTPStatus.BAD_REQUEST)
            return
        if not bundle_path.is_file():
            self._send_json({"error": "bundle not found"}, HTTPStatus.NOT_FOUND)
            return
        self._send_file(bundle_path, "application/zip", download_name=bundle_path.name)

    def do_POST(self) -> None:  # noqa: N802
        if not self._require_authorization():
            return
        endpoint = urlparse(self.path).path
        if endpoint == "/api/bundles/generate":
            try:
                self._generate_bundles()
            except (OSError, subprocess.SubprocessError) as exc:
                self._send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
                return
            self._send_json({"bundles": self._bundles()})
            return
        if endpoint not in ("/api/save", "/api/import-agent"):
            self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            if endpoint == "/api/import-agent":
                request = json.loads(body)
                payload = self._import_agent(request.get("content", ""))
            else:
                payload = json.loads(body)
                self._validate_identity(payload)
            self._atomic_save(payload)
        except (ValueError, OSError, json.JSONDecodeError) as exc:
            self._send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
            return
        self._send_json({"saved": True, "path": str(self.server.annotation_path)})

    def _generate_bundles(self) -> None:
        exporter = Path(__file__).with_name("export-agent-bundles.py")
        subprocess.run(
            [
                sys.executable,
                str(exporter),
                str(self.server.annotation_path),
                str(self.server.sampling_root),
                str(self.server.bundle_root),
            ],
            check=True,
            capture_output=True,
            text=True,
        )

    def _import_agent(self, content: object) -> dict[str, object]:
        if not isinstance(content, str):
            raise ValueError("agent response content must be text")
        cleaned = re.sub(r"(^|\s)//[^\n\r]*", r"\1", content)
        cleaned = re.sub(r",\s*([}\]])", r"\1", cleaned)
        result = json.loads(cleaned)
        if not isinstance(result, dict):
            raise ValueError("agent response must be a JSON object")
        original = self._payload()
        source_name = result.get("source")
        source = next(
            (item for item in original["sources"] if item.get("source") == source_name),
            None,
        )
        if source is None or result.get("source_sha256") != source.get("source_sha256"):
            raise ValueError("agent source or checksum does not match this review file")
        incoming = result.get("frames")
        expected = {frame["filename"]: frame for frame in source["frames"]}
        if not isinstance(incoming, list) or any(
            not isinstance(frame, dict) for frame in incoming
        ):
            raise ValueError("agent response frames must be JSON objects")
        incoming_names = [frame.get("filename") for frame in incoming]
        if (
            len(incoming_names) != len(expected)
            or len(set(incoming_names)) != len(incoming_names)
            or set(incoming_names) != set(expected)
        ):
            raise ValueError(
                "agent response must contain every manifest frame exactly once"
            )
        for frame in incoming:
            expected_frame = expected[frame["filename"]]
            if frame.get("timestamp_sec") != expected_frame.get("timestamp_sec"):
                raise ValueError(f"timestamp mismatch for {frame['filename']}")
            if not isinstance(frame.get("objects"), list) or not isinstance(
                frame.get("out_of_taxonomy"), list
            ):
                raise ValueError(f"invalid annotation lists for {frame['filename']}")
        for frame in source["frames"]:
            replacement = next(
                item for item in incoming if item["filename"] == frame["filename"]
            )
            frame["objects"] = replacement["objects"]
            frame["out_of_taxonomy"] = replacement["out_of_taxonomy"]
        return original

    def _send_file(
        self, path: Path, content_type: str, download_name: str | None = None
    ) -> None:
        try:
            body = path.read_bytes()
        except OSError:
            self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        if download_name:
            self.send_header(
                "Content-Disposition", f'attachment; filename="{download_name}"'
            )
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_HEAD(self) -> None:  # noqa: N802
        if not self._require_authorization():
            return
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/bundles/"):
            filename = parsed.path.removeprefix("/api/bundles/")
            bundle_root = self.server.bundle_root.resolve()
            bundle_path = (bundle_root / filename).resolve()
            if (
                bundle_path.is_relative_to(bundle_root)
                and bundle_path.is_file()
                and bundle_path.suffix == ".zip"
            ):
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "application/zip")
                self.send_header("Content-Length", str(bundle_path.stat().st_size))
                self.send_header(
                    "Content-Disposition", f'attachment; filename="{bundle_path.name}"'
                )
                self.end_headers()
                return
        self.send_error(HTTPStatus.NOT_FOUND)

    def _send_frame(self, query: dict[str, list[str]]) -> None:
        source = query.get("source", [""])[0]
        filename = query.get("filename", [""])[0]
        payload = self._payload()
        frame_names = {
            frame.get("filename")
            for item in payload.get("sources", [])
            if item.get("source") == source
            for frame in item.get("frames", [])
        }
        if filename not in frame_names:
            self._send_json(
                {"error": "frame is not in annotation manifest"}, HTTPStatus.NOT_FOUND
            )
            return
        frames_root = (
            self.server.sampling_root / Path(source).stem / "hybrid" / "frames"
        )
        image_path = (frames_root / filename).resolve()
        if not image_path.is_relative_to(frames_root.resolve()):
            self._send_json({"error": "unsafe frame path"}, HTTPStatus.BAD_REQUEST)
            return
        self._send_file(
            image_path, mimetypes.guess_type(image_path.name)[0] or "image/jpeg"
        )

    def _validate_identity(self, payload: object) -> None:
        if not isinstance(payload, dict):
            raise ValueError("annotation payload must be an object")
        original = self._payload()
        if payload.get("policy_version") != original.get("policy_version"):
            raise ValueError("policy_version cannot change in the review UI")
        original_identity = [
            (
                source.get("source"),
                source.get("source_sha256"),
                [frame.get("filename") for frame in source.get("frames", [])],
            )
            for source in original.get("sources", [])
        ]
        new_identity = [
            (
                source.get("source"),
                source.get("source_sha256"),
                [frame.get("filename") for frame in source.get("frames", [])],
            )
            for source in payload.get("sources", [])
        ]
        if new_identity != original_identity:
            raise ValueError(
                "source checksums and manifest frame identity cannot change"
            )

    def _atomic_save(self, payload: dict[str, object]) -> None:
        self.server.annotation_path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{self.server.annotation_path.name}.",
            suffix=".tmp",
            dir=self.server.annotation_path.parent,
            text=True,
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2)
                handle.write("\n")
            os.replace(temporary_name, self.server.annotation_path)
        except BaseException:
            Path(temporary_name).unlink(missing_ok=True)
            raise


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run the local object annotation review UI"
    )
    parser.add_argument("sampling_root", type=Path)
    parser.add_argument("annotations", type=Path)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument(
        "--access-token",
        default=os.environ.get("ANNOTATION_REVIEW_TOKEN"),
        help="require this secret in the initial ?token= URL (or ANNOTATION_REVIEW_TOKEN)",
    )
    args = parser.parse_args()
    review_root = Path(__file__).with_name("web")
    server = ReviewServer(
        (args.host, args.port),
        ReviewHandler,
        review_root,
        args.annotations,
        args.sampling_root,
        args.access_token,
    )
    print(f"Annotation review UI: http://{args.host}:{args.port}/")
    print(f"Saving annotation metadata to {server.annotation_path}")
    if server.access_token:
        print("Access token protection enabled; open /?token=<token> once")
    server.serve_forever()


if __name__ == "__main__":
    main()
