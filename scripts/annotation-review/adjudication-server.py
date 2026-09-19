#!/usr/bin/env python3
"""Serve an isolated UI for adjudicating two completed human review files."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import tempfile
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


COMPARE_SCRIPT = Path(__file__).parents[1] / "diagnostics" / "compare-object-reviews.py"
SPEC = importlib.util.spec_from_file_location("compare_object_reviews", COMPARE_SCRIPT)
assert SPEC is not None and SPEC.loader is not None
comparison = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(comparison)


def _read(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def _identity(payload: dict[str, object]) -> list[tuple[object, object, list[object]]]:
    return [
        (
            source.get("source"),
            source.get("source_sha256"),
            [frame.get("filename") for frame in source.get("frames", [])],
        )
        for source in payload.get("sources", [])
    ]


def _frame(payload: dict[str, object], source_name: str, filename: str) -> dict[str, object]:
    for source in payload.get("sources", []):
        if source.get("source") == source_name:
            for frame in source.get("frames", []):
                if frame.get("filename") == filename:
                    return frame
    raise ValueError("unknown adjudication frame")


class AdjudicationServer(ThreadingHTTPServer):
    def __init__(self, address, handler, root, left, right, output, sampling):
        super().__init__(address, handler)
        self.root = root.resolve()
        self.left_path = left.resolve()
        self.right_path = right.resolve()
        self.output_path = output.resolve()
        self.sampling_root = sampling.resolve()
        left_payload = _read(self.left_path)
        right_payload = _read(self.right_path)
        if self.left_path == self.right_path:
            raise ValueError("Reviewer A and Reviewer B must be distinct files")
        if left_payload.get("policy_version") != right_payload.get("policy_version"):
            raise ValueError("reviewer files do not use the same annotation policy")
        if _identity(left_payload) != _identity(right_payload):
            raise ValueError("reviewer files do not have identical evidence identity")
        for label, payload in (("A", left_payload), ("B", right_payload)):
            review = payload.get("review", {})
            if review.get("manual_pass", {}).get("status") != "complete":
                raise ValueError(f"Reviewer {label} manual pass is not complete")
        if not self.output_path.exists():
            merged = json.loads(json.dumps(left_payload))
            merged["review"]["independent_passes"] = 2
            merged["review"]["adjudication_status"] = "in_progress"
            merged["review"]["adjudication_log"] = []
            self._save(merged)
        elif _identity(_read(self.output_path)) != _identity(left_payload):
            raise ValueError("existing merged output has different evidence identity")

    def _save(self, payload: dict[str, object]) -> None:
        self.output_path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(dir=self.output_path.parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2)
                handle.write("\n")
            os.replace(temporary, self.output_path)
        except BaseException:
            Path(temporary).unlink(missing_ok=True)
            raise


class AdjudicationHandler(BaseHTTPRequestHandler):
    server: AdjudicationServer

    def _json(self, payload: object, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _state(self) -> dict[str, object]:
        left, right, merged = map(
            _read, (self.server.left_path, self.server.right_path, self.server.output_path)
        )
        return {
            "workspace": "adjudicator-c",
            "reviewer_a": left,
            "reviewer_b": right,
            "merged": merged,
            "comparison": comparison.compare_reviews(left, right),
        }

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        files = {"/": "index.html", "/app.js": "app.js", "/style.css": "style.css"}
        if parsed.path in files:
            path = self.server.root / files[parsed.path]
            body = path.read_bytes()
            content_type = "text/html" if path.suffix == ".html" else "text/css" if path.suffix == ".css" else "text/javascript"
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif parsed.path == "/api/state":
            self._json(self._state())
        elif parsed.path == "/api/frame":
            query = parse_qs(parsed.query)
            source = query.get("source", [""])[0]
            filename = query.get("filename", [""])[0]
            _frame(_read(self.server.output_path), source, filename)
            root = self.server.sampling_root / Path(source).stem / "hybrid" / "frames"
            path = (root / filename).resolve()
            if not path.is_relative_to(root.resolve()):
                self._json({"error": "unsafe frame path"}, HTTPStatus.BAD_REQUEST)
                return
            body = path.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:  # noqa: N802
        try:
            request = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            merged = _read(self.server.output_path)
            if self.path == "/api/resolve":
                source, filename = request["source"], request["filename"]
                replacement = request["frame"]
                target = _frame(merged, source, filename)
                if replacement.get("filename") != filename or replacement.get("timestamp_sec") != target.get("timestamp_sec"):
                    raise ValueError("resolved frame identity cannot change")
                target["objects"] = replacement.get("objects", [])
                target["out_of_taxonomy"] = replacement.get("out_of_taxonomy", [])
                log = merged["review"].setdefault("adjudication_log", [])
                log[:] = [entry for entry in log if (entry.get("source"), entry.get("filename")) != (source, filename)]
                log.append({"source": source, "filename": filename, "resolution": request.get("resolution", "edited")})
            elif self.path == "/api/complete":
                disagreement_frames = {
                    (item.get("source"), item.get("filename"))
                    for item in self._state()["comparison"]["disagreements"]
                    if item.get("source") and item.get("filename")
                }
                resolved = {(item.get("source"), item.get("filename")) for item in merged["review"].get("adjudication_log", [])}
                if not disagreement_frames <= resolved:
                    raise ValueError("resolve every disagreement frame before completion")
                merged["review"]["adjudication_status"] = "complete"
            else:
                self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)
                return
            self.server._save(merged)
            self._json({"saved": True})
        except (KeyError, OSError, ValueError, json.JSONDecodeError) as exc:
            self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the isolated adjudicator UI")
    parser.add_argument("sampling_root", type=Path)
    parser.add_argument("reviewer_a", type=Path)
    parser.add_argument("reviewer_b", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8767)
    args = parser.parse_args()
    server = AdjudicationServer((args.host, args.port), AdjudicationHandler, Path(__file__).with_name("adjudication-web"), args.reviewer_a, args.reviewer_b, args.output, args.sampling_root)
    print(f"Adjudicator C UI: http://{args.host}:{args.port}/")
    server.serve_forever()


if __name__ == "__main__":
    main()
